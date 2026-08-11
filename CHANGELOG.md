# Changelog

## 1.0.17

### Version optimization

- **Cognito session persistence:** store access/refresh tokens under Homebridge storage and refresh before JWT expiry so restarts avoid a full password login.
- **Launch config validation:** fail fast with a clear error when Whisker email/password are missing or the email looks invalid.
- **Telemetry ping rate cut:** heartbeat interval 5m → **15m**, with client-side dedupe (~14m) to reduce D1 write volume.
- Cloudflare Worker: dedupe rapid `plugin_ping` writes server-side; purge `plugin_ping` rows older than **30 days** (cron every 6h + opportunistic cleanup).

## 1.0.16

- Skip overlapping polls when a previous API request is still in flight.
- Refresh Cognito credentials about 60 seconds before JWT expiry (not only after 401).
- Mark Ting sensors offline via HomeKit `StatusActive` / `StatusFault` after consecutive poll failures; recover when the API responds again.
- Use `StatusFault` only for API connectivity, not for active hazard states (hazard remains on smoke/contact characteristics).

## 1.0.15

- Normalize Ting Wi-Fi MAC addresses before storing them in Homebridge status data.

