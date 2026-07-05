const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.resolve(__dirname, '..', 'config.json');

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Missing config file at ${CONFIG_PATH}`);
  }
  const json = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(json);
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
    const extracted = config.apiKeys.map(item => {
      if (typeof item === 'string') return item.trim();
      if (item && typeof item === 'object') return (item.key || item.apiKey || '').toString().trim();
      return '';
    });
    const nonEmpty = extracted.filter(Boolean);
    const unique = new Set(nonEmpty);
    if (unique.size !== nonEmpty.length) {
      throw new Error('`apiKeys` contains duplicate `key` values; ensure all API keys are unique');
    }
  }

  // Ensure service account credential paths are unique when using serviceAccounts
  if (hasSvcAccounts) {
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
    if (!doc.documentId) throw new Error('Each document must include a `documentId`');
    if (!Array.isArray(doc.sheets) || doc.sheets.length === 0) throw new Error(`Document ${doc.documentId} must include a non-empty 'sheets' array`);
  }
}

module.exports = {loadConfig, resolveOutputPath, validateConfig};
