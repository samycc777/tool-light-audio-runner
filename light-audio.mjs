// Makes a light copy (Opus 24 kbps mono, WebM) of every heavy recording in R2, so a lesson
// costs listeners on slow, costly connections half the data or less. The original stays where
// it is (the download button and the podcast feed keep it); the light copy sits beside it as
// media/<id>/<name>.light.weba and the pages play it first when the browser can.
//
//   node --env-file=.env.local scripts/light-audio.mjs            new recordings (daily update)
//   ... --again                                                   make copies anew even where one exists
//   node scripts/light-audio.mjs --print-list > list.txt          the keys still to look at
//   node scripts/light-audio.mjs --list list.txt --shard 1/4 --out out.json   on a GitHub runner
//   node scripts/light-audio.mjs --merge out1.json out2.json      results into data/light-audio.json
//
// data/light-audio.json: { "<original key>": { key, size } } for a light copy, { skip: "<why>" }
// for a recording that is already light (or where the copy would save too little).
// Needs ffmpeg + ffprobe and R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.
// This file also runs alone on the runner (no repo around it): keep it free of local imports.
import { createReadStream, createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const DATA = "data/light-audio.json";
const BITRATE = 24; // kbps of the light copy
const HEAVY = 40; // kbps: recordings at or under this are left alone
const WORTH = 0.7; // a copy over 70% of the original's size isn't kept
const PARALLEL = 3;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback);
const lightKey = (key) => key.replace(/\.[^./]+$/, "") + ".light.weba";

// Recordings whose metadata says they are heavy, or doesn't say (no duration): the ones to look at.
function candidates() {
  const done = readJson(DATA, {});
  const keys = [];
  for (const post of JSON.parse(readFileSync("src/data/posts.json", "utf8")).posts) {
    for (const m of post.media) {
      if ((m.type !== "audio" && m.type !== "voice") || !m.r2Key || done[m.r2Key]) continue;
      const seconds = Number(m.duration);
      const kbps = seconds > 0 && seconds < 30000 && m.size ? (m.size * 8) / seconds / 1000 : null;
      if (kbps == null || kbps > HEAVY) keys.push(m.r2Key);
    }
  }
  return [...new Set(keys)];
}

if (flag("--print-list")) {
  console.log(candidates().join("\n"));
  process.exit(0);
}

if (flag("--merge")) {
  const all = readJson(DATA, {});
  for (const file of args.slice(args.indexOf("--merge") + 1)) Object.assign(all, JSON.parse(readFileSync(file, "utf8")));
  write(DATA, all);
  const light = Object.values(all).filter((v) => v.key);
  console.log(`light-audio: ${light.length} light copies, ${Object.keys(all).length - light.length} left as they are`);
  process.exit(0);
}

let keys = value("--list") ? readFileSync(value("--list"), "utf8").split("\n").filter(Boolean) : candidates();
if (value("--shard")) {
  const [i, n] = value("--shard").split("/").map(Number);
  keys = keys.filter((_, index) => index % n === i - 1);
}
if (value("--max")) keys = keys.slice(0, Number(value("--max")));
const OUT = value("--out") ?? DATA;
const results = readJson(OUT, {});
keys = keys.filter((key) => !results[key]);
if (!keys.length) { console.log("light-audio: nothing to do"); process.exit(0); }

const missing = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"].filter((name) => !process.env[name]);
if (missing.length) { console.error(`light-audio: missing ${missing.join(", ")}`); process.exit(1); }
const { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } = await import("@aws-sdk/client-s3");
const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});
const Bucket = process.env.R2_BUCKET;

async function head(Key) {
  try { return await r2.send(new HeadObjectCommand({ Bucket, Key })); }
  catch (error) { if (error.$metadata?.httpStatusCode === 404 || error.name === "NotFound") return null; throw error; }
}

async function one(key, dir) {
  const target = lightKey(key);
  const already = flag("--again") ? null : await head(target);
  if (already) return { key: target, size: already.ContentLength };

  const source = join(dir, "in");
  const out = join(dir, "out.webm");
  const object = await r2.send(new GetObjectCommand({ Bucket, Key: key }));
  await pipeline(object.Body, createWriteStream(source));

  const probe = JSON.parse((await run("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "format=duration:stream=codec_name", "-of", "json", source])).stdout);
  const seconds = Number(probe.format?.duration);
  if (!probe.streams?.length || !(seconds > 0)) return { skip: "not readable as audio" };
  const size = statSync(source).size;
  const kbps = (size * 8) / seconds / 1000;
  if (kbps <= HEAVY) return { skip: `already ${Math.round(kbps)} kbps` };

  // Room for the seek index at the front, so a player can jump without first asking for the file's end.
  const index = Math.max(50_000, Math.ceil(seconds * 30));
  await run("ffmpeg", ["-v", "error", "-y", "-i", source, "-map", "0:a:0", "-vn", "-ac", "1", "-c:a", "libopus", "-b:a", `${BITRATE}k`,
    "-vbr", "constrained", "-application", "voip", "-map_metadata", "-1", "-reserve_index_space", String(index), "-f", "webm", out], { maxBuffer: 1 << 24 });
  const made = statSync(out).size;
  const lasts = Number(JSON.parse((await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", out])).stdout).format?.duration);
  // A file whose own length is wrong gives the same result every time: recorded, so it isn't fetched again each day.
  if (!(Math.abs(lasts - seconds) < Math.max(3, seconds * 0.01))) return { skip: `copy lasts ${Math.round(lasts)} s, the original says ${Math.round(seconds)} s` };
  if (made > size * WORTH) return { skip: `copy saves too little (${Math.round(kbps)} kbps)` };

  await r2.send(new PutObjectCommand({
    Bucket, Key: target, Body: createReadStream(out), ContentLength: made,
    ContentType: "audio/webm", CacheControl: "public, max-age=31536000, immutable",
  }));
  return { key: target, size: made, from: size };
}

function write(file, data) {
  writeFileSync(file, JSON.stringify(Object.fromEntries(Object.entries(data).sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))), null, 1) + "\n");
}

let failed = 0;
let next = 0;
await Promise.all(Array.from({ length: PARALLEL }, async () => {
  while (next < keys.length) {
    const key = keys[next++];
    const dir = mkdtempSync(join(tmpdir(), "light-"));
    try {
      const result = await one(key, dir);
      results[key] = result.key ? { key: result.key, size: result.size } : result;
      console.log(`${key}: ${result.key ? `${result.from ? Math.round(result.from / 1e5) / 10 : "?"} → ${Math.round(result.size / 1e5) / 10} MB` : result.skip}`);
      write(OUT, results);
    } catch (error) {
      failed++;
      console.log(`${key}: FAILED ${String(error.message).slice(0, 300)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}));
console.log(`light-audio: ${keys.length - failed} done, ${failed} failed`);
process.exit(failed && !Object.keys(results).length ? 1 : 0);
