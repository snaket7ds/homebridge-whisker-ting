import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import os from 'node:os';

const DEFAULT_STATE_FILE = 'whisker-ting-telemetry.json';
const DEFAULT_TIMEOUT_MS = 5000;
export const DEFAULT_TELEMETRY_ENDPOINT_URL = 'https://hwt.rod-81a.workers.dev/events';

export class TelemetryClient {
  constructor({
    enabled = false,
    endpointUrl = DEFAULT_TELEMETRY_ENDPOINT_URL,
    pluginVersion = '0.0.0',
    homebridgeVersion = '',
    storagePath = '',
    fetchImpl = fetch,
    now = () => new Date(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    log,
  } = {}) {
    this.enabled = Boolean(enabled);
    this.endpointUrl = typeof endpointUrl === 'string' ? endpointUrl.trim() : '';
    this.pluginVersion = pluginVersion;
    this.homebridgeVersion = homebridgeVersion;
    this.storagePath = storagePath;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.state = null;
  }

  async initialize() {
    if (!this.canSend()) {
      return;
    }

    const state = await this.loadState();
    if (!state.installId) {
      state.installId = randomUUID().replaceAll('-', '');
      await this.saveState(state);
    }

    if (!state.installReported) {
      if (await this.sendEvent('plugin_install')) {
        state.installReported = true;
        await this.saveState(state);
      }
    }

    await this.sendEvent('plugin_start');
  }

  async recordStatus(status) {
    if (!this.canSend()) {
      return false;
    }

    const state = await this.loadState();
    const now = this.now();
    const statusKey = [
      status.hazardStatus,
      status.fireHazard,
      status.electricalFireHazard,
      status.utilityFireHazard,
      status.powerQualityHazard,
      status.learningMode,
    ].join('|');

    if (
      state.lastStatusKey === statusKey
      && state.lastStatusSentAt
      && now.getTime() - Date.parse(state.lastStatusSentAt) < 24 * 60 * 60 * 1000
    ) {
      return false;
    }

    if (await this.sendEvent('status_update', {
      hazard_status: status.hazardStatus || 'unknown',
      fire_hazard: Boolean(status.fireHazard),
      electrical_fire_hazard: Boolean(status.electricalFireHazard),
      utility_fire_hazard: Boolean(status.utilityFireHazard),
      power_quality_hazard: Boolean(status.powerQualityHazard),
      learning_mode: Boolean(status.learningMode),
      efh_level: nonNegativeIntegerOrNull(status.efhLevel),
      ufh_level: nonNegativeIntegerOrNull(status.ufhLevel),
    })) {
      state.lastStatusKey = statusKey;
      state.lastStatusSentAt = now.toISOString();
      await this.saveState(state);
      return true;
    }

    return false;
  }

  async sendEvent(eventType, data = {}) {
    if (!this.canSend()) {
      return false;
    }

    try {
      const state = await this.loadState();
      if (!state.installId) {
        state.installId = randomUUID().replaceAll('-', '');
        await this.saveState(state);
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(this.endpointUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'user-agent': `homebridge-whisker-ting/${this.pluginVersion}`,
          },
          body: JSON.stringify({
            eventType,
            installId: state.installId,
            pluginVersion: this.pluginVersion,
            nodeVersion: process.version,
            platform: os.platform(),
            arch: os.arch(),
            homebridgeVersion: this.homebridgeVersion,
            sentAtUtc: this.now().toISOString(),
            data,
          }),
          signal: controller.signal,
        });

        return response.ok;
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      this.log?.debug?.('Anonymous telemetry event failed:', error.message);
      return false;
    }
  }

  canSend() {
    return this.enabled && Boolean(this.endpointUrl);
  }

  async loadState() {
    if (this.state) {
      return this.state;
    }

    const statePath = this.getStatePath();
    try {
      this.state = JSON.parse(await readFile(statePath, 'utf8'));
    } catch {
      this.state = {};
    }

    return this.state;
  }

  async saveState(state) {
    const statePath = this.getStatePath();
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  getStatePath() {
    return join(this.storagePath || process.cwd(), DEFAULT_STATE_FILE);
  }
}

function nonNegativeIntegerOrNull(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}
