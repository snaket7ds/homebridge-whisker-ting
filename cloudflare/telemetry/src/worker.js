const ALLOWED_EVENTS = new Set(['plugin_install', 'plugin_start', 'plugin_ping', 'status_update']);
// Drop high-volume heartbeats older than this (keep install/start/status longer).
const PING_RETENTION_DAYS = 30;
// Serve cached /api/summary responses so dashboard auto-refresh / tab-focus
// reloads don't rescan D1 on every request. 120s keeps "Online Now" fresh
// (heartbeats arrive every 15 min anyway).
const SUMMARY_CACHE_TTL_SECONDS = 120;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/events') {
      return recordEvent(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/summary') {
      if (!isAuthorized(request, env, url)) {
        return json({ error: 'unauthorized' }, 401);
      }

      // Serve summary from the edge cache when possible so the dashboard's
      // auto-refresh and tab-focus reloads don't re-scan D1 every time.
      const cached = await readCachedSummary(request);
      if (cached) {
        return cached;
      }

      const response = json(await buildSummary(env), 200, {
        'cache-control': `private, max-age=${SUMMARY_CACHE_TTL_SECONDS}`,
      });
      await writeCachedSummary(request, response);
      return response;
    }

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) {
      if (!isAuthorized(request, env, url)) {
        return new Response('Unauthorized', { status: 401 });
      }

      return new Response(renderDashboard(), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store, no-cache, must-revalidate',
          pragma: 'no-cache',
        },
      });
    }

    return new Response('Not found', { status: 404 });
  },

  // Cron: purge old plugin_ping rows (see wrangler.toml triggers.crons).
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(purgeOldPings(env));
  },
};

async function recordEvent(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const eventType = stringValue(payload.eventType, 64);
  const installId = stringValue(payload.installId, 80);
  const pluginVersion = stringValue(payload.pluginVersion, 32);
  const nodeVersion = stringValue(payload.nodeVersion, 32);
  const platform = stringValue(payload.platform, 32);
  const arch = stringValue(payload.arch, 32);
  const homebridgeVersion = stringValue(payload.homebridgeVersion, 32);
  const data = payload.data && typeof payload.data === 'object' ? payload.data : {};

  if (!ALLOWED_EVENTS.has(eventType) || !installId || !pluginVersion) {
    return json({ error: 'invalid_event' }, 400);
  }

  if (installId === 'probe' || installId.length < 8) {
    return json({ error: 'invalid_event' }, 400);
  }

  // Rollup-on-write (2026-09): heartbeats no longer append rows to `events`.
  // Each event upserts one row in `installs` (per install, with current version
  // info and counters) and one tiny row in `presence_days` (per install per UTC
  // day). `status_update` also updates the latest-status snapshot on the install
  // row and rolls into `status_days`. Dashboard summaries then read a few
  // hundred rows instead of the whole heartbeat log, keeping D1 free-tier usage
  // flat regardless of ping volume.
  const nowIso = new Date().toISOString();
  const day = nowIso.slice(0, 10);
  const stmts = [];

  if (eventType === 'plugin_install') {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO installs (install_id, first_seen, last_seen, last_start, plugin_version, node_version, platform, arch, homebridge_version, starts, pings, status_updates)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, 0, 0)
         ON CONFLICT(install_id) DO UPDATE SET
           last_seen = excluded.last_seen,
           plugin_version = excluded.plugin_version,
           node_version = excluded.node_version,
           platform = excluded.platform,
           arch = excluded.arch,
           homebridge_version = excluded.homebridge_version`
      ).bind(installId, nowIso, nowIso, pluginVersion, nodeVersion, platform, arch, homebridgeVersion)
    );
  } else if (eventType === 'plugin_start') {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO installs (install_id, first_seen, last_seen, last_start, plugin_version, node_version, platform, arch, homebridge_version, starts, pings, status_updates)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0)
         ON CONFLICT(install_id) DO UPDATE SET
           last_seen = excluded.last_seen,
           last_start = excluded.last_start,
           plugin_version = excluded.plugin_version,
           node_version = excluded.node_version,
           platform = excluded.platform,
           arch = excluded.arch,
           homebridge_version = excluded.homebridge_version,
           starts = starts + 1`
      ).bind(installId, nowIso, nowIso, nowIso, pluginVersion, nodeVersion, platform, arch, homebridgeVersion)
    );
  } else if (eventType === 'plugin_ping') {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO installs (install_id, first_seen, last_seen, last_start, plugin_version, node_version, platform, arch, homebridge_version, starts, pings, status_updates)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, 1, 0)
         ON CONFLICT(install_id) DO UPDATE SET
           last_seen = excluded.last_seen,
           plugin_version = excluded.plugin_version,
           node_version = excluded.node_version,
           platform = excluded.platform,
           arch = excluded.arch,
           homebridge_version = excluded.homebridge_version,
           pings = pings + 1`
      ).bind(installId, nowIso, nowIso, pluginVersion, nodeVersion, platform, arch, homebridgeVersion)
    );
  } else if (eventType === 'status_update') {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO installs (install_id, first_seen, last_seen, last_start, plugin_version, node_version, platform, arch, homebridge_version, starts, pings, status_updates, hazard_status, fire_hazard, electrical_fire_hazard, utility_fire_hazard, power_quality_hazard, learning_mode, efh_level, ufh_level, last_status_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 0, 0, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(install_id) DO UPDATE SET
           last_seen = excluded.last_seen,
           plugin_version = excluded.plugin_version,
           node_version = excluded.node_version,
           platform = excluded.platform,
           arch = excluded.arch,
           homebridge_version = excluded.homebridge_version,
           status_updates = status_updates + 1,
           hazard_status = excluded.hazard_status,
           fire_hazard = excluded.fire_hazard,
           electrical_fire_hazard = excluded.electrical_fire_hazard,
           utility_fire_hazard = excluded.utility_fire_hazard,
           power_quality_hazard = excluded.power_quality_hazard,
           learning_mode = excluded.learning_mode,
           efh_level = excluded.efh_level,
           ufh_level = excluded.ufh_level,
           last_status_at = excluded.last_status_at`
      ).bind(
        installId, nowIso, nowIso, pluginVersion, nodeVersion, platform, arch, homebridgeVersion,
        stringValue(data.hazard_status, 64),
        booleanValue(data.fire_hazard),
        booleanValue(data.electrical_fire_hazard),
        booleanValue(data.utility_fire_hazard),
        booleanValue(data.power_quality_hazard),
        booleanValue(data.learning_mode),
        nullableNumberValue(data.efh_level),
        nullableNumberValue(data.ufh_level),
        nowIso
      ),
      env.DB.prepare(
        `INSERT INTO status_days (install_id, day, hazard_status, fire_hazard, electrical_fire_hazard, utility_fire_hazard, power_quality_hazard, learning_mode, efh_level, ufh_level, reports)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(install_id, day, hazard_status) DO UPDATE SET
           fire_hazard = fire_hazard + excluded.fire_hazard,
           electrical_fire_hazard = electrical_fire_hazard + excluded.electrical_fire_hazard,
           utility_fire_hazard = utility_fire_hazard + excluded.utility_fire_hazard,
           power_quality_hazard = power_quality_hazard + excluded.power_quality_hazard,
           learning_mode = learning_mode + excluded.learning_mode,
           efh_level = excluded.efh_level,
           ufh_level = excluded.ufh_level,
           reports = reports + 1`
      ).bind(
        installId,
        day,
        stringValue(data.hazard_status, 64),
        booleanValue(data.fire_hazard),
        booleanValue(data.electrical_fire_hazard),
        booleanValue(data.utility_fire_hazard),
        booleanValue(data.power_quality_hazard),
        booleanValue(data.learning_mode),
        nullableNumberValue(data.efh_level),
        nullableNumberValue(data.ufh_level)
      )
    );
  }

  // One tiny row per install per UTC day proves it ran that day (daily chart).
  stmts.push(
    env.DB.prepare(
      `INSERT OR IGNORE INTO presence_days (install_id, day) VALUES (?, ?)`
    ).bind(installId, day)
  );

  await env.DB.batch(stmts);

  // Opportunistic cleanup so retention runs even without waiting for cron.
  if (eventType === 'plugin_ping' && Math.random() < 0.02) {
    try {
      await purgeOldPings(env);
    } catch {
      // best-effort
    }
  }

  return json({ ok: true });
}

