import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import {
  CredentialStore,
  credentialsStillValid,
  WhiskerClient,
  normalizeWhiskerStatus,
  normalizeWhiskerStatuses,
} from '../src/whisker-client.js';

const status = normalizeWhiskerStatus({
  user_id: 123,
  sites: [{
    id: 456,
    displayName: 'Home',
    addressLine1: '1 Main St',
    city: 'Town',
    stateProvince: 'CA',
    postalCode: '90210',
    timeZone: 'America/Los_Angeles',
    isPowerQualityHazard: true,
  }],
  devices: [{
    serialNumber: 'TING123',
    type: 'Ting',
    learningMode: false,
    isHvacVerified: true,
    hasFrozenPipe: true,
    isOwner: true,
    allowApiKeyUpdate: true,
    isFire: false,
    version: '1.2.3',
    wifiMacAddress: 'aa:bb:cc:dd:ee:ff',
    bluetoothMacAddress: '11:22:33:44:55:66',
    socSerialNumber: 'SOC123',
    group: { id: 789, name: 'Panel' },
    fireHazardStatus: {
      learningMode: false,
      message: 'No Hazards Detected',
      efhStatus: { status: 'normal', level: 0, message: 'No EFH' },
      ufhStatus: { status: 'normal', level: 2, message: 'UFH active' },
    },
  }],
});

assert.equal(status.userId, 123);
assert.equal(status.siteId, 456);
assert.equal(status.serialNumber, 'TING123');
assert.equal(status.powerQualityHazard, true);
assert.equal(status.fireHazard, false);
assert.equal(status.electricalFireHazard, false);
assert.equal(status.utilityFireHazard, false);
assert.equal(status.hazardStatus, 'no_hazards');
assert.equal(status.efhLevel, 0);
assert.equal(status.ufhLevel, 2);
assert.equal(status.ufhMessage, 'UFH active');
assert.equal(status.hvacVerified, true);
assert.equal(status.frozenPipe, true);
assert.equal(status.owner, true);
assert.equal(status.apiKeyUpdateAllowed, true);
assert.equal(status.firmwareRevision, '1.2.3');
assert.equal(status.wifiMacAddress, 'ff:ee:dd:cc:bb:aa');
assert.equal(status.bluetoothMacAddress, '66:55:44:33:22:11');
assert.equal(status.socSerialNumber, 'SOC123');
assert.equal(status.groupName, 'Panel');
assert.equal(status.groupId, 789);

// All devices are normalized, and each device uses its own site when the API supplies siteId.
const multiDeviceStatuses = normalizeWhiskerStatuses({
  user_id: 123,
  sites: [
    { id: 456, displayName: 'Home' },
    { id: 999, displayName: 'Garage' },
  ],
  devices: [
    { serialNumber: 'TING123', siteId: 456 },
    { serialNumber: 'TING999', siteId: 999 },
  ],
});
assert.equal(multiDeviceStatuses.length, 2);
assert.equal(multiDeviceStatuses[0].serialNumber, 'TING123');
assert.equal(multiDeviceStatuses[0].siteName, 'Home');
assert.equal(multiDeviceStatuses[1].serialNumber, 'TING999');
assert.equal(multiDeviceStatuses[1].siteName, 'Garage');

const snakeCaseMacStatus = normalizeWhiskerStatus({
  user_id: 123,
  sites: [{ id: 456, displayName: 'Home' }],
  devices: [{
    serialNumber: 'TING123',
    wifi_mac_address: 'aa-bb-cc-dd-ee-ff',
    bluetooth_mac_address: '11-22-33-44-55-66',
  }],
});

assert.equal(snakeCaseMacStatus.wifiMacAddress, 'ff-ee-dd-cc-bb-aa');
assert.equal(snakeCaseMacStatus.bluetoothMacAddress, '66-55-44-33-22-11');

const reviewedStatus = normalizeWhiskerStatus({
  user_id: 123,
  sites: [{ id: 456, displayName: 'Home' }],
  devices: [{
    serialNumber: 'TING123',
    fireHazardStatus: {
      efhStatus: { status: 'ReviewedNotFire', level: 3 },
      ufhStatus: { status: 'normal', level: 0 },
    },
  }],
});

assert.equal(reviewedStatus.electricalFireHazard, false);
assert.equal(reviewedStatus.reviewedNotFire, true);
assert.equal(reviewedStatus.hazardStatus, 'reviewed_not_fire');

// ReviewedSuspicious with level > 0 should not trigger hazard
const reviewedSuspiciousStatus = normalizeWhiskerStatus({
  user_id: 123,
  sites: [{ id: 456, displayName: 'Home' }],
  devices: [{
    serialNumber: 'TING123',
    fireHazardStatus: {
      efhStatus: { status: 'ReviewedSuspicious', level: 20 },
      ufhStatus: { status: null, level: null },
    },
  }],
});
assert.equal(reviewedSuspiciousStatus.electricalFireHazard, false);
assert.equal(reviewedSuspiciousStatus.reviewedNotFire, true);
assert.equal(reviewedSuspiciousStatus.hazardStatus, 'reviewed_not_fire');

