# Homebridge Whisker Ting Anonymous Telemetry

This Cloudflare Worker receives optional Homebridge Whisker Ting usage events and
stores them in D1.

The plugin only sends anonymous, aggregate-safe data:

- random install ID
- plugin version
- Node.js version
- platform and CPU architecture
- Homebridge version, when available
- event type
- coarse Ting status flags

It must not send Whisker usernames, passwords, API keys, user IDs, site IDs,
serial numbers, device names, site names, addresses, MAC addresses, or raw API
payloads.

The dashboard uses these events:

- `plugin_install`: sent once per anonymous install ID.
- `plugin_start`: sent when the plugin starts after a successful Whisker status
  read.
- `plugin_ping`: sent every five minutes while the plugin is running; used for
  the live-running dashboard count.
- `status_update`: sent when the coarse Ting status changes, or at most once per
  day when status is unchanged.

## Deploy

1. Install Wrangler.

```bash
npm install -g wrangler
```

2. Create the D1 database.

```bash
wrangler d1 create whisker_ting_telemetry
```

3. Copy `wrangler.toml.example` to `wrangler.toml` and set the D1 `database_id`.

4. Create the schema.

```bash
wrangler d1 execute whisker_ting_telemetry --file=./schema.sql
```

5. Set a dashboard token.

```bash
wrangler secret put DASHBOARD_TOKEN
```

6. Deploy.

```bash
wrangler deploy
```

7. Set `telemetryEnabled` to `true` and `telemetryEndpointUrl` to the deployed
   `/events` URL in the Homebridge plugin config.

## Dashboard

Open:

```text
https://your-worker.workers.dev/dashboard?token=YOUR_DASHBOARD_TOKEN
```

The dashboard is also available at `/` with the same token. It reads only
aggregate counts from `/api/summary`.
