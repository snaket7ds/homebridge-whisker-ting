import assert from 'node:assert/strict';
import { WhiskerTingPlatform, HAZARD_SENSORS } from '../src/platform.js';

// ---------- Minimal stand-in for the Homebridge / HAP API ----------

class FakeCharacteristic {
  constructor(type) {
    this.type = type;
    this.value = null;
    this.getter = null;
  }

  onGet(fn) {
    this.getter = fn;
    return this;
  }

  async read() {
    return this.getter ? this.getter() : this.value;
  }
}

function characteristicType(name, constants = {}) {
  return { UUID: `char-${name}`, displayName: name, ...constants };
}

const Characteristic = {
  Manufacturer: characteristicType('Manufacturer'),
  Model: characteristicType('Model'),
  SerialNumber: characteristicType('SerialNumber'),
  FirmwareRevision: characteristicType('FirmwareRevision'),
  Name: characteristicType('Name'),
  ConfiguredName: characteristicType('ConfiguredName'),
  SmokeDetected: characteristicType('SmokeDetected', { SMOKE_NOT_DETECTED: 0, SMOKE_DETECTED: 1 }),
  ContactSensorState: characteristicType('ContactSensorState', { CONTACT_DETECTED: 0, CONTACT_NOT_DETECTED: 1 }),
  OccupancyDetected: characteristicType('OccupancyDetected', { OCCUPANCY_NOT_DETECTED: 0, OCCUPANCY_DETECTED: 1 }),
  StatusActive: characteristicType('StatusActive'),
  StatusFault: characteristicType('StatusFault', { NO_FAULT: 0, GENERAL_FAULT: 1 }),
};

class FakeService {
  constructor(type, displayName, subtype) {
    this.UUID = type.UUID;
    this.typeName = type.typeName;
    this.displayName = displayName;
    this.subtype = subtype;
    this.characteristics = new Map();
  }

  getCharacteristic(type) {
    if (!this.characteristics.has(type.UUID)) {
      this.characteristics.set(type.UUID, new FakeCharacteristic(type));
    }
    return this.characteristics.get(type.UUID);
  }

  updateCharacteristic(type, value) {
    this.getCharacteristic(type).value = value;
    return this;
  }

  setCharacteristic(type, value) {
    return this.updateCharacteristic(type, value);
  }

  value(type) {
    return this.characteristics.get(type.UUID)?.value;
  }
}

function serviceType(typeName) {
  return { UUID: `svc-${typeName}`, typeName };
}

const Service = {
  AccessoryInformation: serviceType('AccessoryInformation'),
  SmokeSensor: serviceType('SmokeSensor'),
  ContactSensor: serviceType('ContactSensor'),
  OccupancySensor: serviceType('OccupancySensor'),
  LeakSensor: serviceType('LeakSensor'),
};

class FakeAccessory {
  constructor(displayName, UUID) {
    this.displayName = displayName;
    this.UUID = UUID;
    this.services = [new FakeService(Service.AccessoryInformation, displayName)];
  }

  getService(type) {
    return this.services.find((service) => service.UUID === type.UUID);
  }

  getServiceById(type, subtype) {
    return this.services.find((service) => service.UUID === type.UUID && service.subtype === subtype);
  }

  addService(type, name, subtype) {
    const service = new FakeService(type, name, subtype);
    this.services.push(service);
    return service;
  }

  removeService(service) {
    this.services = this.services.filter((candidate) => candidate !== service);
  }

  serviceNamed(name) {
    const matches = this.services.filter((service) => service.displayName === name);
    assert.equal(matches.length, 1, `expected exactly one service named ${name}, found ${matches.length}`);
    return matches[0];
  }
}

function makeLog() {
  const lines = { info: [], warn: [], error: [], debug: [] };
  const log = {
    lines,
    info: (...args) => lines.info.push(args.join(' ')),
    warn: (...args) => lines.warn.push(args.join(' ')),
    error: (...args) => lines.error.push(args.join(' ')),
    debug: (...args) => lines.debug.push(args.join(' ')),
    clear: () => Object.values(lines).forEach((list) => list.splice(0)),
  };
  return log;
}

