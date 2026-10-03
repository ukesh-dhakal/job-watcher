# job-watcher

Checks career pages every hour and sends new matching jobs to Discord.

## Setup (once)
1. Push this folder to a GitHub repo (keep `.github/workflows/jobs.yml` in place).
2. Repo Settings > Secrets and variables > Actions > add secret `DISCORD_WEBHOOK_URL`.
3. Repo Settings > Actions > General > Workflow permissions > Read and write.
4. Actions tab > job-watcher > Run workflow (to test).

## Add a new career page
Open `companies.json`, add one line per company, and commit. Each company
can have its own URL. Either a plain URL or a name + url:

```json
[
  "https://companyone.com/careers",
  { "name": "Company Two", "url": "https://another-site.com.np/vacancies" },
  "https://boards.greenhouse.io/somecompany"
]
```

Keep a comma after every entry except the last. Greenhouse and Lever links are
detected automatically. Delete an entry to stop watching that company.

## Change which roles you get
Edit `"include"` (title must contain one of these words) and `"exclude"`
(title must not contain any of these) in `config.json`.

## Notes
- `seen.json` is created automatically and remembers jobs already sent.
- If a page loads jobs with JavaScript, the `html` type may find nothing.
  Check the Actions run log: it prints how many links each source returned.
