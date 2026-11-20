# Changelog

## 1.2.0-beta.1

Beta for testing; install it explicitly (`homebridge-whisker-ting@beta`). Normal updates stay on 1.1.0.

### Added

- Optional Critical Alerts: new settings `fireAlertAsSmokeSensor`, `utilityFireAlertAsSmokeSensor` and `powerQualityAlertAsSmokeSensor` expose those alerts as HomeKit smoke sensors instead of contact sensors, so iPhone can deliver them as Critical Alerts that sound in Silent and Focus modes. All default to off, so existing setups are unchanged. Turning one on (or off) replaces that sensor in Apple Home; re-add it to automations and scenes.
- Alerts are now logged at normal log levels: a warning (with Ting's message when it has one) when any alert becomes active, including one already active at startup, and an info line when it clears. Learning mode changes are logged at info level. Device serial numbers are not included.
- Anonymous telemetry also sends Whisker's alert status names for the electrical and utility fire alerts (for example `Active` or `ReviewedNotFire`), restricted to a short plain word; anything else is sent as `other`. This shows whether a long-lasting alert is really still active.
- Tests for the HomeKit side (`test/platform.test.js`): sensor types and values for every alert, read and pushed values, the smoke-sensor options including switching a cached accessory between types, offline/fault handling, alert logging, and multiple devices.

### Changed

- The four alert sensors are defined once in a shared table instead of being set up separately for HomeKit reads and updates.

## 1.1.0

First stable release. Adds multi-device support and hardens authentication, polling, and telemetry.

### Added

- Support all Ting devices returned by the account API instead of only the first device.
- Create stable per-device accessories using the Ting serial number, with site/device-based names for multi-device accounts.
- Retry initial discovery and subsequent polls with exponential backoff and jitter instead of stopping after a startup failure.
- Add request timeouts, poll overlap protection, and safer removal of cached accessories after repeated confirmed absence.
- Add a configurable authentication timeout (`authTimeoutSeconds`) to the Homebridge settings schema.

### Fixed

- Start with connectivity offline until the first successful API response is received.
- Retain cached accessories when a successful API response temporarily omits a device, marking them offline instead of unregistering them.
- Recognize pre-1.1 cached accessories whose UUID included the site ID, avoiding unnecessary accessory loss during the transition.
- Prevent concurrent credential loads or authentication attempts from racing and overwriting cached credentials.
- Add bounded timeouts for Cognito authentication and token refresh operations.
- Write the persisted Cognito state atomically and enforce mode `0600` on the credential file.
- Normalize Bluetooth MAC addresses using the same byte-order correction as Wi-Fi MAC addresses.
- Include an anonymous per-device slot in telemetry deduplication so identical multi-device states are not suppressed.
- Reduce log noise by reporting cached accessory restoration only once during startup instead of on every poll.

### Telemetry backend (Cloudflare Worker + D1)

Server-side only, no plugin or client change.

- Aggregate heartbeats on write (per-install row plus per-day presence/status rows) instead of appending a row per 15-minute ping, so D1 read/write usage stays flat as history grows. The latest Ting status is kept per install and the legacy `events` table is no longer written to.
- Stop dashboard queries from scanning the full event history (bounded to recent windows) and cache `/api/summary` at the edge; the dashboard auto-refreshes every 5 minutes instead of 60 seconds. Fixes the D1 free-tier read limit hit on 2026-09-01.
- Add `migration-rollup.sql`, a one-time backfill that populates the rollup tables from the legacy `events` log.

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

