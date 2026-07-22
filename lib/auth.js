const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const {applyRateLimitBuffer} = require('./rate');
const {fetchSpreadsheetValuesBatch} = require('./sheets');

function getConfigBaseDir(config) {
  const configPath = config && (config.__configPath || config.configPath);
  if (configPath) {
    return path.dirname(configPath);
  }

  return process.cwd();
}

function resolveConfigPath(config, candidatePath) {
  if (!candidatePath) {
    return '';
  }

  if (path.isAbsolute(candidatePath)) {
    return candidatePath;
  }

  return path.resolve(getConfigBaseDir(config), candidatePath);
}

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function createServiceAccountAuthClient(credentials) {
  const scopes = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
  const tokenUri = credentials.token_uri || 'https://oauth2.googleapis.com/token';
  const tokenCache = {accessToken: '', expiryDate: 0};

  async function requestAccessToken() {
    if (!credentials.client_email || !credentials.private_key) {
      throw new Error('Service account credentials must include client_email and private_key');
    }

    const now = Math.floor(Date.now() / 1000);
    const header = {alg: 'RS256', typ: 'JWT'};
    const payload = {
      iss: credentials.client_email,
      scope: scopes.join(' '),
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    };
    const unsignedToken = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(unsignedToken);
    signer.end();
    const signature = signer.sign(credentials.private_key);
    const assertion = `${unsignedToken}.${base64UrlEncode(signature)}`;
    const body = `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${encodeURIComponent(assertion)}`;

    const tokenUrl = new URL(tokenUri);
    const requestOptions = {
      protocol: tokenUrl.protocol,
      hostname: tokenUrl.hostname,
      port: tokenUrl.port || 443,
      method: 'POST',
      path: `${tokenUrl.pathname}${tokenUrl.search}`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const responseBody = await new Promise((resolve, reject) => {
      const request = https.request(requestOptions, response => {
        let responseText = '';
        response.setEncoding('utf8');

        response.on('data', chunk => {
          responseText += chunk;
        });

        response.on('end', () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            resolve(responseText);
            return;
          }

          let message = `Token request failed with status ${response.statusCode}`;
          try {
            const parsed = JSON.parse(responseText);
            if (parsed && parsed.error && parsed.error_description) {
              message = `${parsed.error}: ${parsed.error_description}`;
            } else if (parsed && parsed.error && parsed.error.message) {
              message = parsed.error.message;
            }
          } catch (_) {
            if (responseText) {
              message = responseText;
            }
          }

          reject(new Error(message));
        });
      });

      request.on('error', reject);
      request.write(body);
      request.end();
    });

    const tokenData = JSON.parse(responseBody);
    if (!tokenData.access_token) {
      throw new Error('Token response did not include access_token');
    }

    tokenCache.accessToken = tokenData.access_token;
    tokenCache.expiryDate = Date.now() + Math.max(0, (tokenData.expires_in || 3600) - 60) * 1000;
    return tokenData.access_token;
  }

  return {
    scopes,
    async getAccessToken() {
      if (tokenCache.accessToken && Date.now() < tokenCache.expiryDate) {
        return {token: tokenCache.accessToken, expiry_date: tokenCache.expiryDate};
      }

      const accessToken = await requestAccessToken();
      return {token: accessToken, expiry_date: tokenCache.expiryDate};
    },
    async getRequestHeaders() {
      const token = await this.getAccessToken();
      return {Authorization: `Bearer ${token.token}`};
    },
  };
}

function readServiceAccountCredentials(resolvedPath) {
  try {
    const raw = fs.readFileSync(resolvedPath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Failed to read/parse service account credentials at ${resolvedPath}: ${e.message}`);
  }
}

function loadApiKeys(config) {
  const apiKeys = [];
  const defaultRateLimit = config.rateLimitPerMinute || 50;

  if (Array.isArray(config.apiKeys)) {
    for (const entry of config.apiKeys) {
      if (typeof entry === 'string') {
        apiKeys.push({key: entry, rateLimitPerMinute: defaultRateLimit});
      } else if (entry && typeof entry === 'object') {
        if (!entry.key) {
          throw new Error('Each entry in `apiKeys` must include `key`');
        }
        apiKeys.push({
          key: entry.key,
          rateLimitPerMinute: entry.rateLimitPerMinute || defaultRateLimit,
        });
      } else {
        throw new Error('`apiKeys` entries must be strings or objects');
      }
    }
  }

  return apiKeys;
}

function loadServiceAccounts(config) {
  const accounts = [];
  const defaultRateLimit = config.rateLimitPerMinute || 50;

  if (!Array.isArray(config.serviceAccounts)) {
    return accounts;
  }

  for (const entry of config.serviceAccounts) {
    if (typeof entry === 'string') {
      accounts.push({path: entry, rateLimitPerMinute: defaultRateLimit});
    } else if (entry && typeof entry === 'object') {
      if (!entry.path && !entry.credentialsPath) {
        throw new Error('Each entry in `serviceAccounts` must include `path` (or `credentialsPath`)');
      }
      const p = entry.path || entry.credentialsPath;
      accounts.push({path: p, rateLimitPerMinute: entry.rateLimitPerMinute || defaultRateLimit});
    } else {
      throw new Error('`serviceAccounts` entries must be strings or objects');
    }
  }

  return accounts;
}

function createServiceAccountBatchFetcher(config) {
  const accounts = loadServiceAccounts(config);
  if (accounts.length === 0) return null;
  // Build raw fetchers and track next available timestamps to allow
  // selecting a credential whose slot is available now. If none are
  // immediately available, wait the minimum required time.
  const fetchers = accounts.map(({path: credentialsPath, rateLimitPerMinute}) => {
    const resolvedPath = resolveConfigPath(config, credentialsPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Service account credentials not found: ${resolvedPath}`);
    }
    const credentials = readServiceAccountCredentials(resolvedPath);
    const authClient = createServiceAccountAuthClient(credentials);

    const bufferedRateLimit = applyRateLimitBuffer(rateLimitPerMinute);
    const interval = Math.ceil(60000 / bufferedRateLimit);

    const fetchRaw = async (documentId, sheetNames) => {
      return fetchSpreadsheetValuesBatch({authClient}, documentId, sheetNames);
    };

    return {authClient, fetchRaw, interval, nextAvailable: 0};
  });

  let currentIndex = 0;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  return async (documentId, sheetNames) => {
    const now = () => Date.now();

    // Try to find an available worker without blocking; check each worker once
    for (let i = 0; i < fetchers.length; i += 1) {
      const idx = (currentIndex + i) % fetchers.length;
      const worker = fetchers[idx];
      if (now() >= worker.nextAvailable) {
        currentIndex = (idx + 1) % fetchers.length;
        worker.nextAvailable = now() + worker.interval;
        return worker.fetchRaw(documentId, sheetNames);
      }
    }

    // If none available immediately, pick the earliest one and wait until it's free
    let earliestIdx = 0;
    let earliestTime = fetchers[0].nextAvailable;
    for (let i = 1; i < fetchers.length; i += 1) {
      if (fetchers[i].nextAvailable < earliestTime) {
        earliestTime = fetchers[i].nextAvailable;
        earliestIdx = i;
      }
    }

    const waitMs = Math.max(0, earliestTime - now());
    if (waitMs > 0) await sleep(waitMs);

    // After waiting, reserve the slot and call
    const worker = fetchers[earliestIdx];
    currentIndex = (earliestIdx + 1) % fetchers.length;
    worker.nextAvailable = now() + worker.interval;
    return worker.fetchRaw(documentId, sheetNames);
  };
}

