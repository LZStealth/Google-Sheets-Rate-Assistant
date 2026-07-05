const fs = require('fs');
const path = require('path');
const {google} = require('googleapis');
const {applyRateLimitBuffer} = require('./rate');

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
    const resolvedPath = path.isAbsolute(credentialsPath) ? credentialsPath : path.resolve(process.cwd(), credentialsPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Service account credentials not found: ${resolvedPath}`);
    }

    let credentials;
    try {
      credentials = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
    } catch (e) {
      throw new Error(`Failed to read/parse service account credentials at ${resolvedPath}: ${e.message}`);
    }

    let authClient;
    try {
      authClient = google.auth.fromJSON(credentials);
    } catch (e) {
      throw new Error(`Failed to initialize auth client from credentials at ${resolvedPath}: ${e.message}`);
    }
    authClient.scopes = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

    const bufferedRateLimit = applyRateLimitBuffer(rateLimitPerMinute);
    const interval = Math.ceil(60000 / bufferedRateLimit);

    const fetchRaw = async (documentId, sheetNames) => {
      const sheets = google.sheets({version: 'v4', auth: authClient});
      const request = {spreadsheetId: documentId, ranges: sheetNames};
      const response = await sheets.spreadsheets.values.batchGet(request);
      const valueRanges = response.data.valueRanges || [];
      const rowsBySheet = {};
      for (let i = 0; i < sheetNames.length; i += 1) {
        const sheetName = sheetNames[i];
        rowsBySheet[sheetName] = valueRanges[i]?.values || [];
      }
      return rowsBySheet;
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
      const sheets = google.sheets({version: 'v4'});
      const request = {spreadsheetId: documentId, ranges: sheetNames, key};
      const response = await sheets.spreadsheets.values.batchGet(request);
      const valueRanges = response.data.valueRanges || [];
      const rowsBySheet = {};
      for (let i = 0; i < sheetNames.length; i += 1) {
        const sheetName = sheetNames[i];
        rowsBySheet[sheetName] = valueRanges[i]?.values || [];
      }
      return rowsBySheet;
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

  const resolvedPath = path.isAbsolute(credentialsPath) ? credentialsPath : path.resolve(process.cwd(), credentialsPath);
  if (!fs.existsSync(resolvedPath)) return null;

  try {
    const raw = fs.readFileSync(resolvedPath, 'utf8');
    const credentials = JSON.parse(raw);
    const authClient = google.auth.fromJSON(credentials);
    authClient.scopes = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
    return authClient;
  } catch (e) {
    console.error(`Failed to load first service account from ${resolvedPath}: ${e.message}`);
    return null;
  }
}

function loadAuth(config) {
  if (!config || typeof config !== 'object') return null;

  if (config.credentialsPath) {
    const credentialsPath = config.credentialsPath;
    const resolvedPath = path.isAbsolute(credentialsPath) ? credentialsPath : path.resolve(process.cwd(), credentialsPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`Credentials file not found: ${resolvedPath}`);
    }
    const raw = fs.readFileSync(resolvedPath, 'utf8');
    const credentials = JSON.parse(raw);
    const authClient = google.auth.fromJSON(credentials);
    authClient.scopes = ['https://www.googleapis.com/auth/spreadsheets.readonly'];
    return authClient;
  }

  return getFirstServiceAccountAuthClient(config);
}

module.exports = {
  loadApiKeys,
  loadServiceAccounts,
  createServiceAccountBatchFetcher,
  createApiKeyBatchFetcher,
  getFirstApiKey,
  getFirstServiceAccountAuthClient
  , loadAuth
};
