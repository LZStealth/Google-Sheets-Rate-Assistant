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
  const hasCredPath = !!config.credentialsPath;

  // Do not allow both API keys and service accounts to be present simultaneously
  if (hasApiKeys && hasSvcAccounts) {
    throw new Error('Configuration must not include both `apiKeys` and `serviceAccounts`; choose one authentication method');
  }

  if (!hasApiKeys && !hasSvcAccounts && !hasCredPath) {
    throw new Error('Configuration must include at least one of: `apiKeys`, `serviceAccounts`, or `credentialsPath`');
  }

  // Basic validation of documents/sheets structure
  for (const doc of config.documents) {
    if (!doc.documentId) throw new Error('Each document must include a `documentId`');
    if (!Array.isArray(doc.sheets) || doc.sheets.length === 0) throw new Error(`Document ${doc.documentId} must include a non-empty 'sheets' array`);
  }
}

module.exports = {loadConfig, resolveOutputPath, validateConfig};
