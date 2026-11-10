# tool-light-audio-runner

Runs a site's `scripts/light-audio.mjs` on GitHub's free machines (public repo = free minutes; the audio never passes through the home internet): each heavy recording in the site's R2 bucket gets a light copy (Opus 24 kbps) beside it.

- `light-audio.mjs`: copy of `~/dev/archive-shaykh-ali-hudhaify/scripts/light-audio.mjs` (edit it there, copy it here).
- `lists/<site>.txt`: the R2 keys to look at (`node scripts/light-audio.mjs --print-list` in the site's folder).
- `.github/workflows/light.yml`: 4 jobs, each a quarter of the list. Secrets `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` name one site's bucket: set them before a run (from the site's `.env.local`, never printed) and delete them after it (`gh secret delete`).

## Run
1. Fresh list and script into this folder, commit, push.
2. `gh workflow run light.yml -f list=lists/<site>.txt`, then `gh run watch`.
3. `gh run download <run id> -D <scratch folder>`, then in the site's worktree: `node scripts/light-audio.mjs --merge <the out-*.json files>`, commit `data/light-audio.json`, deploy.

## Conventions
- Public repo: nothing but the script, the workflow and key lists (`media/<id>/<file>`); never credentials, titles or site data.
