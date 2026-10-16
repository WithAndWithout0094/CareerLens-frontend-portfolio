# Personal Render trial

Use `blueprints/personal-free.yaml` in your **personal** Render workspace. It creates one free Singapore web service and one free PostgreSQL 17 database. Automatic deployment is off, and the database allows only private-network connections. This file does not change the shared team3 resources.

The Blueprint must be published to a Git branch Render can access before deployment. This preparation does not publish code or assume write access to the original repository. Use the same branch for the Blueprint and application.

Set `OPENAI_API_KEY` privately in Render. Render generates `JWT_SECRET_KEY` and supplies the internal `DATABASE_URL`. Set `CORS_ORIGINS` and `FRONTEND_PUBLIC_ORIGIN` to the actual HTTPS service URL. Python 3.13 is selected by the repository `.python-version`. Do not set `BACKEND_URL` or create a separate frontend/worker.

The explicit start command first runs `python -m scripts.bootstrap_personal_render`, then starts Uvicorn. The bootstrap holds a PostgreSQL advisory lock, initializes **only an empty public schema**, sets up the private LangGraph checkpoints, and imports 100 bundled demo job postings. It records the SQL fingerprint only after every step succeeds. Subsequent starts with that fingerprint and all expected tables skip setup and preserve data.

Any non-empty database without the matching completion marker is refused. A partial initialization also stops for manual investigation; it is never automatically overwritten or repaired. This command is not a general migration mechanism and must not be pointed at the team database. Normal `uvicorn app.main:app` startup remains unchanged. No real user records or local private reports are copied.

Check `/healthz` for process health, `/health` for database connectivity, and `/` for the frontend. Model analysis requires a usable OpenAI key and is billed separately from Render.

Free web services sleep after 15 minutes without traffic and can lose local unclaimed guest reports and Markdown execution files when the instance filesystem is replaced. Native member reports and successfully claimed guest reports remain in PostgreSQL (`002_member_guest_reports.sql` adds the latter archive). Existing lost SQLite files cannot be recovered by this migration. The free database expires after 30 days and has no managed backups. This setup is for a trial; free hosting does not include OpenAI API usage. See [Render free limits](https://render.com/docs/free) and [report retention](report-retention.md).
