import { PLUGIN_NAME, PLATFORM_NAME, PLUGIN_VERSION } from './settings.js';
import { TelemetryClient } from './telemetry.js';
import { WhiskerClient } from './whisker-client.js';

const HAP_ELECTRICAL_FIRE_HAZARD_SUBTYPE = 'electrical-fire-hazard';
const HAP_FIRE_HAZARD_SUBTYPE = 'fire-hazard';
const HAP_POWER_QUALITY_SUBTYPE = 'power-quality-hazard';
const HAP_UTILITY_FIRE_HAZARD_SUBTYPE = 'utility-fire-hazard';
const HAP_LEARNING_MODE_SUBTYPE = 'learning-mode';
/** Heartbeat every 15 minutes (was 5) to cut D1 write volume. */
const TELEMETRY_HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000;
/** Mark HomeKit sensors offline after this many consecutive failed polls. */
const OFFLINE_AFTER_FAILURES = 2;
const STARTUP_RETRY_INITIAL_MS = 5_000;
const MAX_RETRY_DELAY_MS = 15 * 60 * 1000;
const POLL_JITTER_RATIO = 0.1;
/** Warn after repeated successful responses omit a cached accessory. */
const MISSING_ACCESSORY_WARNING_THRESHOLD = 2;
const SERVICE_NAMES = {
  electricalFireHazard: 'Ting Electrical Fire Alert',
  fireHazard: 'Ting Fire Alert',
  powerQualityHazard: 'Ting Power Quality Alert',
  utilityFireHazard: 'Ting Utility Fire Alert',
  learningMode: 'Ting Learning Mode',
};
const NO_HAZARD_MESSAGE = 'No Hazards Detected';

/**
 * The four Ting alert sensors. The electrical fire alert is always a HomeKit smoke
 * sensor. The others are contact sensors (open = alert) unless their `smokeConfigKey`
 * is set to true, which makes them smoke sensors so iOS can deliver them as Critical
 * Alerts. `message` picks the most specific Ting text to put in the log.
 */
export const HAZARD_SENSORS = [
  {
    key: 'electricalFireHazard',
    label: 'Electrical fire alert',
    name: SERVICE_NAMES.electricalFireHazard,
    subtype: HAP_ELECTRICAL_FIRE_HAZARD_SUBTYPE,
    smokeConfigKey: null,
    message: (status) => status.efhMessage || status.hazardMessage,
  },
  {
    key: 'fireHazard',
    label: 'Fire alert',
    name: SERVICE_NAMES.fireHazard,
    subtype: HAP_FIRE_HAZARD_SUBTYPE,
    smokeConfigKey: 'fireAlertAsSmokeSensor',
    message: (status) => status.hazardMessage,
  },
  {
    key: 'powerQualityHazard',
    label: 'Power quality alert',
    name: SERVICE_NAMES.powerQualityHazard,
    subtype: HAP_POWER_QUALITY_SUBTYPE,
    smokeConfigKey: 'powerQualityAlertAsSmokeSensor',
    message: () => null,
  },
  {
    key: 'utilityFireHazard',
    label: 'Utility fire alert',
    name: SERVICE_NAMES.utilityFireHazard,
    subtype: HAP_UTILITY_FIRE_HAZARD_SUBTYPE,
    smokeConfigKey: 'utilityFireAlertAsSmokeSensor',
    message: (status) => status.ufhMessage || status.hazardMessage,
  },
];

