import assert from 'node:assert/strict';
import { WhiskerClient, normalizeWhiskerStatus } from '../src/whisker-client.js';

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
assert.equal(status.wifiMacAddress, 'aa:bb:cc:dd:ee:ff');
assert.equal(status.bluetoothMacAddress, '11:22:33:44:55:66');
assert.equal(status.socSerialNumber, 'SOC123');
assert.equal(status.groupName, 'Panel');
assert.equal(status.groupId, 789);

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

console.log('whisker-client tests passed');