function makePlatform(config = {}) {
  const log = makeLog();
  const registered = [];
  const api = {
    hap: { Service, Characteristic, uuid: { generate: (seed) => `uuid:${seed}` } },
    platformAccessory: FakeAccessory,
    registerPlatformAccessories: (_plugin, _platform, accessories) => registered.push(...accessories),
    on: () => {},
    user: { storagePath: () => '' },
    serverVersion: 'test',
  };
  const platform = new WhiskerTingPlatform(log, {
    username: 'owner@example.com',
    password: 'secret',
    telemetryEnabled: false,
    ...config,
  }, api);
  // Never touch the network or the filesystem in these tests.
  platform.telemetry = { recordStatus: async () => {}, recordHeartbeat: async () => {}, initialize: async () => {} };
  platform.client = { getStatuses: async () => platform.nextStatuses };
  return { platform, log, registered };
}

function status(overrides = {}) {
  return {
    siteId: 'site-1',
    siteName: 'Home',
    deviceName: 'Ting',
    serialNumber: 'TING-1',
    model: 'Ting',
    firmwareRevision: '1.0.0',
    hazardStatus: 'none',
    hazardMessage: 'No Hazards Detected',
    fireHazard: false,
    electricalFireHazard: false,
    utilityFireHazard: false,
    powerQualityHazard: false,
    learningMode: false,
    reviewedNotFire: false,
    ...overrides,
  };
}

async function poll(platform, ...statuses) {
  platform.nextStatuses = statuses.length ? statuses : [status()];
  return platform.refreshStatuses();
}