function createApiKeyBatchFetcher(config) {
  const apiKeys = loadApiKeys(config);
  if (apiKeys.length === 0) {
    return null;
  }
  const fetchers = apiKeys.map(({key, rateLimitPerMinute}) => {
    const bufferedRateLimit = applyRateLimitBuffer(rateLimitPerMinute);
    const interval = Math.ceil(60000 / bufferedRateLimit);

    const fetchRaw = async (documentId, sheetNames) => {
      return fetchSpreadsheetValuesBatch({apiKey: key}, documentId, sheetNames);
    };

    return {key, fetchRaw, interval, nextAvailable: 0};
  });

  let currentIndex = 0;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  return async (documentId, sheetNames) => {
    const now = () => Date.now();

    for (let i = 0; i < fetchers.length; i += 1) {
      const idx = (currentIndex + i) % fetchers.length;
      const worker = fetchers[idx];
      if (now() >= worker.nextAvailable) {
        currentIndex = (idx + 1) % fetchers.length;
        worker.nextAvailable = now() + worker.interval;
        return worker.fetchRaw(documentId, sheetNames);
      }
    }

    let earliestIdx = 0;
    let earliestTime = fetchers[0].nextAvailable;
    for (let i = 1; i < fetchers.length; i += 1) {
      if (fetchers[i].nextAvailable < earliestTime) {
        earliestTime = fetchers[i].nextAvailable;
        earliestIdx = i;
      }
    }

    const waitMs = Math.max(0, earliestTime - now());
    if (waitMs > 0) await sleep(waitMs);

    const worker = fetchers[earliestIdx];
    currentIndex = (earliestIdx + 1) % fetchers.length;
    worker.nextAvailable = now() + worker.interval;
    return worker.fetchRaw(documentId, sheetNames);
  };
}

function getFirstApiKey(config) {
  if (Array.isArray(config.apiKeys) && config.apiKeys.length > 0) {
    const firstEntry = config.apiKeys[0];
    return typeof firstEntry === 'string' ? firstEntry : firstEntry.key;
  }

  return null;
}

function getFirstServiceAccountAuthClient(config) {
  if (!Array.isArray(config.serviceAccounts) || config.serviceAccounts.length === 0) return null;
  const firstEntry = config.serviceAccounts[0];
  const entryObj = typeof firstEntry === 'string' ? {path: firstEntry} : firstEntry;
  const credentialsPath = entryObj.path || entryObj.credentialsPath;
  if (!credentialsPath) return null;

  const resolvedPath = resolveConfigPath(config, credentialsPath);
  if (!fs.existsSync(resolvedPath)) return null;

  try {
    const credentials = readServiceAccountCredentials(resolvedPath);
    return createServiceAccountAuthClient(credentials);
  } catch (e) {
    console.error(`Failed to load first service account from ${resolvedPath}: ${e.message}`);
    return null;
  }
}

function loadAuth(config) {
  if (!config || typeof config !== 'object') return null;

  if (config.credentialsPath) {
    const credentialsPath = config.credentialsPath;
    const resolvedPath = resolveConfigPath(config, credentialsPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Credentials file not found: ${resolvedPath}`);
    }
    const credentials = readServiceAccountCredentials(resolvedPath);
    return createServiceAccountAuthClient(credentials);
  }

  return getFirstServiceAccountAuthClient(config);
}

module.exports = {
  loadApiKeys,
  loadServiceAccounts,
  createServiceAccountBatchFetcher,
  createApiKeyBatchFetcher,
  getFirstApiKey,
  getFirstServiceAccountAuthClient,
  loadAuth,
};
