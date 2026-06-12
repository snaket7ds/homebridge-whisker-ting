import AmazonCognitoIdentity from 'amazon-cognito-identity-js';

const {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
} = AmazonCognitoIdentity;

const DEFAULT_API_BASE = 'https://api.wskr.io/api/v1';
const COGNITO_USER_POOL_ID = 'us-east-1_trW4gH661';
const COGNITO_CLIENT_ID = '4akjeqt9gtl8rgg1cksunipk9u';

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

    return {
      accessToken: session.getAccessToken().getJwtToken(),
      userId,
      apiKey,
    };
  }
}

export class WhiskerClient {
  constructor({
    username,
    password,
    apiBase = DEFAULT_API_BASE,
    fetchImpl = fetch,
    authProvider,
  }) {
    this.username = username;
    this.password = password;
    this.apiBase = apiBase.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.authProvider = authProvider || (username || password
      ? new CognitoAuthProvider({ username, password })
      : null);
    this.credentials = null;
  }

  async getStatus() {
    return this.fetchStatus();
  }

  async fetchStatus(hasRetried = false) {
    const credentials = await this.getCredentials();

    const response = await this.fetchImpl(`${this.apiBase}/Users/${encodeURIComponent(credentials.userId)}`, {
      method: 'GET',
      headers: buildWhiskerHeaders(credentials),
    });

    if (response.status === 401 && this.authProvider && !hasRetried) {
      this.credentials = null;
      return this.fetchStatus(true);
    }

    if (!response.ok) {
      throw new Error(`Whisker API returned ${response.status}`);
    }

    const data = await response.json();
    return normalizeWhiskerStatus(data);
  }

  async getCredentials() {
    if (this.credentials) {
      return this.credentials;
    }

    if (!this.authProvider) {
      throw new Error('Missing Whisker username or password');
    }

    this.credentials = await this.authProvider.getCredentials();
    return this.credentials;
  }
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

export function normalizeWhiskerStatus(data) {
  const site = data?.sites?.[0];
  const device = data?.devices?.[0];

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
    wifiMacAddress: device.wifiMacAddress,
    bluetoothMacAddress: device.bluetoothMacAddress,
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