function onlyAccessory(platform) {
  const accessories = [...platform.accessories.values()];
  assert.equal(accessories.length, 1);
  return accessories[0];
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const SMOKE = Characteristic.SmokeDetected;
const CONTACT = Characteristic.ContactSensorState;

// ---------- Tests ----------

test('default setup exposes the expected sensor types, all clear', async () => {
  const { platform, log, registered } = makePlatform();
  await poll(platform, status());
  const accessory = onlyAccessory(platform);
  assert.equal(registered.length, 1);

  assert.equal(accessory.serviceNamed('Ting Electrical Fire Alert').typeName, 'SmokeSensor');
  assert.equal(accessory.serviceNamed('Ting Fire Alert').typeName, 'ContactSensor');
  assert.equal(accessory.serviceNamed('Ting Power Quality Alert').typeName, 'ContactSensor');
  assert.equal(accessory.serviceNamed('Ting Utility Fire Alert').typeName, 'ContactSensor');
  assert.equal(accessory.serviceNamed('Ting Learning Mode').typeName, 'OccupancySensor');

  assert.equal(accessory.serviceNamed('Ting Electrical Fire Alert').value(SMOKE), SMOKE.SMOKE_NOT_DETECTED);
  for (const name of ['Ting Fire Alert', 'Ting Power Quality Alert', 'Ting Utility Fire Alert']) {
    assert.equal(accessory.serviceNamed(name).value(CONTACT), CONTACT.CONTACT_DETECTED, name);
  }
  assert.deepEqual(log.lines.warn, []);
});

test('each alert triggers only its own sensor, in both pushed and read values', async () => {
  for (const sensor of HAZARD_SENSORS) {
    const { platform } = makePlatform();
    await poll(platform, status());
    await poll(platform, status({ [sensor.key]: true }));
    const accessory = onlyAccessory(platform);

    for (const other of HAZARD_SENSORS) {
      const service = accessory.serviceNamed(other.name);
      const isSmoke = service.typeName === 'SmokeSensor';
      const type = isSmoke ? SMOKE : CONTACT;
      const expectedActive = other === sensor;
      const expected = isSmoke
        ? (expectedActive ? SMOKE.SMOKE_DETECTED : SMOKE.SMOKE_NOT_DETECTED)
        : (expectedActive ? CONTACT.CONTACT_NOT_DETECTED : CONTACT.CONTACT_DETECTED);
      assert.equal(service.value(type), expected, `${sensor.key} active: pushed value of ${other.name}`);
      assert.equal(await service.getCharacteristic(type).read(), expected, `${sensor.key} active: read value of ${other.name}`);
    }
  }
});

test('learning mode drives the occupancy sensor', async () => {
  const { platform } = makePlatform();
  await poll(platform, status({ learningMode: true }));
  const learning = onlyAccessory(platform).serviceNamed('Ting Learning Mode');
  assert.equal(learning.value(Characteristic.OccupancyDetected), Characteristic.OccupancyDetected.OCCUPANCY_DETECTED);
  await poll(platform, status({ learningMode: false }));
  assert.equal(learning.value(Characteristic.OccupancyDetected), Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
});

test('alert start is a warning with Ting text, repeats stay quiet, clearing is logged', async () => {
  const { platform, log } = makePlatform();
  await poll(platform, status());
  log.clear();

  await poll(platform, status({ electricalFireHazard: true, efhMessage: 'Arcing detected' }));
  assert.equal(log.lines.warn.length, 1);
  assert.match(log.lines.warn[0], /Electrical fire alert ACTIVE: Arcing detected\. Check the Ting app\./);
  assert.doesNotMatch(log.lines.warn[0], /TING-1/, 'serial number must not appear at warn level');

  log.clear();
  await poll(platform, status({ electricalFireHazard: true, efhMessage: 'Arcing detected' }));
  assert.deepEqual(log.lines.warn, [], 'an unchanged alert must not be logged again');

  await poll(platform, status());
  assert.ok(log.lines.info.some((line) => /Electrical fire alert cleared/.test(line)));
});

test('the placeholder "No Hazards Detected" message is not appended to an alert', async () => {
  const { platform, log } = makePlatform();
  await poll(platform, status());
  await poll(platform, status({ fireHazard: true }));
  assert.match(log.lines.warn.at(-1), /Fire alert ACTIVE\. Check the Ting app\.$/);
});

test('an alert already active at startup is logged once as such', async () => {
  const { platform, log } = makePlatform();
  await poll(platform, status({ utilityFireHazard: true, ufhMessage: 'Utility fault nearby' }));
  assert.equal(log.lines.warn.length, 1);
  assert.match(log.lines.warn[0], /Utility fire alert ACTIVE \(already active at startup\): Utility fault nearby/);
});

test('learning mode changes are logged at info level', async () => {
  const { platform, log } = makePlatform();
  await poll(platform, status({ learningMode: true }));
  assert.ok(log.lines.info.some((line) => /Ting is in learning mode/.test(line)));
  await poll(platform, status({ learningMode: false }));
  assert.ok(log.lines.info.some((line) => /Ting left learning mode/.test(line)));
  assert.deepEqual(log.lines.warn, []);
});

test('smoke-sensor options turn the chosen alerts into smoke sensors', async () => {
  const { platform } = makePlatform({ fireAlertAsSmokeSensor: true, utilityFireAlertAsSmokeSensor: true });
  await poll(platform, status({ fireHazard: true }));
  const accessory = onlyAccessory(platform);

  const fire = accessory.serviceNamed('Ting Fire Alert');
  assert.equal(fire.typeName, 'SmokeSensor');
  assert.equal(fire.value(SMOKE), SMOKE.SMOKE_DETECTED);
  assert.equal(await fire.getCharacteristic(SMOKE).read(), SMOKE.SMOKE_DETECTED);
  assert.equal(accessory.serviceNamed('Ting Utility Fire Alert').typeName, 'SmokeSensor');
  assert.equal(accessory.serviceNamed('Ting Power Quality Alert').typeName, 'ContactSensor');
});

test('only an explicit true enables a smoke-sensor option', async () => {
  const { platform } = makePlatform({ fireAlertAsSmokeSensor: 'yes' });
  await poll(platform, status());
  assert.equal(onlyAccessory(platform).serviceNamed('Ting Fire Alert').typeName, 'ContactSensor');
});

test('switching a cached accessory between sensor types replaces the service cleanly', async () => {
  const first = makePlatform();
  await poll(first.platform, status());
  const cached = onlyAccessory(first.platform);
  assert.equal(cached.serviceNamed('Ting Fire Alert').typeName, 'ContactSensor');

  // Restart with the option on: Homebridge hands the cached accessory back.
  const second = makePlatform({ fireAlertAsSmokeSensor: true });
  second.platform.configureAccessory(cached);
  await poll(second.platform, status({ fireHazard: true }));
  assert.equal(second.registered.length, 0, 'the cached accessory must be reused, not re-registered');
  assert.equal(cached.serviceNamed('Ting Fire Alert').typeName, 'SmokeSensor');
  assert.equal(cached.serviceNamed('Ting Fire Alert').value(SMOKE), SMOKE.SMOKE_DETECTED);

  // And back again.
  const third = makePlatform();
  third.platform.configureAccessory(cached);
  await poll(third.platform, status());
  assert.equal(cached.serviceNamed('Ting Fire Alert').typeName, 'ContactSensor');
  assert.equal(cached.services.length, 6, 'information + 5 sensors, no leftovers');
});

test('two failed polls mark every sensor faulted; the next success clears it', async () => {
  const { platform } = makePlatform();
  await poll(platform, status());
  const accessory = onlyAccessory(platform);
  const fire = accessory.serviceNamed('Ting Fire Alert');
  assert.equal(fire.value(Characteristic.StatusFault), Characteristic.StatusFault.NO_FAULT);

  platform.handlePollFailure(new Error('fetch failed'));
  assert.equal(fire.value(Characteristic.StatusFault), Characteristic.StatusFault.NO_FAULT, 'one failure is tolerated');
  platform.handlePollFailure(new Error('fetch failed'));
  for (const sensor of HAZARD_SENSORS) {
    const service = accessory.serviceNamed(sensor.name);
    assert.equal(service.value(Characteristic.StatusFault), Characteristic.StatusFault.GENERAL_FAULT, sensor.name);
    assert.equal(service.value(Characteristic.StatusActive), false, sensor.name);
  }

  await poll(platform, status());
  assert.equal(fire.value(Characteristic.StatusFault), Characteristic.StatusFault.NO_FAULT);
  assert.equal(fire.value(Characteristic.StatusActive), true);
});

test('multiple devices get separate accessories with independent alerts', async () => {
  const { platform, log } = makePlatform();
  const kitchen = (overrides) => status({ serialNumber: 'TING-A', deviceName: 'Kitchen', ...overrides });
  const garage = (overrides) => status({ serialNumber: 'TING-B', deviceName: 'Garage', ...overrides });
  await poll(platform, kitchen(), garage());
  await poll(platform, kitchen(), garage({ electricalFireHazard: true }));

  const accessories = [...platform.accessories.values()];
  assert.equal(accessories.length, 2);
  const byName = Object.fromEntries(accessories.map((accessory) => [accessory.displayName, accessory]));
  assert.equal(byName['Home - Kitchen'].serviceNamed('Ting Electrical Fire Alert').value(SMOKE), SMOKE.SMOKE_NOT_DETECTED);
  assert.equal(byName['Home - Garage'].serviceNamed('Ting Electrical Fire Alert').value(SMOKE), SMOKE.SMOKE_DETECTED);
  assert.equal(log.lines.warn.length, 1);
  assert.match(log.lines.warn[0], /^Home - Garage: Electrical fire alert ACTIVE/);
});

// ---------- Runner ----------

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name}\n${error.stack}`);
  }
}
if (failed) {
  console.error(`${failed} of ${tests.length} platform tests failed`);
  process.exit(1);
}
console.log(`platform tests passed (${tests.length})`);
