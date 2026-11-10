# Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Dashboard says "Worker offline" | Worker not running or not heartbeating for 60 s. `docker compose ps`, `docker compose logs worker`. |
| "Authentication failed" state | WhatsApp rejected the saved session. Stop the worker, delete `/data/wa-session` in the volume, start it, re-scan the QR. The worker does not retry auth failures on its own. |
| Worker exits after repeated failures | Reconnect budget (10) exhausted; fix the network, then restart it. See Connection history. |
| Chromium fails to launch in the worker | Check `CHROMIUM_PATH`, container `shm_size`, memory. |
| Login says "Too many requests" | Per-IP limit (10 per 15 min). Wait, or restart the API in development. |
| Login works but pages 401 / CSRF errors | `COOKIE_SECURE=true` over plain HTTP, or a proxy changing `Origin`/`Host`. Use HTTPS. |
| Everyone shares one rate limit | `TRUST_PROXY=true` missing behind Nginx (or set while not behind a proxy: do not). |
| Events show "Skipped: could not verify admin status" | Expected fail-closed behaviour: participant metadata was unavailable or the sender id format did not match. Nothing was done. Report it with the id format seen. |
| Nothing is deleted | Test mode is on (the striped band at the top), the group is disabled, or the bot is not a group admin. |