async function purgeOldPings(env) {
  const cutoff = new Date(Date.now() - PING_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  // Batch deletes to stay within D1 statement limits.
  let total = 0;
  for (let i = 0; i < 20; i++) {
    const result = await env.DB.prepare(
      `DELETE FROM events
       WHERE id IN (
         SELECT id FROM events
         WHERE event_type = 'plugin_ping' AND received_at < ?
         LIMIT 5000
       )`,
    )
      .bind(cutoff)
      .run();
    const changes = result?.meta?.changes ?? result?.changes ?? 0;
    total += changes;
    if (changes < 5000) {
      break;
    }
  }
  return { deleted: total, cutoff };
}

async function buildSummary(env) {
  const sinceLive = isoMinutesAgo(10);
  const since1Day = isoHoursAgo(24);
  const since7Days = isoHoursAgo(24 * 7);
  const since30Days = isoHoursAgo(24 * 30);
  const rosterRetentionDays = 7;
  const sinceRoster = isoHoursAgo(24 * rosterRetentionDays);

  const since30DaysDay = since30Days.slice(0, 10); // date-only compare for day columns

  const [
    totalInstalls,
    liveRunning,
    running1,
    running7,
    running30,
    launches1,
    launches7,
    launches30,
    versions,
    platforms,
    arches,
    nodeVersions,
    homebridgeVersions,
    statusCounts,
    hazardFlags,
    currentHazards,
    levelStats,
    daily,
    installRoster,
  ] = await Promise.all([
    countInstallsSeen(env, sinceRoster),
    countInstallsSeen(env, sinceLive),
    countInstallsSeen(env, since1Day),
    countInstallsSeen(env, since7Days),
    countInstallsSeen(env, since30Days),
    countLaunches(env, since1Day),
    countLaunches(env, since7Days),
    countLaunches(env, since30Days),
    countField(env, 'plugin_version', since30Days),
    countField(env, 'platform', since30Days),
    countField(env, 'arch', since30Days),
    countField(env, 'node_version', since30Days),
    countField(env, 'homebridge_version', since30Days),
    all(
      env,
      `SELECT hazard_status, SUM(reports) AS reports
       FROM status_days
       WHERE day >= ? AND hazard_status <> ''
       GROUP BY hazard_status
       ORDER BY reports DESC, hazard_status ASC`,
      since30DaysDay,
    ),
    // Aggregate flag hits from status updates in last 30 days (weighted by reports)
    first(
      env,
      `SELECT
         COALESCE(SUM(fire_hazard * reports), 0) AS fire_hazard,
         COALESCE(SUM(electrical_fire_hazard * reports), 0) AS electrical_fire_hazard,
         COALESCE(SUM(utility_fire_hazard * reports), 0) AS utility_fire_hazard,
         COALESCE(SUM(power_quality_hazard * reports), 0) AS power_quality_hazard,
         COALESCE(SUM(learning_mode * reports), 0) AS learning_mode,
         COALESCE(SUM(reports), 0) AS status_reports
       FROM status_days
       WHERE day >= ?`,
      since30DaysDay,
    ),
    // Latest status snapshot per install (stored on the installs row by ingest)
    first(
      env,
      `SELECT
         COALESCE(SUM(CASE WHEN hazard_status NOT IN ('', 'normal', 'clear', 'ok', 'none')
           AND hazard_status NOT LIKE '%normal%'
           AND learning_mode = 0 THEN 1 ELSE 0 END), 0) AS installs_with_hazard,
         COALESCE(SUM(CASE WHEN learning_mode = 1 THEN 1 ELSE 0 END), 0) AS installs_learning,
         COALESCE(SUM(CASE WHEN fire_hazard = 1 THEN 1 ELSE 0 END), 0) AS installs_fire,
         COALESCE(SUM(CASE WHEN electrical_fire_hazard = 1 THEN 1 ELSE 0 END), 0) AS installs_efh,
         COALESCE(SUM(CASE WHEN utility_fire_hazard = 1 THEN 1 ELSE 0 END), 0) AS installs_ufh,
         COALESCE(SUM(CASE WHEN power_quality_hazard = 1 THEN 1 ELSE 0 END), 0) AS installs_pq,
         COUNT(*) AS installs_with_status
       FROM installs
       WHERE last_seen >= ? AND hazard_status != ''`,
      since30Days,
    ),
    first(
      env,
      `SELECT
         COUNT(CASE WHEN efh_level IS NOT NULL THEN 1 END) AS efh_samples,
         ROUND(AVG(CASE WHEN efh_level IS NOT NULL THEN efh_level END), 1) AS efh_avg,
         MAX(efh_level) AS efh_max,
         COUNT(CASE WHEN ufh_level IS NOT NULL THEN 1 END) AS ufh_samples,
         ROUND(AVG(CASE WHEN ufh_level IS NOT NULL THEN ufh_level END), 1) AS ufh_avg,
         MAX(ufh_level) AS ufh_max
       FROM status_days
       WHERE day >= ?`,
      since30DaysDay,
    ),
    all(
      env,
      `SELECT day, COUNT(*) AS running_plugins
       FROM presence_days
       WHERE day >= ?
       GROUP BY day
       ORDER BY day ASC`,
      since30DaysDay,
    ),
    all(
      env,
      `SELECT
         substr(install_id, 1, 8) AS install_short,
         plugin_version,
         platform,
         arch,
         node_version,
         homebridge_version,
         first_seen,
         last_seen,
         starts,
         pings,
         status_updates,
         hazard_status,
         fire_hazard,
         electrical_fire_hazard,
         utility_fire_hazard,
         power_quality_hazard,
         learning_mode,
         efh_level,
         ufh_level
       FROM installs
       WHERE last_seen >= ?
       ORDER BY last_seen DESC
       LIMIT 50`,
      sinceRoster,
    ),
  ]);

  const now = Date.now();
  const maxRosterAgeMin = rosterRetentionDays * 24 * 60;
  const installs = installRoster
    .map((row) => {
      const lastMs = Date.parse(row.last_seen);
      const ageMin = Number.isFinite(lastMs) ? Math.max(0, (now - lastMs) / 60000) : null;
      let status = 'idle';
      if (ageMin != null && ageMin <= 10) status = 'online';
      else if (ageMin != null && ageMin <= 60 * 24) status = 'recent';
      return {
        ...row,
        status,
        age_minutes: ageMin == null ? null : Math.round(ageMin),
      };
    })
    .filter((row) => row.age_minutes == null || row.age_minutes <= maxRosterAgeMin);

  return {
    generatedAt: new Date().toISOString(),
    totalInstalls,
    runningPlugins: {
      live: liveRunning,
      oneDay: running1,
      sevenDays: running7,
      thirtyDays: running30,
    },
    launches: {
      oneDay: launches1,
      sevenDays: launches7,
      thirtyDays: launches30,
    },
    versions,
    platforms,
    arches,
    nodeVersions,
    homebridgeVersions,
    statusCounts,
    hazardFlags30d: {
      fire_hazard: hazardFlags?.fire_hazard ?? 0,
      electrical_fire_hazard: hazardFlags?.electrical_fire_hazard ?? 0,
      utility_fire_hazard: hazardFlags?.utility_fire_hazard ?? 0,
      power_quality_hazard: hazardFlags?.power_quality_hazard ?? 0,
      learning_mode: hazardFlags?.learning_mode ?? 0,
      status_reports: hazardFlags?.status_reports ?? 0,
    },
    currentHazards: {
      installs_with_status: currentHazards?.installs_with_status ?? 0,
      installs_with_hazard: currentHazards?.installs_with_hazard ?? 0,
      installs_learning: currentHazards?.installs_learning ?? 0,
      installs_fire: currentHazards?.installs_fire ?? 0,
      installs_efh: currentHazards?.installs_efh ?? 0,
      installs_ufh: currentHazards?.installs_ufh ?? 0,
      installs_pq: currentHazards?.installs_pq ?? 0,
    },
    levels30d: {
      efh_samples: levelStats?.efh_samples ?? 0,
      efh_avg: levelStats?.efh_avg ?? null,
      efh_max: levelStats?.efh_max ?? null,
      ufh_samples: levelStats?.ufh_samples ?? 0,
      ufh_avg: levelStats?.ufh_avg ?? null,
      ufh_max: levelStats?.ufh_max ?? null,
    },
    daily: fillDailySeries(daily, 30),
    installs,
    retentionDays: rosterRetentionDays,
  };
}

function countField(env, field, since) {
  // field is a trusted identifier from our code only
  return all(
    env,
    `SELECT ${field} AS value, COUNT(*) AS installs
     FROM installs
     WHERE last_seen >= ? AND ${field} != ''
     GROUP BY ${field}
     ORDER BY installs DESC, value ASC`,
    since,
  );
}

function countInstallsSeen(env, since) {
  return scalar(
    env,
    `SELECT COUNT(*) AS value FROM installs WHERE last_seen >= ?`,
    since,
  );
}

function countLaunches(env, since) {
  return scalar(
    env,
    `SELECT COUNT(*) AS value FROM installs WHERE last_start IS NOT NULL AND last_start >= ?`,
    since,
  );
}

function fillDailySeries(rows, days) {
  const byDay = new Map(rows.map((r) => [r.day, r.running_plugins]));
  const result = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const key = d.toISOString().slice(0, 10);
    result.push({ day: key, running_plugins: byDay.get(key) ?? 0 });
  }
  return result;
}

