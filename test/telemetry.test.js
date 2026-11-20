import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { TelemetryClient, statusName } from '../src/telemetry.js';

assert.equal(statusName('Active'), 'Active');
assert.equal(statusName('ReviewedNotFire'), 'ReviewedNotFire');
assert.equal(statusName(undefined), 'none');
assert.equal(statusName(''), 'none');
assert.equal(statusName('Fire at 1 Main St'), 'other', 'free text must never be sent');
assert.equal(statusName('x'.repeat(41)), 'other');

const tempDir = await mkdtemp(join(os.tmpdir(), 'whisker-ting-telemetry-'));

try {
  const requests = [];
  let currentTime = new Date('2026-01-01T00:00:00.000Z');
  const client = new TelemetryClient({
    enabled: true,
    endpointUrl: 'https://telemetry.example/events',
    pluginVersion: '1.2.3',
    homebridgeVersion: '2.0.0',
    storagePath: tempDir,
    now: () => currentTime,
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return { ok: true };
    },
  });

  await client.initialize();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.eventType, 'plugin_install');
  assert.equal(requests[1].body.eventType, 'plugin_start');
  assert.match(requests[0].body.installId, /^[a-f0-9]{32}$/i);
  assert.equal(requests[0].body.pluginVersion, '1.2.3');

  await client.recordStatus({
    hazardStatus: 'no_hazards',
    fireHazard: false,
    electricalFireHazard: false,
    utilityFireHazard: false,
    powerQualityHazard: false,
    learningMode: false,
    efhLevel: 0,
    ufhLevel: 0,
    siteId: 'must-not-send',
    serialNumber: 'must-not-send',
    siteAddress: 'must-not-send',
  });
  assert.equal(requests.length, 3);
  assert.equal(requests[2].body.eventType, 'status_update');
  assert.equal(requests[2].body.data.hazard_status, 'no_hazards');
  assert.equal(JSON.stringify(requests[2].body).includes('must-not-send'), false);

  await client.recordStatus({
    hazardStatus: 'no_hazards',
    fireHazard: false,
    electricalFireHazard: false,
    utilityFireHazard: false,
    powerQualityHazard: false,
    learningMode: false,
    efhLevel: 0,
    ufhLevel: 0,
  });
  assert.equal(requests.length, 3);
  assert.equal(requests[2].body.data.learning_mode, false);

  currentTime = new Date('2026-01-02T01:00:00.000Z');
  await client.recordStatus({
    hazardStatus: 'hazard_detected',
    fireHazard: true,
    electricalFireHazard: false,
    utilityFireHazard: false,
    powerQualityHazard: false,
    learningMode: false,
    efhLevel: 0,
    ufhLevel: 0,
  });
  assert.equal(requests.length, 4);
  assert.equal(requests[3].body.data.fire_hazard, true);

  await client.recordHeartbeat();
  assert.equal(requests.length, 5);
  assert.equal(requests[4].body.eventType, 'plugin_ping');

  // Heartbeat dedupe within 14 minutes
  await client.recordHeartbeat();
  assert.equal(requests.length, 5, 'rapid second ping should be suppressed');
  currentTime = new Date('2026-01-02T01:20:00.000Z');
  await client.recordHeartbeat();
  assert.equal(requests.length, 6, 'ping after min interval should send');

  // Per-device slot dedupe: two devices reporting the same state must both send.
  const flatStatus = {
    hazardStatus: 'no_hazards',
    fireHazard: false,
    electricalFireHazard: false,
    utilityFireHazard: false,
    powerQualityHazard: false,
    learningMode: false,
    efhLevel: 0,
    ufhLevel: 0,
  };
  currentTime = new Date('2026-01-02T02:00:00.000Z');
  await client.recordStatus(flatStatus, { deviceSlot: 0 });
  assert.equal(requests.length, 7, 'first status for device slot 0 should send');
  await client.recordStatus(flatStatus, { deviceSlot: 1 });
  assert.equal(requests.length, 8, 'identical state from a second device slot must not be suppressed');
  assert.equal(requests[6].body.data.hazard_status, 'no_hazards');
  assert.equal(
    JSON.stringify(requests[7].body).includes('deviceSlot'),
    false,
    'the device slot is a local dedupe key and must not be sent',
  );

  // Same slot, unchanged state, inside the 24h window -> suppressed.
  await client.recordStatus(flatStatus, { deviceSlot: 1 });
  assert.equal(requests.length, 8, 'unchanged state for the same slot within 24h should be suppressed');
  await client.recordStatus(flatStatus, { deviceSlot: 0 });
  assert.equal(requests.length, 8, 'slot 0 must dedupe independently of slot 1');

  // Same slot, changed state -> sends even though the other slot is unchanged.
  await client.recordStatus(
    { ...flatStatus, hazardStatus: 'hazard_detected', electricalFireHazard: true, efhLevel: 20 },
    { deviceSlot: 1 },
  );
  assert.equal(requests.length, 9, 'changed state for the same slot should send');
  assert.equal(requests[8].body.data.electrical_fire_hazard, true);
  assert.equal(requests[8].body.data.efh_level, 20);
  assert.equal(requests[8].body.data.efh_status, 'none', 'a missing status name is sent as none');

  // Whisker's status name is sent, and a change in it alone triggers a report.
  await client.recordStatus(
    { ...flatStatus, hazardStatus: 'hazard_detected', electricalFireHazard: true, efhLevel: 20, ufhStatus: 'Active' },
    { deviceSlot: 1 },
  );
  assert.equal(requests.length, 10, 'a changed status name should send');
  assert.equal(requests[9].body.data.ufh_status, 'Active');
  requests.pop();
  // Remove the extra state so the 24h re-send check below keeps its original meaning.
  await client.recordStatus(
    { ...flatStatus, hazardStatus: 'hazard_detected', electricalFireHazard: true, efhLevel: 20 },
    { deviceSlot: 1 },
  );
  assert.equal(requests.length, 10);
  requests.pop();

  // Unchanged state past the 24h window -> re-sends as a daily liveness report.
  currentTime = new Date('2026-01-03T03:30:00.000Z');
  await client.recordStatus(
    { ...flatStatus, hazardStatus: 'hazard_detected', electricalFireHazard: true, efhLevel: 20 },
    { deviceSlot: 1 },
  );
  assert.equal(requests.length, 10, 'unchanged status should re-send after 24h');

  const disabledClient = new TelemetryClient({
    enabled: false,
    endpointUrl: 'https://telemetry.example/events',
    fetchImpl: async () => {
      throw new Error('disabled telemetry should not send');
    },
  });
  await disabledClient.initialize();

  const defaultEnabledRequests = [];
  const defaultEnabledClient = new TelemetryClient({
    endpointUrl: 'https://telemetry.example/events',
    pluginVersion: '1.2.3',
    storagePath: await mkdtemp(join(os.tmpdir(), 'whisker-ting-telemetry-default-')),
    fetchImpl: async (url, options) => {
      defaultEnabledRequests.push({ url, body: JSON.parse(options.body) });
      return { ok: true };
    },
  });
  try {
    await defaultEnabledClient.initialize();
    assert.equal(defaultEnabledRequests.length, 2);
    assert.equal(defaultEnabledRequests[0].body.eventType, 'plugin_install');
    assert.equal(defaultEnabledRequests[1].body.eventType, 'plugin_start');
  } finally {
    await rm(defaultEnabledClient.storagePath, { recursive: true, force: true });
  }

  console.log('telemetry tests passed');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
