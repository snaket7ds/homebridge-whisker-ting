import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import AmazonCognitoIdentity from 'amazon-cognito-identity-js';

const {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  CognitoRefreshToken,
} = AmazonCognitoIdentity;

const DEFAULT_API_BASE = 'https://api.wskr.io/api/v1';
const COGNITO_USER_POOL_ID = 'us-east-1_trW4gH661';
const COGNITO_CLIENT_ID = '4akjeqt9gtl8rgg1cksunipk9u';
const AUTH_STATE_FILE = 'whisker-ting-auth.json';
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
export const DEFAULT_AUTH_TIMEOUT_MS = 20_000;
/** Refresh access token this long before JWT expiry. */
export const CREDENTIAL_REFRESH_SKEW_MS = 60_000;

export class CognitoAuthProvider {
  constructor({
    username,
    password,
    userPoolId = COGNITO_USER_POOL_ID,
    clientId = COGNITO_CLIENT_ID,
  }) {
    this.username = username;
    this.password = password;
    this.userPool = new CognitoUserPool({
      UserPoolId: userPoolId,
      ClientId: clientId,
    });
  }

  async getCredentials() {
    if (!this.username || !this.password) {
      throw new Error('Missing Whisker username or password');
    }

    const cognitoUser = new CognitoUser({
      Username: this.username,
      Pool: this.userPool,
    });
    const authDetails = new AuthenticationDetails({
      Username: this.username,
      Password: this.password,
    });

    const session = await authenticateUser(cognitoUser, authDetails);
    const attributes = await getUserAttributes(cognitoUser);
    const userId = attributes['custom:user_id'];
    const apiKey = attributes['custom:api_key'];

    if (!userId || !apiKey) {
      throw new Error('Whisker login did not return user ID and API key attributes');
    }

    return credentialsFromSession(session, { userId, apiKey });
  }

  /**
   * Refresh access token using a stored Cognito refresh token.
   * Keeps cached userId/apiKey from the previous login.
   */
  async refreshCredentials(cached) {
    if (!this.username || !cached?.refreshToken || !cached?.userId || !cached?.apiKey) {
      throw new Error('Cannot refresh Whisker credentials without a stored refresh token');
    }

    const cognitoUser = new CognitoUser({
      Username: this.username,
      Pool: this.userPool,
    });
    const refreshToken = new CognitoRefreshToken({ RefreshToken: cached.refreshToken });
    const session = await refreshSession(cognitoUser, refreshToken);
    return credentialsFromSession(session, {
      userId: cached.userId,
      apiKey: cached.apiKey,
    });
  }
}

/** True if cached credentials can still be used (with a refresh skew). */
export function credentialsStillValid(credentials, now = Date.now(), skewMs = CREDENTIAL_REFRESH_SKEW_MS) {
  if (!credentials?.accessToken || !credentials?.apiKey || !credentials?.userId) {
    return false;
  }

  // Legacy / test credentials without expiry stay until a 401 clears them.
  if (!credentials.expiresAt) {
    return true;
  }

  return now < credentials.expiresAt - skewMs;
}

/**
 * Disk-backed Cognito credential cache (access + refresh tokens, api key, user id).
 * Scoped to the Whisker username so password/account switches do not reuse tokens.
 */
export class CredentialStore {
  constructor(storagePath, { filename = AUTH_STATE_FILE } = {}) {
    this.storagePath = storagePath || '';
    this.filename = filename;
  }

  get path() {
    return join(this.storagePath || process.cwd(), this.filename);
  }

  async load() {
    if (!this.storagePath) {
      return null;
    }

    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8'));
      if (!raw || typeof raw !== 'object') {
        return null;
      }
      return raw;
    } catch {
      return null;
    }
  }

  async save(credentials) {
    if (!this.storagePath || !credentials) {
      return;
    }

    await mkdir(this.storagePath, { recursive: true });
    const payload = {
      username: credentials.username || '',
      accessToken: credentials.accessToken || '',
      refreshToken: credentials.refreshToken || '',
      expiresAt: credentials.expiresAt ?? null,
      userId: credentials.userId || '',
      apiKey: credentials.apiKey || '',
      savedAt: new Date().toISOString(),
    };
    const temporaryPath = `${this.path}.tmp-${process.pid}`;
    await writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, this.path);
  }

  async clear() {
    if (!this.storagePath) {
      return;
    }

    try {
      await unlink(this.path);
    } catch {
      // ignore missing file
    }
  }
}