function renderDashboard() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Whisker Ting \u2014 Telemetry</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    :root {
      --bg: #f4f6f5;
      --surface: #ffffff;
      --surface-raised: #eef1ef;
      --border: #d9e0dc;
      --text: #15201a;
      --text-secondary: #5c6b63;
      --accent: #0f9f4f;
      --accent-muted: #8fd4ab;
      --accent-soft: #e6f7ed;
      --success: #0f9f4f;
      --warning: #d97706;
      --danger: #dc2626;
      --info: #2563eb;
      --radius: 12px;
      --shadow: 0 1px 2px rgba(21, 32, 26, 0.04), 0 8px 24px rgba(21, 32, 26, 0.04);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f1411;
        --surface: #171d19;
        --surface-raised: #1f2722;
        --border: #2a342e;
        --text: #e8eee9;
        --text-secondary: #93a399;
        --accent: #34d399;
        --accent-muted: #065f46;
        --accent-soft: #0f2a1c;
        --success: #34d399;
        --warning: #fbbf24;
        --danger: #f87171;
        --info: #60a5fa;
        --shadow: 0 1px 2px rgba(0,0,0,0.25), 0 8px 24px rgba(0,0,0,0.2);
      }
    }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    header {
      background: linear-gradient(160deg, #0f1a14 0%, #152820 55%, #0f9f4f22 100%);
      border-bottom: 1px solid var(--border);
      padding: 28px 28px 24px;
    }
    header .container {
      max-width: 1200px; margin: 0 auto;
      display: flex; justify-content: space-between; gap: 16px;
      align-items: flex-end; flex-wrap: wrap;
    }
    header h1 { margin: 0; font-size: 26px; font-weight: 700; letter-spacing: -0.3px; color: #fff; }
    header h1 .accent { color: #6ee7a8; }
    header .tagline { color: #a7b8ad; margin-top: 6px; font-size: 14px; }
    header .meta { color: #a7b8ad; font-size: 12px; text-align: right; }
    main { padding: 28px; max-width: 1200px; margin: 0 auto; }

    .metrics {
      display: grid;
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 14px;
      margin-bottom: 14px;
    }
    .metrics-secondary {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 14px;
      margin-bottom: 14px;
    }
    .metrics-tertiary {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 14px;
      margin-bottom: 28px;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 18px 18px 16px;
      box-shadow: var(--shadow);
      transition: border-color 0.15s ease;
    }
    .card:hover { border-color: var(--accent-muted); }
    .card .label {
      font-size: 11px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.55px; color: var(--text-secondary); margin-bottom: 8px;
    }
    .card .value {
      font-size: 32px; font-weight: 750; letter-spacing: -0.5px;
      color: var(--text); font-variant-numeric: tabular-nums;
    }
    .card .hint { font-size: 11px; color: var(--text-secondary); margin-top: 6px; }
    .card.live { border-color: color-mix(in srgb, var(--success) 35%, var(--border)); }
    .card.live .value { color: var(--success); }
    .card.live .label::before {
      content: ''; display: inline-block; width: 7px; height: 7px;
      border-radius: 50%; background: var(--success); margin-right: 6px;
      animation: pulse 2s infinite; vertical-align: 1px;
    }
    .card.warn .value { color: var(--warning); }
    .card.danger .value { color: var(--danger); }
    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--success) 45%, transparent); }
      70% { box-shadow: 0 0 0 8px transparent; }
      100% { box-shadow: 0 0 0 0 transparent; }
    }

    .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 28px; }
    .three-col { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; margin-bottom: 28px; }
    .section { margin-bottom: 28px; }
    .section-head {
      display: flex; align-items: baseline; justify-content: space-between;
      gap: 12px; margin: 0 0 12px;
    }
    .section h2 {
      font-size: 13px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.6px; color: var(--text-secondary); margin: 0;
    }
    .section .sub { font-size: 12px; color: var(--text-secondary); }
    .panel {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: var(--radius); box-shadow: var(--shadow); overflow: hidden;
    }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th {
      text-align: left; padding: 12px 16px; background: var(--surface-raised);
      color: var(--text-secondary); font-size: 11px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid var(--border);
    }
    td {
      padding: 11px 16px; border-bottom: 1px solid var(--border);
      color: var(--text); font-variant-numeric: tabular-nums;
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: color-mix(in srgb, var(--accent) 5%, transparent); }
    .empty-row td {
      color: var(--text-secondary); font-style: italic; text-align: center; padding: 28px 16px;
    }
    .version-latest { font-weight: 650; }
    .version-latest::after {
      content: 'latest'; font-size: 10px; font-weight: 700; text-transform: uppercase;
      letter-spacing: 0.4px; color: var(--accent); background: var(--accent-soft);
      padding: 2px 7px; border-radius: 999px; margin-left: 8px; vertical-align: 1px;
    }
    .status-pill {
      display: inline-block; padding: 2px 8px; border-radius: 999px;
      font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.3px;
    }
    .status-online { background: var(--accent-soft); color: var(--success); }
    .status-recent { background: color-mix(in srgb, var(--info) 15%, transparent); color: var(--info); }
    .status-idle { background: var(--surface-raised); color: var(--text-secondary); }
    .pill-ok { background: var(--accent-soft); color: var(--success); }
    .pill-warn { background: color-mix(in srgb, var(--warning) 18%, transparent); color: var(--warning); }
    .pill-danger { background: color-mix(in srgb, var(--danger) 15%, transparent); color: var(--danger); }
    .pill-muted { background: var(--surface-raised); color: var(--text-secondary); }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
    .flag { font-size: 11px; margin-right: 4px; }
    .chart-wrap { padding: 16px 16px 8px; }
    .chart {
      display: grid; grid-template-columns: repeat(30, minmax(0, 1fr));
      gap: 3px; align-items: end; height: 120px;
    }
    .chart .bar {
      background: linear-gradient(180deg, var(--accent) 0%, color-mix(in srgb, var(--accent) 55%, #0b5c2e) 100%);
      border-radius: 3px 3px 1px 1px; min-height: 2px; opacity: 0.92;
    }
    .chart .bar.zero { background: var(--surface-raised); opacity: 1; height: 2px !important; }
    .chart-legend {
      display: flex; justify-content: space-between; color: var(--text-secondary);
      font-size: 11px; padding: 8px 2px 4px;
    }
    .chart-peak { font-size: 12px; color: var(--text-secondary); padding: 0 16px 14px; }
    .chart-peak strong { color: var(--text); }
    .error-banner {
      display: none; background: color-mix(in srgb, var(--danger) 12%, var(--surface));
      border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--border));
      color: var(--danger); border-radius: var(--radius); padding: 12px 16px;
      margin-bottom: 18px; font-size: 14px;
    }
    .error-banner.show { display: block; }
    footer {
      text-align: center; padding: 24px; color: var(--text-secondary);
      font-size: 12px; border-top: 1px solid var(--border); margin-top: 12px;
    }
    @media (max-width: 1100px) {
      .metrics, .metrics-secondary, .metrics-tertiary { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .three-col { grid-template-columns: 1fr 1fr; }
    }
    @media (max-width: 720px) {
      .metrics, .metrics-secondary, .metrics-tertiary, .two-col, .three-col { grid-template-columns: 1fr 1fr; }
    }
    @media (max-width: 520px) {
      .metrics, .metrics-secondary, .metrics-tertiary, .two-col, .three-col { grid-template-columns: 1fr; }
      header { padding: 20px 16px; } main { padding: 16px; }
      header .meta { text-align: left; }
    }
  </style>
</head>
<body>
  <header>
    <div class="container">
      <div>
        <h1><span class="accent">Whisker Ting</span> Telemetry</h1>
        <div class="tagline">Anonymous Homebridge plugin adoption, runtime, and Ting status</div>
      </div>
      <div class="meta">
        <div id="generated">loading&hellip;</div>
        <div style="margin-top:4px">auto-refresh <strong>5 min</strong></div>
      </div>
    </div>
  </header>
  <main>
    <div id="error" class="error-banner"></div>

    <div class="metrics">
      <div class="card">
        <div class="label">Total Installs</div>
        <div class="value" id="totalInstalls">-</div>
        <div class="hint">Seen in last 7 days</div>
      </div>
      <div class="card live">
        <div class="label">Online Now</div>
        <div class="value" id="runningLive">-</div>
        <div class="hint">Start or ping · 10 min</div>
      </div>
      <div class="card">
        <div class="label">Active 24 h</div>
        <div class="value" id="running1">-</div>
        <div class="hint">Start or heartbeat</div>
      </div>
      <div class="card">
        <div class="label">Active 7 d</div>
        <div class="value" id="running7">-</div>
        <div class="hint">Start or heartbeat</div>
      </div>
      <div class="card">
        <div class="label">Active 30 d</div>
        <div class="value" id="running30">-</div>
        <div class="hint">Start or heartbeat</div>
      </div>
    </div>

    <div class="metrics-secondary">
      <div class="card">
        <div class="label">Launches 24 h</div>
        <div class="value" id="launches1">-</div>
        <div class="hint">plugin_start only</div>
      </div>
      <div class="card">
        <div class="label">Launches 7 d</div>
        <div class="value" id="launches7">-</div>
        <div class="hint">Distinct installs</div>
      </div>
      <div class="card">
        <div class="label">Status Reports 30 d</div>
        <div class="value" id="statusReports">-</div>
        <div class="hint">status_update events</div>
      </div>
      <div class="card">
        <div class="label">Installs w/ Status</div>
        <div class="value" id="installsWithStatus">-</div>
        <div class="hint">Latest status in 30 d</div>
      </div>
    </div>

    <div class="metrics-tertiary">
      <div class="card" id="cardHazard">
        <div class="label">Current Hazard</div>
        <div class="value" id="currentHazard">-</div>
        <div class="hint">Installs (latest status)</div>
      </div>
      <div class="card">
        <div class="label">Learning Mode</div>
        <div class="value" id="currentLearning">-</div>
        <div class="hint">Installs currently learning</div>
      </div>
      <div class="card">
        <div class="label">EFH / UFH Reports</div>
        <div class="value" id="efhUfhReports">-</div>
        <div class="hint">Flag hits in 30 d</div>
      </div>
      <div class="card">
        <div class="label">Avg EFH Level</div>
        <div class="value" id="efhAvg">-</div>
        <div class="hint" id="efhHint">30 d samples</div>
      </div>
    </div>

    <div class="section">
      <div class="section-head">
        <h2>Daily Active Plugins</h2>
        <div class="sub">Last 30 days · start or heartbeat</div>
      </div>
      <div class="panel">
        <div class="chart-wrap">
          <div class="chart" id="dailyChart"></div>
          <div class="chart-legend">
            <span id="chartStart">-</span>
            <span id="chartEnd">-</span>
          </div>
        </div>
        <div class="chart-peak" id="chartPeak">Peak: -</div>
      </div>
    </div>

    <div class="two-col">
      <div class="section" style="margin-bottom:0">
        <div class="section-head"><h2>Plugin Versions</h2><div class="sub">Last 30 days</div></div>
        <div class="panel">
          <table>
            <thead><tr><th>Version</th><th style="width:80px">Installs</th><th style="width:160px">Share</th></tr></thead>
            <tbody id="versions"></tbody>
          </table>
        </div>
      </div>
      <div class="section" style="margin-bottom:0">
        <div class="section-head"><h2>Homebridge Versions</h2><div class="sub">Last 30 days</div></div>
        <div class="panel">
          <table>
            <thead><tr><th>Version</th><th style="width:80px">Installs</th><th style="width:160px">Share</th></tr></thead>
            <tbody id="homebridge"></tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="three-col" style="margin-top:28px">
      <div class="section" style="margin-bottom:0">
        <div class="section-head"><h2>Platforms</h2><div class="sub">30 d</div></div>
        <div class="panel">
          <table>
            <thead><tr><th>OS</th><th style="width:70px">N</th><th style="width:120px">Share</th></tr></thead>
            <tbody id="platforms"></tbody>
          </table>
        </div>
      </div>
      <div class="section" style="margin-bottom:0">
        <div class="section-head"><h2>CPU Arch</h2><div class="sub">30 d</div></div>
        <div class="panel">
          <table>
            <thead><tr><th>Arch</th><th style="width:70px">N</th><th style="width:120px">Share</th></tr></thead>
            <tbody id="arches"></tbody>
          </table>
        </div>
      </div>
      <div class="section" style="margin-bottom:0">
        <div class="section-head"><h2>Node.js</h2><div class="sub">30 d</div></div>
        <div class="panel">
          <table>
            <thead><tr><th>Version</th><th style="width:70px">N</th><th style="width:120px">Share</th></tr></thead>
            <tbody id="nodes"></tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="two-col" style="margin-top:28px">
      <div class="section" style="margin-bottom:0">
        <div class="section-head"><h2>Status Labels</h2><div class="sub">status_update · 30 d</div></div>
        <div class="panel">
          <table>
            <thead><tr><th>Status</th><th style="width:80px">Reports</th><th style="width:140px">Share</th></tr></thead>
            <tbody id="statusCounts"></tbody>
          </table>
        </div>
      </div>
      <div class="section" style="margin-bottom:0">
        <div class="section-head"><h2>Hazard Flags</h2><div class="sub">Flag hits in status_update · 30 d</div></div>
        <div class="panel">
          <table>
            <thead><tr><th>Flag</th><th style="width:80px">Hits</th><th style="width:140px">Share</th></tr></thead>
            <tbody id="hazardFlags"></tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="section" style="margin-top:28px">
      <div class="section-head">
        <h2>Install Roster</h2>
        <div class="sub">Offline &gt; 7 days hidden · latest status per install</div>
      </div>
      <div class="panel">
        <table>
          <thead>
            <tr>
              <th>Install</th>
              <th>Presence</th>
              <th>Plugin</th>
              <th>Platform</th>
              <th>Node</th>
              <th>Homebridge</th>
              <th>Ting status</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody id="installs"></tbody>
        </table>
      </div>
    </div>
  </main>
  <footer>Anonymous aggregate telemetry — no Whisker credentials, site IDs, serials, or device names are stored in this view.</footer>
  <script>
    const token = new URLSearchParams(location.search).get("token") || "";
    const errorEl = document.getElementById("error");

    function load() {
      fetch("/api/summary?token=" + encodeURIComponent(token), { cache: "no-store" })
        .then(async r => {
          const data = await r.json();
          if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
          return data;
        })
        .then(render)
        .catch(err => {
          errorEl.textContent = "Failed to load summary: " + err.message;
          errorEl.classList.add("show");
        });
    }

    function render(data) {
      errorEl.classList.remove("show");
      document.getElementById("generated").textContent = "updated " + formatTime(data.generatedAt);
      document.getElementById("totalInstalls").textContent = formatNumber(data.totalInstalls);
      document.getElementById("runningLive").textContent = formatNumber(data.runningPlugins.live);
      document.getElementById("running1").textContent = formatNumber(data.runningPlugins.oneDay);
      document.getElementById("running7").textContent = formatNumber(data.runningPlugins.sevenDays);
      document.getElementById("running30").textContent = formatNumber(data.runningPlugins.thirtyDays);

      const launches = data.launches || {};
      document.getElementById("launches1").textContent = formatNumber(launches.oneDay || 0);
      document.getElementById("launches7").textContent = formatNumber(launches.sevenDays || 0);

      const flags = data.hazardFlags30d || {};
      const current = data.currentHazards || {};
      const levels = data.levels30d || {};

      document.getElementById("statusReports").textContent = formatNumber(flags.status_reports || 0);
      document.getElementById("installsWithStatus").textContent = formatNumber(current.installs_with_status || 0);
      document.getElementById("currentHazard").textContent = formatNumber(current.installs_with_hazard || 0);
      document.getElementById("currentLearning").textContent = formatNumber(current.installs_learning || 0);
      document.getElementById("efhUfhReports").textContent =
        formatNumber((flags.electrical_fire_hazard || 0) + (flags.utility_fire_hazard || 0));
      document.getElementById("efhAvg").textContent =
        levels.efh_avg != null ? Number(levels.efh_avg).toFixed(1) : "—";
      document.getElementById("efhHint").textContent =
        "max " + (levels.efh_max != null ? levels.efh_max : "—") +
        " · " + formatNumber(levels.efh_samples || 0) + " samples" +
        (levels.ufh_avg != null ? " · UFH avg " + Number(levels.ufh_avg).toFixed(1) : "");

      const hazardCard = document.getElementById("cardHazard");
      hazardCard.classList.toggle("danger", (current.installs_with_hazard || 0) > 0);
      hazardCard.classList.toggle("warn", (current.installs_with_hazard || 0) === 0 && (current.installs_learning || 0) > 0);

      renderShareTable("versions", data.versions || [], "value", "plugin_version", true);
      renderShareTable("homebridge", data.homebridgeVersions || [], "value");
      renderShareTable("platforms", data.platforms || [], "value");
      renderShareTable("arches", data.arches || [], "value");
      renderShareTable("nodes", data.nodeVersions || [], "value");

      const status = data.statusCounts || [];
      renderRows("statusCounts", status, row => [
        escapeHtml(prettyStatus(row.hazard_status)),
        formatNumber(row.reports),
        shareBar(status.map(s => ({ installs: s.reports })), row.reports)
      ], "No status reports in 30 days");

      const flagRows = [
        { label: "Fire hazard", value: flags.fire_hazard || 0 },
        { label: "Electrical fire (EFH)", value: flags.electrical_fire_hazard || 0 },
        { label: "Utility fire (UFH)", value: flags.utility_fire_hazard || 0 },
        { label: "Power quality", value: flags.power_quality_hazard || 0 },
        { label: "Learning mode", value: flags.learning_mode || 0 },
      ];
      renderRows("hazardFlags", flagRows, row => [
        escapeHtml(row.label),
        formatNumber(row.value),
        shareBar(flagRows.map(f => ({ installs: f.value })), row.value)
      ], "No flag data");

      const installs = data.installs || [];
      renderRows("installs", installs, row => [
        '<span class="mono">' + escapeHtml(row.install_short) + '&hellip;</span>',
        presencePill(row.status),
        escapeHtml(row.plugin_version || "-"),
        escapeHtml((row.platform || "-") + (row.arch ? "/" + row.arch : "")),
        escapeHtml(row.node_version || "-"),
        escapeHtml(row.homebridge_version || "-"),
        hazardCell(row),
        formatTime(row.last_seen) + (row.age_minutes != null
          ? ' <span style="color:var(--text-secondary);font-size:11px">(' + formatAge(row.age_minutes) + ')</span>'
          : '')
      ], "No installs active in the last 7 days");

      renderDailyChart(data.daily || []);
    }

    function renderShareTable(id, rows, valueKey, versionKey, markLatest) {
      // Support both {value, installs} and legacy {plugin_version, installs}
      const normalized = rows.map(r => ({
        label: r[valueKey] ?? r.plugin_version ?? r.platform ?? r.value ?? "-",
        installs: r.installs || 0
      }));
      let latest = null;
      if (markLatest && normalized.length) {
        latest = normalized.map(r => r.label).sort(semverCompare).pop();
      }
      renderRows(id, normalized, row => {
        const label = markLatest && row.label === latest
          ? '<span class="version-latest">' + escapeHtml(row.label) + '</span>'
          : escapeHtml(row.label);
        return [label, formatNumber(row.installs), shareBar(normalized, row.installs)];
      }, "No data");
    }

    function hazardCell(row) {
      if (row.learning_mode) {
        return '<span class="status-pill pill-warn">Learning</span>';
      }
      const status = row.hazard_status || "";
      if (!status) return '<span class="status-pill pill-muted">—</span>';
      const flags = [];
      if (row.fire_hazard) flags.push("fire");
      if (row.electrical_fire_hazard) flags.push("EFH" + (row.efh_level != null ? " " + row.efh_level : ""));
      if (row.utility_fire_hazard) flags.push("UFH" + (row.ufh_level != null ? " " + row.ufh_level : ""));
      if (row.power_quality_hazard) flags.push("PQ");
      const isBad = /hazard|alarm|danger|alert/i.test(status) || flags.length;
      const cls = isBad ? "pill-danger" : "pill-ok";
      const text = prettyStatus(status) + (flags.length ? " · " + flags.join(", ") : "");
      return '<span class="status-pill ' + cls + '">' + escapeHtml(text) + '</span>';
    }

    function presencePill(status) {
      const label = ({ online: "Online", recent: "24h", idle: "7d" })[status] || status;
      const cls = ({ online: "status-online", recent: "status-recent", idle: "status-idle" })[status] || "status-idle";
      return '<span class="status-pill ' + cls + '">' + escapeHtml(label) + '</span>';
    }

    function renderDailyChart(daily) {
      const max = Math.max(1, ...daily.map(d => d.running_plugins || 0));
      document.getElementById("dailyChart").innerHTML = daily.map(d => {
        const v = d.running_plugins || 0;
        const h = Math.max(2, Math.round((v / max) * 100));
        const cls = v === 0 ? "bar zero" : "bar";
        return '<div class="' + cls + '" style="height:' + h + '%" title="' +
          escapeHtml(formatDate(d.day) + ": " + v + " active") + '"></div>';
      }).join("");
      document.getElementById("chartStart").textContent = daily.length ? formatDate(daily[0].day) : "-";
      document.getElementById("chartEnd").textContent = daily.length ? formatDate(daily[daily.length - 1].day) : "-";
      const peak = daily.reduce((b, d) => (d.running_plugins > (b.running_plugins || 0) ? d : b), { running_plugins: 0 });
      document.getElementById("chartPeak").innerHTML = peak.running_plugins
        ? 'Peak: <strong>' + formatNumber(peak.running_plugins) + '</strong> on ' + formatDate(peak.day)
        : 'Peak: none yet';
    }

    function shareBar(dataset, value) {
      const total = dataset.reduce((s, r) => s + (r.installs || r.reports || r.value || 0), 0);
      const pct = total > 0 ? (value / total * 100) : 0;
      return '<div style="display:flex;align-items:center;gap:8px"><span style="font-size:12px;color:var(--text-secondary);min-width:42px;text-align:right">' +
        pct.toFixed(1) + '%</span><div style="display:flex;height:6px;border-radius:3px;overflow:hidden;background:var(--surface-raised);flex:1"><div style="width:' +
        pct + '%;background:var(--accent)"></div></div></div>';
    }

    function prettyStatus(status) {
      return String(status || "-").replace(/_/g, " ").replace(/\\b\\w/g, ch => ch.toUpperCase());
    }

    function semverCompare(a, b) {
      const pa = String(a).replace(/^v/i, "").split(".").map(n => parseInt(n, 10) || 0);
      const pb = String(b).replace(/^v/i, "").split(".").map(n => parseInt(n, 10) || 0);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
      }
      return 0;
    }

    function formatDate(dateStr) {
      return new Date(dateStr + "T00:00:00Z").toLocaleDateString("en-US", {
        month: "short", day: "numeric", year: "numeric", timeZone: "UTC"
      });
    }

    function formatTime(iso) {
      return new Date(iso).toLocaleString("en-US", {
        month: "short", day: "numeric", year: "numeric",
        hour: "2-digit", minute: "2-digit", timeZoneName: "short"
      });
    }

    function formatAge(minutes) {
      if (minutes < 60) return minutes + "m ago";
      if (minutes < 60 * 24) return Math.round(minutes / 60) + "h ago";
      return Math.round(minutes / (60 * 24)) + "d ago";
    }

    function formatNumber(n) {
      return Number(n || 0).toLocaleString("en-US");
    }

    function renderRows(id, rows, values, emptyMessage) {
      const el = document.getElementById(id);
      if (!rows || !rows.length) {
        const cols = el.closest("table")?.querySelectorAll("thead th")?.length || 1;
        el.innerHTML = '<tr class="empty-row"><td colspan="' + cols + '">' +
          escapeHtml(emptyMessage || "No data") + "</td></tr>";
        return;
      }
      el.innerHTML = rows.map(row =>
        "<tr>" + values(row).map(v => "<td>" + v + "</td>").join("") + "</tr>"
      ).join("");
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, ch =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])
      );
    }

    load();
    setInterval(load, 300000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") load();
    });
  </script>