export class WhiskerTingPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.accessories = new Map();
    this.configuredAccessories = new Set();
    this.statusByUuid = new Map();
    this.accessoryOnlineByUuid = new Map();
    this.missingAccessoryCounts = new Map();
    const storagePath = api.user?.storagePath?.() || '';
    this.client = new WhiskerClient({
      username: this.config.username,
      password: this.config.password,
      storagePath,
      requestTimeoutMs: Number(this.config.requestTimeoutSeconds || 20) * 1000,
      authTimeoutMs: Number(this.config.authTimeoutSeconds || 20) * 1000,
      log,
    });
    this.telemetry = new TelemetryClient({
      enabled: this.config.telemetryEnabled,
      endpointUrl: this.config.telemetryEndpointUrl,
      pluginVersion: PLUGIN_VERSION,
      homebridgeVersion: api.serverVersion,
      storagePath,
      log,
    });
    this.pollIntervalMs = Math.max(Number(this.config.pollInterval || 60), 30) * 1000;
    this.pollInFlight = false;
    this.consecutivePollFailures = 0;
    // No successful API response has been received yet.
    this.apiOnline = false;
    this.lastPollError = null;
    this.nextRetryDelayMs = STARTUP_RETRY_INITIAL_MS;
    this.started = false;

    this.api.on('didFinishLaunching', () => {
      this.discoverAndStart().catch((error) => {
        this.log.error('Failed to initialize Ting Whisker platform:', error.message);
      });
    });

    this.api.on('shutdown', () => {
      this.stopTimers();
    });
  }

  configureAccessory(accessory) {
    this.accessories.set(accessory.UUID, accessory);
  }

  /**
   * Fail fast with a clear message when required config is missing.
   * @returns {string|null} Error message, or null when config looks usable.
   */
  validateConfig() {
    const username = typeof this.config.username === 'string' ? this.config.username.trim() : '';
    const password = typeof this.config.password === 'string' ? this.config.password : '';

    if (!username && !password) {
      return 'Whisker email and password are required. Open Homebridge settings for Homebridge Whisker Ting and enter your Ting app credentials.';
    }
    if (!username) {
      return 'Whisker email is required. Open Homebridge settings for Homebridge Whisker Ting and enter the email used in the Ting app.';
    }
    if (!password) {
      return 'Whisker password is required. Open Homebridge settings for Homebridge Whisker Ting and enter the password used in the Ting app.';
    }
    if (!username.includes('@')) {
      return 'Whisker email looks invalid. Use the email address for your Ting app account.';
    }
    return null;
  }

  async discoverAndStart() {
    const configError = this.validateConfig();
    if (configError) {
      this.log.error(configError);
      throw new Error(configError);
    }

    if (this.started) {
      return;
    }

    try {
      const statuses = await this.refreshStatuses();
      await this.completeStartup(statuses);
    } catch (error) {
      this.handlePollFailure(error);
      this.schedulePoll(this.nextRetryDelayMs);
      this.nextRetryDelayMs = Math.min(this.nextRetryDelayMs * 2, MAX_RETRY_DELAY_MS);
    }
  }

  async completeStartup(statuses) {
    await this.telemetry.initialize().catch((error) => {
      this.log.debug('Failed to initialize anonymous Ting telemetry:', error.message);
    });
    this.started = true;
    this.nextRetryDelayMs = STARTUP_RETRY_INITIAL_MS;
    this.schedulePoll(this.pollIntervalMs);
    this.startTelemetryHeartbeat();
    this.log.info(`Ting initialized with ${statuses.length} device${statuses.length === 1 ? '' : 's'}`);
  }

  async refreshStatuses() {
    const statuses = await this.client.getStatuses();
    if (!Array.isArray(statuses) || statuses.length === 0) {
      throw new Error('Whisker API response did not include any devices');
    }

    const activeUuids = new Set();
    const telemetrySlots = new Map(
      [...statuses]
        .sort((left, right) => String(left.serialNumber).localeCompare(String(right.serialNumber)))
        .map((status, index) => [status.serialNumber, index]),
    );
    this.markOnline();
    for (const status of statuses) {
      const accessory = this.ensureAccessory(status, statuses.length);
      const uuid = accessory.UUID;
      activeUuids.add(uuid);
      this.accessoryOnlineByUuid.set(uuid, true);
      this.missingAccessoryCounts.delete(uuid);
      if (!this.configuredAccessories.has(uuid)) {
        this.configureServices(accessory, status);
        this.configuredAccessories.add(uuid);
      }
      this.logStatusChanges(accessory, this.statusByUuid.get(uuid), status);
      this.statusByUuid.set(uuid, status);
      this.updateServices(accessory, status);
      this.recordTelemetryStatus(status, telemetrySlots.get(status.serialNumber));
    }

    this.noteMissingAccessories(activeUuids);
    return statuses;
  }

  ensureAccessory(status, deviceCount) {
    const serialNumber = String(status.serialNumber || '').trim();
    if (!serialNumber) {
      throw new Error('Whisker API device did not include a serial number');
    }
    const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}-${serialNumber}`);
    let accessory = this.accessories.get(uuid);

    // Preserve a pre-1.1 cached accessory whose UUID included the site ID.
    if (!accessory) {
      const legacyUuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}-${status.siteId}-${serialNumber}`);
      accessory = this.accessories.get(legacyUuid);
    }

    if (!accessory) {
      accessory = new this.api.platformAccessory(
        this.accessoryName(status, deviceCount),
        uuid,
      );
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(accessory.UUID, accessory);
      this.log.info('Added Ting accessory:', accessory.displayName);
    } else if (!this.configuredAccessories.has(accessory.UUID)) {
      this.log.info('Restored Ting accessory from cache:', accessory.displayName);
    }

    return accessory;
  }

  accessoryName(status, deviceCount) {
    if (deviceCount <= 1) {
      return this.config.name || status.siteName || status.deviceName || 'Ting';
    }

    const location = status.siteName || 'Ting Site';
    const device = status.deviceName && status.deviceName !== 'Ting'
      ? status.deviceName
      : status.serialNumber;
    const label = `${location} - ${device}`;
    return this.config.name ? `${this.config.name} - ${label}` : label;
  }

  startTelemetryHeartbeat() {
    if (this.telemetryHeartbeatTimer) {
      return;
    }
    this.telemetryHeartbeatTimer = setInterval(() => {
      this.telemetry.recordHeartbeat().catch((error) => {
        this.log.debug('Failed to record anonymous Ting telemetry heartbeat:', error.message);
      });
    }, TELEMETRY_HEARTBEAT_INTERVAL_MS);
  }

  schedulePoll(delayMs) {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    const delay = Math.max(1_000, Math.round(delayMs + this.jitterMs(delayMs)));
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.poll().catch((error) => {
        this.log.error('Unexpected Ting poll failure:', error.message);
        this.schedulePoll(this.nextRetryDelayMs);
      });
    }, delay);
  }

  jitterMs(delayMs) {
    return (Math.random() * 2 - 1) * delayMs * POLL_JITTER_RATIO;
  }

  async poll() {
    if (this.pollInFlight) {
      this.schedulePoll(this.pollIntervalMs);
      return;
    }

    this.pollInFlight = true;
    try {
      const statuses = await this.refreshStatuses();
      if (!this.started) {
        await this.completeStartup(statuses);
      } else {
        this.nextRetryDelayMs = STARTUP_RETRY_INITIAL_MS;
        this.schedulePoll(this.pollIntervalMs);
      }
    } catch (error) {
      this.handlePollFailure(error);
      this.schedulePoll(this.nextRetryDelayMs);
      this.nextRetryDelayMs = Math.min(this.nextRetryDelayMs * 2, MAX_RETRY_DELAY_MS);
    } finally {
      this.pollInFlight = false;
    }
  }

  handlePollFailure(error) {
    this.consecutivePollFailures += 1;
    this.lastPollError = error?.message || String(error);
    this.log.warn(
      `Failed to poll Ting status (${this.consecutivePollFailures}): ${this.lastPollError}`,
    );

    if (this.consecutivePollFailures >= OFFLINE_AFTER_FAILURES) {
      const wasOnline = this.apiOnline;
      this.apiOnline = false;
      for (const uuid of this.accessories.keys()) {
        this.accessoryOnlineByUuid.set(uuid, false);
      }
      if (wasOnline) {
        this.log.warn('Ting API marked offline after consecutive poll failures');
      }
      for (const accessory of this.accessories.values()) {
        this.updateConnectivity(accessory);
      }
    }
  }

  markOnline() {
    if (!this.apiOnline) {
      this.log.info('Ting API is online again');
    }
    this.apiOnline = true;
    this.consecutivePollFailures = 0;
    this.lastPollError = null;
  }

  stopTimers() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.telemetryHeartbeatTimer) {
      clearInterval(this.telemetryHeartbeatTimer);
      this.telemetryHeartbeatTimer = null;
    }
  }

  bindConnectivityGets(service, accessory) {
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
    // Keep the parameter in the signature to make the per-accessory binding explicit.
    void accessory;
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

    for (const sensor of HAZARD_SENSORS) {
      const service = this.getHazardService(accessory, sensor);
      service
        .getCharacteristic(this.hazardCharacteristic(sensor))
        .onGet(() => this.hazardValue(sensor, Boolean(this.statusByUuid.get(accessory.UUID)?.[sensor.key])));
      this.bindConnectivityGets(service, accessory);
    }

    const learning = this.getOrAddService(accessory, this.Service.OccupancySensor, SERVICE_NAMES.learningMode, HAP_LEARNING_MODE_SUBTYPE);
    learning
      .getCharacteristic(this.Characteristic.OccupancyDetected)
      .onGet(() => this.statusByUuid.get(accessory.UUID)?.learningMode
        ? this.Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
        : this.Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
    this.bindConnectivityGets(learning, accessory);
  }

  updateConnectivity(accessory) {
    const active = this.accessoryOnlineByUuid.get(accessory.UUID) ?? this.apiOnline;
    const fault = active
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

  /** True when this alert sensor is exposed as a HomeKit smoke sensor. */
  usesSmokeSensor(sensor) {
    return !sensor.smokeConfigKey || this.config[sensor.smokeConfigKey] === true;
  }

  getHazardService(accessory, sensor) {
    const serviceType = this.usesSmokeSensor(sensor) ? this.Service.SmokeSensor : this.Service.ContactSensor;
    return this.getOrAddService(accessory, serviceType, sensor.name, sensor.subtype);
  }

  hazardCharacteristic(sensor) {
    return this.usesSmokeSensor(sensor)
      ? this.Characteristic.SmokeDetected
      : this.Characteristic.ContactSensorState;
  }

  hazardValue(sensor, active) {
    if (this.usesSmokeSensor(sensor)) {
      return active
        ? this.Characteristic.SmokeDetected.SMOKE_DETECTED
        : this.Characteristic.SmokeDetected.SMOKE_NOT_DETECTED;
    }
    // Contact polarity: open (not detected) = alert active.
    return active
      ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
      : this.Characteristic.ContactSensorState.CONTACT_DETECTED;
  }

  /**
   * Log alerts starting and clearing at normal log levels. On the first status after
   * startup there is no previous state, so an alert that is already active is logged
   * as active and nothing is logged for alerts that are clear.
   */
  logStatusChanges(accessory, previous, status) {
    const name = accessory.displayName;
    for (const sensor of HAZARD_SENSORS) {
      const active = Boolean(status[sensor.key]);
      const wasActive = Boolean(previous?.[sensor.key]);
      if (active && !wasActive) {
        const message = sensor.message(status);
        const detail = message && message !== NO_HAZARD_MESSAGE ? `: ${message}` : '';
        const when = previous ? '' : ' (already active at startup)';
        this.log.warn(`${name}: ${sensor.label} ACTIVE${when}${detail}. Check the Ting app.`);
      } else if (!active && wasActive) {
        this.log.info(`${name}: ${sensor.label} cleared`);
      }
    }

    const learning = Boolean(status.learningMode);
    if (!previous) {
      if (learning) {
        this.log.info(`${name}: Ting is in learning mode`);
      }
    } else if (learning !== Boolean(previous.learningMode)) {
      this.log.info(`${name}: Ting ${learning ? 'entered' : 'left'} learning mode`);
    }
  }

  updateServices(accessory, status) {
    for (const sensor of HAZARD_SENSORS) {
      this.getHazardService(accessory, sensor)
        .updateCharacteristic(this.hazardCharacteristic(sensor), this.hazardValue(sensor, Boolean(status[sensor.key])));
    }

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
      `Ting status: device=${status.serialNumber}, hazard=${status.hazardStatus}, fire=${status.fireHazard}, ` +
      `efh=${status.electricalFireHazard}/${status.efhStatus}/${status.efhLevel}, ` +
      `ufh=${status.utilityFireHazard}/${status.ufhStatus}/${status.ufhLevel}, ` +
      `powerQuality=${status.powerQualityHazard}, learning=${status.learningMode}, ` +
      `reviewedNotFire=${status.reviewedNotFire}, online=${this.apiOnline}`,
    );
  }

  recordTelemetryStatus(status, deviceSlot) {
    this.telemetry.recordStatus(status, { deviceSlot }).catch((error) => {
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

  noteMissingAccessories(activeUuids) {
    for (const [uuid, accessory] of this.accessories.entries()) {
      if (activeUuids.has(uuid)) {
        this.missingAccessoryCounts.delete(uuid);
        continue;
      }

      const missingCount = (this.missingAccessoryCounts.get(uuid) || 0) + 1;
      this.missingAccessoryCounts.set(uuid, missingCount);
      this.accessoryOnlineByUuid.set(uuid, false);
      this.updateConnectivity(accessory);
      if (missingCount === MISSING_ACCESSORY_WARNING_THRESHOLD) {
        this.log.warn(
          `Ting device accessory is absent from ${missingCount} consecutive successful responses; retaining cached accessory: ${accessory.displayName}`,
        );
      }
    }
  }
}