export class WhiskerClient {
  constructor({
    username,
    password,
    apiBase = DEFAULT_API_BASE,
    fetchImpl = fetch,
    authProvider,
    storagePath = '',
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    authTimeoutMs = DEFAULT_AUTH_TIMEOUT_MS,
    credentialStore,
    log,
  } = {}) {
    this.username = typeof username === 'string' ? username.trim() : '';
    this.password = typeof password === 'string' ? password : '';
    this.apiBase = apiBase.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = Math.max(Number(requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS, 1_000);
    this.authTimeoutMs = Math.max(Number(authTimeoutMs) || DEFAULT_AUTH_TIMEOUT_MS, 1_000);
    this.log = log;
    this.authProvider = authProvider || (this.username || this.password
      ? new CognitoAuthProvider({ username: this.username, password: this.password })
      : null);
    this.credentialStore = credentialStore
      ?? (storagePath ? new CredentialStore(storagePath) : null);
    this.credentials = null;
    this.credentialsPromise = null;
  }

  async getStatus() {
    const statuses = await this.getStatuses();
    if (!statuses[0]) {
      throw new Error('Whisker API response did not include any devices');
    }
    return statuses[0];
  }

  async getStatuses() {
    return this.fetchStatuses();
  }

  async fetchStatus(hasRetried = false) {
    const statuses = await this.fetchStatuses(hasRetried);
    return statuses[0];
  }

  async fetchStatuses(hasRetried = false) {
    const credentials = await this.getCredentials();

    const response = await this.fetchImplWithTimeout(`${this.apiBase}/Users/${encodeURIComponent(credentials.userId)}`, {
      method: 'GET',
      headers: buildWhiskerHeaders(credentials),
    });

    if (response.status === 401 && this.authProvider && !hasRetried) {
      await this.clearCredentials();
      return this.fetchStatuses(true);
    }

    if (!response.ok) {
      throw new Error(`Whisker API returned ${response.status}`);
    }

    const data = await response.json();
    return normalizeWhiskerStatuses(data);
  }

  async fetchImplWithTimeout(url, options) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await this.fetchImpl(url, { ...options, signal: controller.signal });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new Error(`Whisker API request timed out after ${this.requestTimeoutMs / 1000}s`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getCredentials() {
    if (credentialsStillValid(this.credentials)) {
      return this.credentials;
    }
    if (!this.credentialsPromise) {
      this.credentialsPromise = this.resolveCredentials();
    }
    try {
      return await this.credentialsPromise;
    } finally {
      this.credentialsPromise = null;
    }
  }

  async resolveCredentials() {
    // Try persisted session before a full password login.
    const cached = await this.loadStoredCredentials();
    if (credentialsStillValid(cached)) {
      this.credentials = cached;
      this.log?.debug?.('Using stored Whisker credentials');
      return this.credentials;
    }

    if (cached?.refreshToken && this.authProvider?.refreshCredentials) {
      try {
        this.credentials = await promiseWithTimeout(
          this.authProvider.refreshCredentials(cached),
          this.authTimeoutMs,
          'Whisker token refresh',
        );
        this.credentials.username = this.username;
        await this.persistCredentials(this.credentials);
        this.log?.debug?.('Refreshed Whisker access token from stored refresh token');
        return this.credentials;
      } catch (error) {
        this.log?.debug?.(`Whisker token refresh failed, logging in again: ${error.message}`);
        await this.credentialStore?.clear();
      }
    }

    this.credentials = null;

    if (!this.authProvider) {
      throw new Error('Missing Whisker username or password');
    }

    this.credentials = await promiseWithTimeout(
      this.authProvider.getCredentials(),
      this.authTimeoutMs,
      'Whisker authentication',
    );
    this.credentials.username = this.username;
    await this.persistCredentials(this.credentials);
    return this.credentials;
  }

  async loadStoredCredentials() {
    if (!this.credentialStore || !this.username) {
      return null;
    }

    const cached = await this.credentialStore.load();
    if (!cached || cached.username !== this.username) {
      return null;
    }

    return cached;
  }

  async persistCredentials(credentials) {
    if (!this.credentialStore || !credentials) {
      return;
    }

    try {
      await this.credentialStore.save({
        ...credentials,
        username: this.username,
      });
    } catch (error) {
      this.log?.debug?.(`Could not persist Whisker credentials: ${error.message}`);
    }
  }

  async clearCredentials() {
    this.credentials = null;
    try {
      await this.credentialStore?.clear();
    } catch {
      // ignore
    }
  }
}

function promiseWithTimeout(promise, timeoutMs, operation) {
  let timeout;
  const timeoutPromise = new Promise((resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${operation} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

function credentialsFromSession(session, { userId, apiKey }) {
  const accessToken = session.getAccessToken();
  // getExpiration() is seconds since epoch (Cognito JWT).
  const expiresAt = Number(accessToken.getExpiration?.() || 0) * 1000;
  const refreshToken = session.getRefreshToken?.()?.getToken?.() || '';

  return {
    accessToken: accessToken.getJwtToken(),
    refreshToken: refreshToken || '',
    expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt : null,
    userId,
    apiKey,
  };
}

function authenticateUser(cognitoUser, authDetails) {
  return new Promise((resolve, reject) => {
    cognitoUser.authenticateUser(authDetails, {
      onSuccess: resolve,
      onFailure: reject,
      newPasswordRequired: () => reject(new Error('Whisker account requires a new password before Homebridge can log in')),
      mfaRequired: () => reject(new Error('Whisker account requires MFA, which this plugin does not support')),
      totpRequired: () => reject(new Error('Whisker account requires TOTP MFA, which this plugin does not support')),
    });
  });
}

function refreshSession(cognitoUser, refreshToken) {
  return new Promise((resolve, reject) => {
    cognitoUser.refreshSession(refreshToken, (error, session) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(session);
    });
  });
}

function getUserAttributes(cognitoUser) {
  return new Promise((resolve, reject) => {
    cognitoUser.getUserAttributes((error, attributes) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(Object.fromEntries(
        (attributes || []).map((attribute) => [attribute.getName(), attribute.getValue()]),
      ));
    });
  });
}

function buildWhiskerHeaders(credentials) {
  const headers = {
    Accept: 'application/json',
    'x-wl-api-key': credentials.apiKey,
  };

  if (credentials.accessToken) {
    headers.Authorization = `Bearer ${credentials.accessToken}`;
  }

  return headers;
}

export function normalizeWhiskerStatuses(data) {
  const sites = Array.isArray(data?.sites) ? data.sites : [];
  const devices = Array.isArray(data?.devices) ? data.devices : [];

  if (!sites.length) {
    throw new Error('Whisker API response did not include a site');
  }
  if (!devices.length) {
    throw new Error('Whisker API response did not include a device');
  }

  return devices.map((device) => normalizeWhiskerStatus({
    ...data,
    devices: [device],
  }));
}

export function normalizeWhiskerStatus(data) {
  const device = data?.devices?.[0];
  const site = (data?.sites || []).find((candidate) => (
    String(candidate.id) === String(device?.siteId)
  )) || data?.sites?.[0];

  if (!site) {
    throw new Error('Whisker API response did not include a site');
  }
  if (!device) {
    throw new Error('Whisker API response did not include a device');
  }

  const fireHazardStatus = device.fireHazardStatus || {};
  const efhStatus = normalizeHazardStatus(fireHazardStatus.efhStatus);
  const ufhStatus = normalizeHazardStatus(fireHazardStatus.ufhStatus);
  const learningMode = Boolean(device.learningMode || fireHazardStatus.learningMode);
  const electricalFireHazard = isActiveElectricalFireHazard(efhStatus);
  const utilityFireHazard = isActiveHazard(ufhStatus);
  const fireHazard = Boolean(device.isFire);
  const reviewedNotFire = efhStatus.status === 'ReviewedNotFire' || efhStatus.status === 'ReviewedSuspicious';
  const hazardStatus = getHazardStatus({
    fireHazard,
    electricalFireHazard,
    utilityFireHazard,
    efhStatus,
    learningMode,
  });

  return {
    userId: data.user_id,
    siteId: site.id,
    siteName: site.displayName || 'Ting Site',
    siteAddress: formatAddress(site),
    timezone: site.timeZone,
    deviceName: device.name || device.serialNumber || 'Ting',
    deviceType: device.type || 'Ting',
    serialNumber: device.serialNumber || String(device.id || site.id || 'unknown'),
    model: device.type || 'Ting',
    firmwareRevision: device.version,
    wifiMacAddress: reverseMacAddress(device.wifiMacAddress ?? device.wifi_mac_address),
    bluetoothMacAddress: reverseMacAddress(device.bluetoothMacAddress ?? device.bluetooth_mac_address),
    socSerialNumber: device.socSerialNumber,
    groupName: device.group?.name,
    groupId: device.group?.id,
    learningMode,
    hvacVerified: Boolean(device.isHvacVerified),
    frozenPipe: Boolean(device.hasFrozenPipe),
    owner: Boolean(device.isOwner),
    apiKeyUpdateAllowed: Boolean(device.allowApiKeyUpdate),
    powerQualityHazard: Boolean(site.isPowerQualityHazard),
    fireHazard,
    electricalFireHazard,
    utilityFireHazard,
    reviewedNotFire,
    hazardStatus,
    hazardMessage: fireHazardStatus.message || 'No Hazards Detected',
    efhStatus: efhStatus.status,
    efhMessage: efhStatus.message,
    efhLevel: efhStatus.level,
    efhTimestampUtc: efhStatus.timestampUtc,
    ufhStatus: ufhStatus.status,
    ufhMessage: ufhStatus.message,
    ufhLevel: ufhStatus.level,
    ufhTimestampUtc: ufhStatus.timestampUtc,
  };
}

function normalizeHazardStatus(status = {}) {
  return {
    status: status.status || 'none',
    message: status.message || 'No Hazards Detected',
    level: numberOrNull(status.level),
    timestampUtc: status.timestampUtc || null,
    hexColor: status.hexColor || '#00FF00',
  };
}

function reverseMacAddress(address) {
  if (typeof address !== 'string') {
    return address ?? null;
  }

  const separator = address.includes(':') ? ':' : (address.includes('-') ? '-' : null);
  if (!separator) {
    return address;
  }

  const parts = address.split(separator);
  if (parts.length !== 6 || parts.some((part) => part.length !== 2)) {
    return address;
  }

  return parts.reverse().map((part) => part.toLowerCase()).join(separator);
}

function isActiveElectricalFireHazard(status) {
  // ReviewedNotFire is excluded even when level > 0
  if (status.status === 'ReviewedNotFire') return false;

  return isActiveHazard(status);
}

function isActiveHazard(status) {
  return isActiveStatus(status.status) && Number.isFinite(status.level) && status.level > 0;
}

function isActiveStatus(status) {
  if (!status || status === 'none' || status === 'normal') {
    return false;
  }
  if (status === 'ReviewedNotFire' || status === 'ReviewedSuspicious') {
    return false;
  }
  return true;
}

function getHazardStatus({
  fireHazard,
  electricalFireHazard,
  utilityFireHazard,
  efhStatus,
  learningMode,
}) {
  if (learningMode) {
    return 'learning';
  }
  if (fireHazard || electricalFireHazard || utilityFireHazard) {
    return 'hazard_detected';
  }
  if (efhStatus.status === 'ReviewedNotFire' || efhStatus.status === 'ReviewedSuspicious') {
    return 'reviewed_not_fire';
  }
  return 'no_hazards';
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatAddress(site) {
  return [
    site.addressLine1,
    site.addressLine2,
    site.city,
    site.stateProvince,
    site.postalCode,
  ].filter(Boolean).join(' ');
}
