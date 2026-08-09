import { PLUGIN_NAME, PLATFORM_NAME, PLUGIN_VERSION } from './settings.js';
import { TelemetryClient } from './telemetry.js';
import { WhiskerClient } from './whisker-client.js';

const HAP_ELECTRICAL_FIRE_HAZARD_SUBTYPE = 'electrical-fire-hazard';
const HAP_FIRE_HAZARD_SUBTYPE = 'fire-hazard';
const HAP_POWER_QUALITY_SUBTYPE = 'power-quality-hazard';
const HAP_UTILITY_FIRE_HAZARD_SUBTYPE = 'utility-fire-hazard';
const HAP_LEARNING_MODE_SUBTYPE = 'learning-mode';
const TELEMETRY_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
/** Mark HomeKit sensors offline after this many consecutive failed polls. */
const OFFLINE_AFTER_FAILURES = 2;
const SERVICE_NAMES = {
  electricalFireHazard: 'Ting Electrical Fire Alert',
  fireHazard: 'Ting Fire Alert',
  powerQualityHazard: 'Ting Power Quality Alert',
  utilityFireHazard: 'Ting Utility Fire Alert',
  learningMode: 'Ting Learning Mode',
};

export class WhiskerTingPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.accessories = new Map();
    this.client = new WhiskerClient({
      username: this.config.username,
      password: this.config.password,
    });
    this.telemetry = new TelemetryClient({
      enabled: this.config.telemetryEnabled,
      endpointUrl: this.config.telemetryEndpointUrl,
      pluginVersion: PLUGIN_VERSION,
      homebridgeVersion: api.serverVersion,
      storagePath: api.user?.storagePath?.(),
      log,
    });
    this.pollIntervalMs = Math.max(Number(this.config.pollInterval || 60), 30) * 1000;
    this.pollInFlight = false;
    this.consecutivePollFailures = 0;
    this.apiOnline = true;
    this.lastPollError = null;

    this.api.on('didFinishLaunching', () => {
      this.discoverAndStart().catch((error) => {
        this.log.error('Failed to initialize Ting Whisker platform:', error.message);
      });
    });

    this.api.on('shutdown', () => {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
      }
      if (this.telemetryHeartbeatTimer) {
        clearInterval(this.telemetryHeartbeatTimer);
      }
    });
  }

  configureAccessory(accessory) {
    this.accessories.set(accessory.UUID, accessory);
  }

  async discoverAndStart() {
    const status = await this.client.getStatus();
    await this.telemetry.initialize().catch((error) => {
      this.log.debug('Failed to initialize anonymous Ting telemetry:', error.message);
    });
    const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}-${status.siteId}-${status.serialNumber}`);
    let accessory = this.accessories.get(uuid);

    if (!accessory) {
      accessory = new this.api.platformAccessory(this.config.name || status.siteName || 'Ting', uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(uuid, accessory);
      this.log.info('Added Ting accessory:', accessory.displayName);
    } else {
      this.log.info('Restored Ting accessory from cache:', accessory.displayName);
    }

    this.configureServices(accessory, status);
    this.markOnline();
    this.updateServices(accessory, status);
    this.recordTelemetryStatus(status);
    this.unregisterStaleAccessories(uuid);

    this.pollTimer = setInterval(() => {
      this.poll(accessory).catch((error) => {
        this.handlePollFailure(accessory, error);
      });
    }, this.pollIntervalMs);

    this.telemetryHeartbeatTimer = setInterval(() => {
      this.telemetry.recordHeartbeat().catch((error) => {
        this.log.debug('Failed to record anonymous Ting telemetry heartbeat:', error.message);
      });
    }, TELEMETRY_HEARTBEAT_INTERVAL_MS);
  }

  configureServices(accessory, status) {
    this.removeLegacyContactSensors(accessory);

    accessory.getService(this.Service.AccessoryInformation)
      .setCharacteristic(this.Characteristic.Manufacturer, 'Whisker Labs')
      .setCharacteristic(this.Characteristic.Model, status.model)
      .setCharacteristic(this.Characteristic.SerialNumber, status.serialNumber)
      .setCharacteristic(this.Characteristic.FirmwareRevision, status.firmwareRevision || 'unknown')
      .setCharacteristic(this.Characteristic.Name, accessory.displayName);

    this.removeRenamedServices(accessory);
    this.removeUnusedServices(accessory);

    const electrical = this.getOrAddService(
      accessory,
      this.Service.SmokeSensor,
      SERVICE_NAMES.electricalFireHazard,
      HAP_ELECTRICAL_FIRE_HAZARD_SUBTYPE,
    );
    electrical
      .getCharacteristic(this.Characteristic.SmokeDetected)
      .onGet(() => this.lastStatus?.electricalFireHazard
        ? this.Characteristic.SmokeDetected.SMOKE_DETECTED
        : this.Characteristic.SmokeDetected.SMOKE_NOT_DETECTED);
    this.bindConnectivityGets(electrical);

    const fire = this.getOrAddService(accessory, this.Service.ContactSensor, SERVICE_NAMES.fireHazard, HAP_FIRE_HAZARD_SUBTYPE);
    fire
      .getCharacteristic(this.Characteristic.ContactSensorState)
      .onGet(() => this.lastStatus?.fireHazard
        ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
        : this.Characteristic.ContactSensorState.CONTACT_DETECTED);
    this.bindConnectivityGets(fire);

    const powerQuality = this.getOrAddService(accessory, this.Service.ContactSensor, SERVICE_NAMES.powerQualityHazard, HAP_POWER_QUALITY_SUBTYPE);
    powerQuality
      .getCharacteristic(this.Characteristic.ContactSensorState)
      .onGet(() => this.lastStatus?.powerQualityHazard
        ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
        : this.Characteristic.ContactSensorState.CONTACT_DETECTED);
    this.bindConnectivityGets(powerQuality);

    const utility = this.getOrAddService(accessory, this.Service.ContactSensor, SERVICE_NAMES.utilityFireHazard, HAP_UTILITY_FIRE_HAZARD_SUBTYPE);
    utility
      .getCharacteristic(this.Characteristic.ContactSensorState)
      .onGet(() => this.lastStatus?.utilityFireHazard
        ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
        : this.Characteristic.ContactSensorState.CONTACT_DETECTED);
    this.bindConnectivityGets(utility);

    const learning = this.getOrAddService(accessory, this.Service.OccupancySensor, SERVICE_NAMES.learningMode, HAP_LEARNING_MODE_SUBTYPE);
    learning
      .getCharacteristic(this.Characteristic.OccupancyDetected)
      .onGet(() => this.lastStatus?.learningMode
        ? this.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
        : this.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    this.bindConnectivityGets(learning);
  }

  async poll(accessory) {
    if (this.pollInFlight) {
      this.log.debug('Skipping Ting poll; previous poll still in flight');
      return;
    }

    this.pollInFlight = true;
    try {
      const status = await this.client.getStatus();
      this.markOnline();
      this.updateServices(accessory, status);
      this.recordTelemetryStatus(status);
    } finally {
      this.pollInFlight = false;
    }
  }

  handlePollFailure(accessory, error) {
    this.consecutivePollFailures += 1;
    this.lastPollError = error?.message || String(error);
    this.log.warn(
      `Failed to poll Ting status (${this.consecutivePollFailures}): ${this.lastPollError}`,
    );

    if (this.consecutivePollFailures >= OFFLINE_AFTER_FAILURES) {
      const wasOnline = this.apiOnline;
      this.apiOnline = false;
      if (wasOnline) {
        this.log.warn('Ting API marked offline after consecutive poll failures');
      }
      this.updateConnectivity(accessory);
    }
  }

  markOnline() {
    if (!this.apiOnline || this.consecutivePollFailures > 0) {
      if (!this.apiOnline) {
        this.log.info('Ting API is online again');
      }
    }
    this.apiOnline = true;
    this.consecutivePollFailures = 0;
    this.lastPollError = null;
  }

  bindConnectivityGets(service) {
    // Ensure optional connectivity characteristics exist on hazard services.
    if (this.Characteristic.StatusActive) {
      service.getCharacteristic(this.Characteristic.StatusActive)
        .onGet(() => this.apiOnline);
    }
    if (this.Characteristic.StatusFault) {
      service.getCharacteristic(this.Characteristic.StatusFault)
        .onGet(() => (this.apiOnline
          ? this.Characteristic.StatusFault.NO_FAULT
          : this.Characteristic.StatusFault.GENERAL_FAULT));
    }
  }

  updateConnectivity(accessory) {
    const active = this.apiOnline;
    const fault = this.apiOnline
      ? this.Characteristic.StatusFault.NO_FAULT
      : this.Characteristic.StatusFault.GENERAL_FAULT;

    const targetNames = new Set(Object.values(SERVICE_NAMES));
    for (const service of accessory.services) {
      if (!targetNames.has(service.displayName)) {
        continue;
      }
      if (this.Characteristic.StatusActive) {
        service.updateCharacteristic(this.Characteristic.StatusActive, active);
      }
      if (this.Characteristic.StatusFault) {
        service.updateCharacteristic(this.Characteristic.StatusFault, fault);
      }
    }
  }

  updateServices(accessory, status) {
    this.lastStatus = status;

    this.getOrAddService(
      accessory,
      this.Service.SmokeSensor,
      SERVICE_NAMES.electricalFireHazard,
      HAP_ELECTRICAL_FIRE_HAZARD_SUBTYPE,
    )
      .updateCharacteristic(
        this.Characteristic.SmokeDetected,
        status.electricalFireHazard
          ? this.Characteristic.SmokeDetected.SMOKE_DETECTED
          : this.Characteristic.SmokeDetected.SMOKE_NOT_DETECTED,
      );

    this.getOrAddService(accessory, this.Service.ContactSensor, SERVICE_NAMES.fireHazard, HAP_FIRE_HAZARD_SUBTYPE)
      .updateCharacteristic(
        this.Characteristic.ContactSensorState,
        status.fireHazard
          ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
          : this.Characteristic.ContactSensorState.CONTACT_DETECTED,
      );

    this.getOrAddService(accessory, this.Service.ContactSensor, SERVICE_NAMES.powerQualityHazard, HAP_POWER_QUALITY_SUBTYPE)
      .updateCharacteristic(
        this.Characteristic.ContactSensorState,
        status.powerQualityHazard
          ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
          : this.Characteristic.ContactSensorState.CONTACT_DETECTED,
      );

    this.getOrAddService(accessory, this.Service.ContactSensor, SERVICE_NAMES.utilityFireHazard, HAP_UTILITY_FIRE_HAZARD_SUBTYPE)
      .updateCharacteristic(
        this.Characteristic.ContactSensorState,
        status.utilityFireHazard
          ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
          : this.Characteristic.ContactSensorState.CONTACT_DETECTED,
      );

    this.getOrAddService(accessory, this.Service.OccupancySensor, SERVICE_NAMES.learningMode, HAP_LEARNING_MODE_SUBTYPE)
      .updateCharacteristic(
        this.Characteristic.OccupancyDetected,
        status.learningMode
          ? this.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
          : this.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
      );

    // Connectivity: StatusActive / StatusFault reflect API reachability, not hazard.
    this.updateConnectivity(accessory);

    this.log.debug(
      `Ting status: hazard=${status.hazardStatus}, fire=${status.fireHazard}, ` +
      `efh=${status.electricalFireHazard}/${status.efhStatus}/${status.efhLevel}, ` +
      `ufh=${status.utilityFireHazard}/${status.ufhStatus}/${status.ufhLevel}, ` +
      `powerQuality=${status.powerQualityHazard}, learning=${status.learningMode}, ` +
      `reviewedNotFire=${status.reviewedNotFire}, online=${this.apiOnline}`,
    );
  }

  recordTelemetryStatus(status) {
    this.telemetry.recordStatus(status).catch((error) => {
      this.log.debug('Failed to record anonymous Ting telemetry:', error.message);
    });
  }

  getOrAddService(accessory, serviceType, name, subtype) {
    for (const service of [...accessory.services]) {
      if (service.displayName === name && service.UUID !== serviceType.UUID) {
        accessory.removeService(service);
        this.log.info('Removed Ting service with wrong HomeKit type from cache:', name);
      }
    }

    const service = subtype
      ? accessory.getServiceById(serviceType, subtype) || accessory.addService(serviceType, name, subtype)
      : accessory.services.find((candidate) => (
        candidate.UUID === serviceType.UUID && candidate.displayName === name
      )) || accessory.addService(serviceType, name);

    if (service.displayName !== name) {
      service.displayName = name;
      this.log.info('Renamed Ting service:', name);
    }

    this.updateServiceName(service, name);

    return service;
  }

  updateServiceName(service, name) {
    const nameCharacteristics = [
      this.Characteristic.Name,
      this.Characteristic.ConfiguredName,
    ].filter(Boolean);

    for (const characteristic of nameCharacteristics) {
      const nameCharacteristic = service.getCharacteristic(characteristic);
      if (nameCharacteristic?.value !== name) {
        service.updateCharacteristic(characteristic, name);
      }
    }
  }

  removeLegacyContactSensors(accessory) {
    const legacyServices = accessory.services.filter((service) => (
      service.UUID === this.Service.ContactSensor.UUID && !service.subtype
    ));

    for (const service of legacyServices) {
      accessory.removeService(service);
      this.log.info('Removed legacy Ting contact sensor service from cache');
    }
  }

  removeRenamedServices(accessory) {
    const renamedServices = new Map([
      [this.Service.SmokeSensor.UUID, new Set([
        'Electrical Fire Hazard',
        'Electrical Fire Alert',
        SERVICE_NAMES.electricalFireHazard,
      ])],
      [this.Service.OccupancySensor.UUID, new Set([
        'Learning Mode',
        SERVICE_NAMES.learningMode,
      ])],
    ]);
    const oldNames = new Set(['Electrical Fire Hazard', 'Electrical Fire Alert', 'Learning Mode']);

    for (const service of [...accessory.services]) {
      const names = renamedServices.get(service.UUID);
      if (!names?.has(service.displayName)) {
        continue;
      }

      if (!service.subtype || oldNames.has(service.displayName)) {
        accessory.removeService(service);
        this.log.info('Removed renamed Ting service from cache:', service.displayName);
      }
    }
  }

  removeUnusedServices(accessory) {
    const unusedServices = new Map([
      [this.Service.LeakSensor.UUID, new Set(['Frozen Pipe', 'Frozen Pipe Alert'])],
      [this.Service.ContactSensor.UUID, new Set([
        'Reviewed Not Fire',
        'HVAC Verified',
        'HVAC Monitoring Verified',
        'Account Owner',
        'Ting Account Owner',
        'API Key Update Allowed',
        'API Key Updates Allowed',
        'Power Quality Alert',
        'Utility Fire Alert',
      ])],
    ]);

    for (const service of [...accessory.services]) {
      const names = unusedServices.get(service.UUID);
      if (!names?.has(service.displayName)) {
        continue;
      }

      accessory.removeService(service);
      this.log.info('Removed unused Ting service from cache:', service.displayName);
    }
  }

  unregisterStaleAccessories(activeUuid) {
    const staleAccessories = [...this.accessories.entries()]
      .filter(([uuid]) => uuid !== activeUuid)
      .map(([, accessory]) => accessory);

    if (!staleAccessories.length) {
      return;
    }

    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleAccessories);
    for (const accessory of staleAccessories) {
      this.accessories.delete(accessory.UUID);
      this.log.info('Removed stale Ting accessory from cache:', accessory.displayName);
    }
  }
}
