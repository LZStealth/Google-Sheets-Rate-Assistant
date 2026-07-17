const fs = require('fs');
const path = require('path');

const CONFIG_FILE_NAME = 'config.json';
const DEFAULT_CONFIG_TEMPLATE = JSON.stringify({
  apiKeys: [
    {
      key: 'YOUR_API_KEY_1',
      rateLimitPerMinute: 50,
    },
    {
      key: 'YOUR_API_KEY_2',
      rateLimitPerMinute: 50,
    },
  ],
  serviceAccounts: [
    {
      path: 'credentials.json',
      rateLimitPerMinute: 50,
    },
    {
      path: 'credentials_2.json',
      rateLimitPerMinute: 50,
    },
  ],
  documents: [
    {
      documentId: 'YOUR_SPREADSHEET_ID',
      outputDir: 'output/your-document',
      sheets: [
        {
          name: 'Sheet1',
          outputFilename: 'sheet1.csv',
        },
        {
          name: 'Sheet2',
          outputFilename: 'sheet2.csv',
        },
      ],
    },
    {
      documentId: 'YOUR_SPREADSHEET_ID_2',
      outputDir: 'output/your-document-2',
      sheets: [
        {
          name: 'Sheet1',
          outputFilename: 'sheet1.csv',
        },
        {
          name: 'Sheet2',
          outputFilename: 'sheet2.csv',
        },
      ],
    },
  ],
}, null, 2) + '\n';

function getDefaultConfigPath() {
  const packagedApp = Boolean(process.pkg);
  return path.resolve(packagedApp ? path.dirname(process.execPath) : process.cwd(), CONFIG_FILE_NAME);
}

function getConfigPathCandidates() {
  const packagedApp = Boolean(process.pkg);
  const externalDefault = getDefaultConfigPath();

  return [
    process.env.GSA_CONFIG,
    externalDefault,
    !packagedApp ? path.resolve(__dirname, '..', CONFIG_FILE_NAME) : null,
  ].filter(Boolean);
}

function createStarterConfig(configPath) {
  const directory = path.dirname(configPath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, {recursive: true});
  }

  fs.writeFileSync(configPath, DEFAULT_CONFIG_TEMPLATE, 'utf8');
}