</body>
</html>`;
}

// Cache API helpers for /api/summary. The dashboard polls every few minutes and
// reloads on tab focus, so serving a cached JSON blob keeps those refreshes off D1.
// The cache key includes the ?token= URL, so only the authorized dashboard hits it.
async function readCachedSummary(request) {
  try {
    const cache = caches.default;
    const key = new Request(request.url, { method: 'GET' });
    const hit = await cache.match(key);
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set('content-type', 'application/json; charset=utf-8');
      headers.set('cache-control', 'no-store'); // never let browsers cache the token URL
      return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers });
    }
  } catch {
    // Cache unavailable — fall through and compute fresh.
  }
  return null;
}

async function writeCachedSummary(request, response) {
  try {
    const cache = caches.default;
    const key = new Request(request.url, { method: 'GET' });
    const copy = response.clone();
    const headers = new Headers(copy.headers);
    // Cloudflare's cache won't store `private` responses. The dashboard fetches
    // with cache: "no-store" (and the URL carries the token), so making the edge
    // copy public is safe — only someone with the token URL can request it.
    headers.set('cache-control', `public, max-age=${SUMMARY_CACHE_TTL_SECONDS}`);
    await cache.put(key, new Response(copy.body, { status: copy.status, statusText: copy.statusText, headers }));
  } catch {
    // Best-effort caching only; a failed put just means the next call recomputes.
  }
}

function isAuthorized(request, env, url) {
  const token = env.DASHBOARD_TOKEN || '';
  if (!token) {
    return false;
  }

  const auth = request.headers.get('authorization') || '';
  return auth === `Bearer ${token}` || url.searchParams.get('token') === token;
}

function json(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...extraHeaders,
    },
  });
}

async function scalar(env, sql, ...params) {
  const row = await first(env, sql, ...params);
  return row?.value ?? 0;
}

async function first(env, sql, ...params) {
  return await env.DB.prepare(sql).bind(...params).first();
}

async function all(env, sql, ...params) {
  const result = await env.DB.prepare(sql).bind(...params).all();
  return result.results || [];
}

function stringValue(value, maxLength) {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

function booleanValue(value) {
  return value === true ? 1 : 0;
}

function nullableNumberValue(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function isoHoursAgo(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function isoMinutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}
