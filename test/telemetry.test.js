import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { TelemetryClient } from '../src/telemetry.js';

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

  const disabledClient = new TelemetryClient({
    enabled: false,
    endpointUrl: 'https://telemetry.example/events',
    fetchImpl: async () => {
      throw new Error('disabled telemetry should not send');
    },
  });
  await disabledClient.initialize();

  console.log('telemetry tests passed');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
