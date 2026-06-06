const ALLOWED_EVENTS = new Set(['plugin_install', 'plugin_start', 'plugin_ping', 'status_update']);

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

      return json(await buildSummary(env));
    }

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/dashboard')) {
      if (!isAuthorized(request, env, url)) {
        return new Response('Unauthorized', { status: 401 });
      }

      return new Response(renderDashboard(), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    return new Response('Not found', { status: 404 });
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

  await env.DB.prepare(
    `INSERT INTO events (
      received_at,
      event_type,
      install_id,
      plugin_version,
      node_version,
      platform,
      arch,
      homebridge_version,
      hazard_status,
      fire_hazard,
      electrical_fire_hazard,
      utility_fire_hazard,
      power_quality_hazard,
      learning_mode,
      efh_level,
      ufh_level
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      new Date().toISOString(),
      eventType,
      installId,
      pluginVersion,
      nodeVersion,
      platform,
      arch,
      homebridgeVersion,
      stringValue(data.hazard_status, 64),
      booleanValue(data.fire_hazard),
      booleanValue(data.electrical_fire_hazard),
      booleanValue(data.utility_fire_hazard),
      booleanValue(data.power_quality_hazard),
      booleanValue(data.learning_mode),
      nullableNumberValue(data.efh_level),
      nullableNumberValue(data.ufh_level),
    )
    .run();

  return json({ ok: true });
}

async function buildSummary(env) {
  const sinceLive = isoMinutesAgo(10);
  const since1Day = isoHoursAgo(24);
  const since7Days = isoHoursAgo(24 * 7);
  const since30Days = isoHoursAgo(24 * 30);

  const [totalInstalls, liveRunning, running1, running7, running30, versions, platforms, statusCounts, daily] = await Promise.all([
    scalar(env, "SELECT COUNT(DISTINCT install_id) AS value FROM events WHERE event_type = 'plugin_install'"),
    scalar(env, "SELECT COUNT(DISTINCT install_id) AS value FROM events WHERE event_type IN ('plugin_start', 'plugin_ping') AND received_at >= ?", sinceLive),
    scalar(env, "SELECT COUNT(DISTINCT install_id) AS value FROM events WHERE event_type = 'plugin_start' AND received_at >= ?", since1Day),
    scalar(env, "SELECT COUNT(DISTINCT install_id) AS value FROM events WHERE event_type = 'plugin_start' AND received_at >= ?", since7Days),
    scalar(env, "SELECT COUNT(DISTINCT install_id) AS value FROM events WHERE event_type = 'plugin_start' AND received_at >= ?", since30Days),
    all(
      env,
      `SELECT plugin_version, COUNT(DISTINCT install_id) AS installs
       FROM events
       WHERE event_type = 'plugin_install'
       GROUP BY plugin_version
       ORDER BY installs DESC, plugin_version DESC`,
    ),
    all(
      env,
      `SELECT platform, COUNT(DISTINCT install_id) AS installs
       FROM events
       WHERE event_type = 'plugin_start'
       GROUP BY platform
       ORDER BY installs DESC, platform ASC`,
    ),
    all(
      env,
      `SELECT hazard_status, COUNT(*) AS reports
       FROM events
       WHERE event_type = 'status_update' AND hazard_status <> ''
       GROUP BY hazard_status
       ORDER BY reports DESC, hazard_status ASC`,
    ),
    all(
      env,
      `SELECT substr(received_at, 1, 10) AS day, COUNT(DISTINCT install_id) AS running_plugins
       FROM events
       WHERE event_type = 'plugin_start' AND received_at >= ?
       GROUP BY day
       ORDER BY day DESC`,
      since30Days,
    ),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    totalInstalls,
    runningPlugins: {
      live: liveRunning,
      oneDay: running1,
      sevenDays: running7,
      thirtyDays: running30,
    },
    versions,
    platforms,
    statusCounts,
    daily,
  };
}

function renderDashboard() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Whisker Ting Telemetry</title>
  <style>
    body { margin: 0; font-family: Segoe UI, Arial, sans-serif; background: #f4f6f8; color: #1f2933; }
    header { background: #171717; color: white; padding: 22px 28px; }
    main { padding: 24px; max-width: 1180px; margin: 0 auto; }
    h1 { margin: 0; font-size: 28px; }
    h2 { font-size: 16px; margin: 0 0 12px; }
    .subtle { color: #c8ced6; margin-top: 4px; }
    .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-bottom: 16px; }
    .card { background: white; border: 1px solid #d4dae1; border-radius: 6px; padding: 16px; }
    .metric { font-size: 32px; font-weight: 700; }
    table { width: 100%; border-collapse: collapse; background: white; border: 1px solid #d4dae1; }
    th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid #e5e9ee; font-size: 14px; }
    th { background: #eef2f5; }
    section { margin-bottom: 18px; }
    @media (max-width: 760px) { .grid { grid-template-columns: 1fr; } main { padding: 14px; } }
  </style>
</head>
<body>
  <header>
    <h1>Whisker Ting Telemetry</h1>
    <div class="subtle" id="generated">Loading...</div>
  </header>
  <main>
    <div class="grid">
      <div class="card"><h2>Plugin Installs</h2><div class="metric" id="totalInstalls">-</div></div>
      <div class="card"><h2>Plugin Running Live</h2><div class="metric" id="runningLive">-</div></div>
      <div class="card"><h2>Plugins Running 24h</h2><div class="metric" id="running1">-</div></div>
    </div>
    <div class="grid">
      <div class="card"><h2>Plugins Running 7d</h2><div class="metric" id="running7">-</div></div>
      <div class="card"><h2>Plugins Running 30d</h2><div class="metric" id="running30">-</div></div>
    </div>
    <section><h2>Installed Versions</h2><table><thead><tr><th>Version</th><th>Unique Installs</th></tr></thead><tbody id="versions"></tbody></table></section>
    <section><h2>Platforms</h2><table><thead><tr><th>Platform</th><th>Unique Installs</th></tr></thead><tbody id="platforms"></tbody></table></section>
    <section><h2>Status Reports</h2><table><thead><tr><th>Status</th><th>Reports</th></tr></thead><tbody id="statusCounts"></tbody></table></section>
    <section><h2>Daily Running Plugins</h2><table><thead><tr><th>Day</th><th>Unique Plugins Running</th></tr></thead><tbody id="daily"></tbody></table></section>
  </main>
  <script>
    const token = new URLSearchParams(location.search).get("token") || "";
    fetch("/api/summary?token=" + encodeURIComponent(token))
      .then(r => r.json())
      .then(data => {
        document.getElementById("generated").textContent = "Generated " + data.generatedAt;
        document.getElementById("totalInstalls").textContent = data.totalInstalls;
        document.getElementById("runningLive").textContent = data.runningPlugins.live;
        document.getElementById("running1").textContent = data.runningPlugins.oneDay;
        document.getElementById("running7").textContent = data.runningPlugins.sevenDays;
        document.getElementById("running30").textContent = data.runningPlugins.thirtyDays;
        renderRows("versions", data.versions, row => [row.plugin_version, row.installs]);
        renderRows("platforms", data.platforms, row => [row.platform, row.installs]);
        renderRows("statusCounts", data.statusCounts, row => [row.hazard_status, row.reports]);
        renderRows("daily", data.daily, row => [row.day, row.running_plugins]);
      });
    function renderRows(id, rows, values) {
      document.getElementById(id).innerHTML = rows.map(row => "<tr>" + values(row).map(value => "<td>" + escapeHtml(String(value)) + "</td>").join("") + "</tr>").join("");
    }
    function escapeHtml(value) {
      return value.replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    }
  </script>
</body>
</html>`;
}

function isAuthorized(request, env, url) {
  const token = env.DASHBOARD_TOKEN || '';
  if (!token) {
    return false;
  }

  const auth = request.headers.get('authorization') || '';
  return auth === `Bearer ${token}` || url.searchParams.get('token') === token;
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
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