// level > 0 with inactive status strings should not trigger hazard
const normalLevelStatus = normalizeWhiskerStatus({
  user_id: 123,
  sites: [{ id: 456, displayName: 'Home' }],
  devices: [{
    serialNumber: 'TING123',
    fireHazardStatus: {
      efhStatus: { status: 'normal', level: 2 },
      ufhStatus: { status: 'none', level: 3 },
    },
  }],
});
assert.equal(normalLevelStatus.electricalFireHazard, false);
assert.equal(normalLevelStatus.utilityFireHazard, false);
assert.equal(normalLevelStatus.hazardStatus, 'no_hazards');

// active status with level > 0 should trigger hazard
const activeStatus = normalizeWhiskerStatus({
  user_id: 123,
  sites: [{ id: 456, displayName: 'Home' }],
  devices: [{
    serialNumber: 'TING123',
    fireHazardStatus: {
      efhStatus: { status: 'active', level: 1 },
      ufhStatus: { status: 'active', level: 2 },
    },
  }],
});
assert.equal(activeStatus.electricalFireHazard, true);
assert.equal(activeStatus.utilityFireHazard, true);
assert.equal(activeStatus.hazardStatus, 'hazard_detected');

// null/undefined status with level > 0 should not trigger hazard
const nullStatusLevel = normalizeWhiskerStatus({
  user_id: 123,
  sites: [{ id: 456, displayName: 'Home' }],
  devices: [{
    serialNumber: 'TING123',
    fireHazardStatus: {
      efhStatus: { level: 1 },
      ufhStatus: { level: 2 },
    },
  }],
});
assert.equal(nullStatusLevel.electricalFireHazard, false);
assert.equal(nullStatusLevel.utilityFireHazard, false);

const nullLevelStatus = normalizeWhiskerStatus({
  user_id: 123,
  sites: [{ id: 456, displayName: 'Home' }],
  devices: [{
    serialNumber: 'TING123',
    fireHazardStatus: {
      efhStatus: { status: 'normal', level: null },
      ufhStatus: { status: null, level: null },
    },
  }],
});

assert.equal(nullLevelStatus.electricalFireHazard, false);
assert.equal(nullLevelStatus.utilityFireHazard, false);
assert.equal(nullLevelStatus.efhLevel, null);
assert.equal(nullLevelStatus.ufhLevel, null);

const authClient = new WhiskerClient({
  authProvider: {
    async getCredentials() {
      return {
        accessToken: 'access-token',
        apiKey: 'api-key',
        userId: 'user-1',
      };
    },
  },
  fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.wskr.io/api/v1/Users/user-1');
    assert.equal(options.headers.Authorization, 'Bearer access-token');
    assert.equal(options.headers['x-wl-api-key'], 'api-key');
    return {
      ok: true,
      json: async () => ({
        user_id: 'user-1',
        sites: [{
          id: 'site-1',
          displayName: 'Home',
          isPowerQualityHazard: false,
        }],
        devices: [{
          serialNumber: 'TING123',
          isFire: true,
        }],
      }),
    };
  },
});

const authStatus = await authClient.getStatus();
assert.equal(authStatus.userId, 'user-1');
assert.equal(authStatus.fireHazard, true);
assert.equal(authStatus.serialNumber, 'TING123');

// Concurrent credential requests share one authentication operation.
let concurrentAuthCalls = 0;
const concurrentAuthClient = new WhiskerClient({
  authProvider: {
    async getCredentials() {
      concurrentAuthCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { accessToken: 'access-token', apiKey: 'api-key', userId: 'user-1' };
    },
  },
  fetchImpl: async () => ({
    ok: true,
    json: async () => ({
      user_id: 'user-1',
      sites: [{ id: 'site-1', displayName: 'Home' }],
      devices: [{ serialNumber: 'TING123', isFire: false }],
    }),
  }),
});
await Promise.all([concurrentAuthClient.getStatus(), concurrentAuthClient.getStatus()]);
assert.equal(concurrentAuthCalls, 1);

// Requests abort with a bounded timeout instead of remaining in flight forever.
const timeoutClient = new WhiskerClient({
  requestTimeoutMs: 1_000,
  authTimeoutMs: 1_000,
  authProvider: {
    async getCredentials() {
      return { accessToken: 'access-token', apiKey: 'api-key', userId: 'user-1' };
    },
  },
  fetchImpl: async (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    });
  }),
});
await assert.rejects(
  timeoutClient.getStatus(),
  /Whisker API request timed out after 1s/,
);

