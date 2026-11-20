import { renderAppleDashboard } from './dashboard-apple.js';
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

      return new Response(renderAppleDashboard(), {
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

/**
 * An install counts as online when heard from within this window. Plugins since 1.0.17
 * send a heartbeat every 15 minutes, so the window must be longer than that.
 */
const ONLINE_WINDOW_MINUTES = 20;

async function buildSummary(env) {
  const sinceLive = isoMinutesAgo(ONLINE_WINDOW_MINUTES);
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
    scalar(env, 'SELECT COUNT(*) AS value FROM installs'),
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
         -- An install has a hazard only when an alert flag is set. 'no_hazards',
         -- 'reviewed_not_fire' and 'learning' are not hazards.
         COALESCE(SUM(CASE WHEN fire_hazard = 1 OR electrical_fire_hazard = 1
           OR utility_fire_hazard = 1 OR power_quality_hazard = 1
           OR hazard_status = 'hazard_detected' THEN 1 ELSE 0 END), 0) AS installs_with_hazard,
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
      if (ageMin != null && ageMin <= ONLINE_WINDOW_MINUTES) status = 'online';
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