function writeConfigFile(configPath, config) {
  const directory = path.dirname(configPath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, {recursive: true});
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function getApiKeyValue(item) {
  if (typeof item === 'string') {
    return item.trim();
  }

  if (item && typeof item === 'object') {
    return (item.key || item.apiKey || '').toString().trim();
  }

  return '';
}

function isPlaceholderApiKey(key) {
  return key === 'YOUR_API_KEY_HERE';
}

function loadConfig() {
  const configPath = getConfigPathCandidates().find(candidate => fs.existsSync(candidate));

  if (!configPath) {
    const starterPath = process.env.GSA_CONFIG || getDefaultConfigPath();
    const error = new Error(`Missing config file at ${starterPath}`);
    error.code = 'ERR_CONFIG_MISSING';
    error.configPath = starterPath;
    throw error;
  }

  const json = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(json);
  Object.defineProperty(config, '__configPath', {
    value: configPath,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  validateConfig(config);
  return config;
}

function resolveOutputPath(outputDir, filename) {
  if (!path.isAbsolute(outputDir)) {
    outputDir = path.resolve(process.cwd(), outputDir);
  }
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, {recursive: true});
  }
  return path.join(outputDir, filename);
}

function validateConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('Missing or invalid configuration object');
  }

  if (config.apiKeys !== undefined && !Array.isArray(config.apiKeys)) {
    throw new Error('`apiKeys` must be an array when present in config.json');
  }

  if (config.serviceAccounts !== undefined && !Array.isArray(config.serviceAccounts)) {
    throw new Error('`serviceAccounts` must be an array when present in config.json');
  }

  if (config.documents !== undefined && !Array.isArray(config.documents)) {
    throw new Error('`documents` must be an array when present in config.json');
  }

  if (!Array.isArray(config.documents) || config.documents.length === 0) {
    throw new Error('`documents` must be a non-empty array in config.json');
  }

  const hasApiKeys = Array.isArray(config.apiKeys) && config.apiKeys.length > 0;
  const hasSvcAccounts = Array.isArray(config.serviceAccounts) && config.serviceAccounts.length > 0;

  // Do not allow both API keys and service accounts to be present simultaneously
  if (hasApiKeys && hasSvcAccounts) {
    throw new Error('Configuration must not include both `apiKeys` and `serviceAccounts`; choose one authentication method');
  }

  if (!hasApiKeys && !hasSvcAccounts) {
    throw new Error('Configuration must include at least one `apiKeys` or `serviceAccounts`');
  }

  // Ensure API key values are unique when using apiKeys
  if (hasApiKeys) {
    const extracted = config.apiKeys.map(getApiKeyValue);
    const nonEmpty = extracted.filter(Boolean);
    const unique = new Set(nonEmpty);
    if (unique.size !== nonEmpty.length) {
      throw new Error('`apiKeys` contains duplicate `key` values; ensure all API keys are unique');
    }

    for (const item of config.apiKeys) {
      const key = getApiKeyValue(item);

      if (!key) {
        throw new Error('Each entry in `apiKeys` must include a non-empty `key`');
      }

      if (isPlaceholderApiKey(key)) {
        throw new Error('Each entry in `apiKeys` must include a real API key; replace `YOUR_API_KEY_HERE`');
      }

      if (typeof item !== 'string' && (!item || typeof item !== 'object')) {
        throw new Error('`apiKeys` entries must be strings or objects');
      }

      if (item.rateLimitPerMinute !== undefined && (!Number.isFinite(item.rateLimitPerMinute) || item.rateLimitPerMinute <= 0)) {
        throw new Error('`rateLimitPerMinute` in `apiKeys` must be a positive number when provided');
      }
    }
  }

  // Ensure service account credential paths are unique when using serviceAccounts
  if (hasSvcAccounts) {
    for (const item of config.serviceAccounts) {
      if (typeof item === 'string') {
        if (!item.trim()) {
          throw new Error('Each string entry in `serviceAccounts` must be non-empty');
        }
        continue;
      }

      if (!item || typeof item !== 'object') {
        throw new Error('`serviceAccounts` entries must be strings or objects');
      }

      const p = (item.path || item.credentialsPath || item.file || '').toString().trim();
      if (!p) {
        throw new Error('Each entry in `serviceAccounts` must include `path` or `credentialsPath`');
      }

      if (item.rateLimitPerMinute !== undefined && (!Number.isFinite(item.rateLimitPerMinute) || item.rateLimitPerMinute <= 0)) {
        throw new Error('`rateLimitPerMinute` in `serviceAccounts` must be a positive number when provided');
      }
    }

    // Read and canonicalize the contents of each service account credential
    const svcContents = config.serviceAccounts.map(item => {
      let p = '';
      if (typeof item === 'string') p = item.trim();
      else if (item && typeof item === 'object') p = (item.path || item.file || item.credentialsPath || '').toString().trim();
      if (!p) return '';
      const full = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
      if (!fs.existsSync(full)) {
        throw new Error(`Service account file not found: ${p}`);
      }
      const raw = fs.readFileSync(full, 'utf8').trim();
      try {
        const parsed = JSON.parse(raw);
        const canonicalize = (obj) => {
          if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
          if (Array.isArray(obj)) return '[' + obj.map(canonicalize).join(',') + ']';
          const keys = Object.keys(obj).sort();
          return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
        };
        return canonicalize(parsed);
      } catch (e) {
        // Non-JSON files: use raw contents
        return raw;
      }
    }).filter(Boolean);

    const uniqueSvc = new Set(svcContents);
    if (uniqueSvc.size !== svcContents.length) {
      throw new Error('`serviceAccounts` contains duplicate credential contents; ensure all service account credentials are unique');
    }
  }

  // Basic validation of documents/sheets structure
  for (const doc of config.documents) {
    if (!doc || typeof doc !== 'object') {
      throw new Error('Each document entry must be an object');
    }

    if (typeof doc.documentId !== 'string' || !doc.documentId.trim()) {
      throw new Error('Each document must include a non-empty `documentId`');
    }

    if (doc.outputDir !== undefined && typeof doc.outputDir !== 'string') {
      throw new Error(`Document ${doc.documentId} has an invalid outputDir; it must be a string`);
    }

    if (!Array.isArray(doc.sheets) || doc.sheets.length === 0) {
      throw new Error(`Document ${doc.documentId} must include a non-empty 'sheets' array`);
    }

    for (const sheet of doc.sheets) {
      if (typeof sheet === 'string') {
        if (!sheet.trim()) {
          throw new Error(`Document ${doc.documentId} contains an empty sheet name`);
        }
        continue;
      }

      if (!sheet || typeof sheet !== 'object') {
        throw new Error(`Document ${doc.documentId} contains an invalid sheet entry`);
      }

      if (typeof sheet.name !== 'string' || !sheet.name.trim()) {
        throw new Error(`Document ${doc.documentId} contains a sheet entry missing name`);
      }

      if (sheet.outputFilename !== undefined && typeof sheet.outputFilename !== 'string') {
        throw new Error(`Document ${doc.documentId} sheet ${sheet.name} has an invalid outputFilename; it must be a string`);
      }
    }
  }
}

module.exports = {loadConfig, resolveOutputPath, validateConfig, createStarterConfig, getDefaultConfigPath, writeConfigFile};