// Authentication also has a bounded timeout.
const authTimeoutClient = new WhiskerClient({
  authTimeoutMs: 1_000,
  authProvider: {
    async getCredentials() {
      return new Promise(() => {});
    },
  },
  fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
});
await assert.rejects(
  authTimeoutClient.getStatus(),
  /Whisker authentication timed out after 1s/,
);

// credentialsStillValid: missing fields
assert.equal(credentialsStillValid(null), false);
assert.equal(credentialsStillValid({}), false);

// no expiry → valid (legacy / until 401)
assert.equal(credentialsStillValid({
  accessToken: 't',
  apiKey: 'k',
  userId: 'u',
}), true);

// not expired yet (with 60s skew)
const now = 1_700_000_000_000;
assert.equal(credentialsStillValid({
  accessToken: 't',
  apiKey: 'k',
  userId: 'u',
  expiresAt: now + 120_000,
}, now, 60_000), true);

// within skew window → refresh
assert.equal(credentialsStillValid({
  accessToken: 't',
  apiKey: 'k',
  userId: 'u',
  expiresAt: now + 30_000,
}, now, 60_000), false);

// already expired
assert.equal(credentialsStillValid({
  accessToken: 't',
  apiKey: 'k',
  userId: 'u',
  expiresAt: now - 1,
}, now, 60_000), false);

// getCredentials re-auths when expiry is near
let authCalls = 0;
const expiringClient = new WhiskerClient({
  authProvider: {
    async getCredentials() {
      authCalls += 1;
      return {
        accessToken: `token-${authCalls}`,
        apiKey: 'api-key',
        userId: 'user-1',
        expiresAt: Date.now() + (authCalls === 1 ? 10_000 : 3_600_000),
      };
    },
  },
  fetchImpl: async () => ({
    ok: true,
    json: async () => ({
      user_id: 'user-1',
      sites: [{ id: 'site-1', displayName: 'Home', isPowerQualityHazard: false }],
      devices: [{ serialNumber: 'TING123', isFire: false }],
    }),
  }),
});

await expiringClient.getStatus();
assert.equal(authCalls, 1);
await expiringClient.getStatus();
assert.equal(authCalls, 2, 'should re-auth when token is within refresh skew');

// CredentialStore persists and clears on disk
const authDir = await mkdtemp(join(os.tmpdir(), 'whisker-ting-auth-'));
try {
  const store = new CredentialStore(authDir);
  await store.save({
    username: 'user@example.com',
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: Date.now() + 3_600_000,
    userId: 'u1',
    apiKey: 'k1',
  });
  const loaded = await store.load();
  assert.equal(loaded.username, 'user@example.com');
  assert.equal(loaded.refreshToken, 'refresh');
  assert.equal(loaded.userId, 'u1');
  const raw = await readFile(join(authDir, 'whisker-ting-auth.json'), 'utf8');
  assert.match(raw, /refreshToken/);
  assert.equal((await stat(join(authDir, 'whisker-ting-auth.json'))).mode & 0o777, 0o600);

  await store.clear();
  assert.equal(await store.load(), null);
} finally {
  await rm(authDir, { recursive: true, force: true });
}

// WhiskerClient reuses stored credentials without calling authProvider
const persistDir = await mkdtemp(join(os.tmpdir(), 'whisker-ting-auth-persist-'));
try {
  let providerCalls = 0;
  const client = new WhiskerClient({
    username: 'user@example.com',
    password: 'secret',
    storagePath: persistDir,
    authProvider: {
      async getCredentials() {
        providerCalls += 1;
        return {
          accessToken: 'disk-token',
          refreshToken: 'disk-refresh',
          apiKey: 'api-key',
          userId: 'user-1',
          expiresAt: Date.now() + 3_600_000,
        };
      },
      async refreshCredentials() {
        throw new Error('should not refresh in this test');
      },
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        user_id: 'user-1',
        sites: [{ id: 'site-1', displayName: 'Home', isPowerQualityHazard: false }],
        devices: [{ serialNumber: 'TING123', isFire: false }],
      }),
    }),
  });

  await client.getStatus();
  assert.equal(providerCalls, 1);
  // New client instance with same store should not re-login
  const client2 = new WhiskerClient({
    username: 'user@example.com',
    password: 'secret',
    storagePath: persistDir,
    authProvider: {
      async getCredentials() {
        providerCalls += 1;
        throw new Error('should use disk credentials');
      },
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        user_id: 'user-1',
        sites: [{ id: 'site-1', displayName: 'Home', isPowerQualityHazard: false }],
        devices: [{ serialNumber: 'TING123', isFire: false }],
      }),
    }),
  });
  await client2.getStatus();
  assert.equal(providerCalls, 1, 'second client should load credentials from disk');
} finally {
  await rm(persistDir, { recursive: true, force: true });
}

console.log('whisker-client tests passed');
