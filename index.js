// Google Sheets Rate Assistant
// Orchestrates periodic fetches of Google Sheets and writes CSV outputs.
// Uses `./lib/config`, `./lib/rate`, and `./lib/auth` for configuration,
// rate-limiting, and authentication/fetch helpers respectively.
// === Imports & constants ===
const fs = require('fs');
const path = require('path');
const {google} = require('googleapis');
const stringifyModule = require('csv-stringify/sync');
const stringify = typeof stringifyModule === 'function'
  ? stringifyModule
  : stringifyModule.default || stringifyModule.stringify || stringifyModule;
const {loadConfig, resolveOutputPath, validateConfig} = require('./lib/config');
const {buildThrottle, applyRateLimitBuffer, getTotalRateLimitPerMinute} = require('./lib/rate');
const authHelpers = require('./lib/auth');
const {createApiKeyBatchFetcher, createServiceAccountBatchFetcher, getFirstApiKey, getFirstServiceAccountAuthClient, loadAuth} = authHelpers;

// === Status rendering / console display ===
// Renders per-sheet status lines when running in a TTY, updating in-place.

function mapDocumentToFilename(documentConfig, sheetName) {
  const safeName = sheetName.replace(/[\\/:*?"<>|]/g, '_');
  return `${documentConfig.documentId}-${safeName}.csv`;
}

const statusManager = {
  keys: [],
  statuses: new Map(),
  lastRenderLines: 0,
  enabled: process.stdout && process.stdout.isTTY,
};

// === Document grouping & mapping ===
// Map `config.documents` entries to internal groups with resolved output paths.

function renderStatusBlock() {
  if (!statusManager.enabled || statusManager.keys.length === 0) {
    return;
  }

  if (statusManager.lastRenderLines > 0) {
    process.stdout.write(`\x1B[${statusManager.lastRenderLines}F`);
  }

  for (const key of statusManager.keys) {
    const statusText = statusManager.statuses.get(key) || `${key} - pending`;
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    process.stdout.write(statusText + '\n');
  }

  statusManager.lastRenderLines = statusManager.keys.length;
}

function setTaskStatus(taskId, statusText) {
  statusManager.statuses.set(taskId, statusText);
  renderStatusBlock();
}

function initializeTaskStatuses(tasks) {
  statusManager.keys = tasks.map(task => `${task.documentId}:${task.sheetName}`);
  statusManager.statuses.clear();
  statusManager.lastRenderLines = 0;

  for (const key of statusManager.keys) {
    statusManager.statuses.set(key, `${key} - pending`);
  }

  renderStatusBlock();
}

// Authentication helpers: see `./lib/auth` for credential loaders and
// per-credential, throttled batch fetchers (API key and service account modes).

async function fetchSpreadsheetTitle(context, documentId) {
  const sheetOptions = {version: 'v4'};
  if (context.authClient) {
    sheetOptions.auth = context.authClient;
  }

  const sheets = google.sheets(sheetOptions);
  const request = {
    spreadsheetId: documentId,
    fields: 'properties/title',
  };

  if (context.apiKey) {
    request.key = context.apiKey;
  }

  const response = await sheets.spreadsheets.get(request);
  return response.data.properties?.title || documentId;
}

function buildDocumentGroups(config) {
  const groups = [];

  if (!Array.isArray(config.documents)) {
    throw new Error('`documents` must be an array in config.json');
  }

  for (const documentConfig of config.documents) {
    if (!documentConfig.documentId || !Array.isArray(documentConfig.sheets)) {
      throw new Error('Each document must include documentId and sheets array');
    }

    const documentOutputDir = documentConfig.outputDir || './output';
    const sheets = [];

    for (const sheetConfig of documentConfig.sheets) {
      const name = typeof sheetConfig === 'string' ? sheetConfig : sheetConfig.name;
      const outputFilename = sheetConfig.outputFilename || mapDocumentToFilename(documentConfig, name);
      const outputPath = resolveOutputPath(documentOutputDir, outputFilename);

      sheets.push({
        sheetName: name,
        outputPath,
      });
    }

    groups.push({
      documentId: documentConfig.documentId,
      sheets,
    });
  }

  return groups;
}

// === Batch fetching (fallback) ===
// `index.js` provides a simple `batchFetchDocumentSheets` fallback used when
// no per-credential batch fetcher is configured by `./lib/auth`.
async function batchFetchDocumentSheets(context, documentId, sheetNames) {
  const sheetOptions = {version: 'v4'};
  if (context.authClient) {
    sheetOptions.auth = context.authClient;
  }

  const sheets = google.sheets(sheetOptions);
  const request = {
    spreadsheetId: documentId,
    ranges: sheetNames,
  };

  if (context.apiKey) {
    request.key = context.apiKey;
  }

  const response = await sheets.spreadsheets.values.batchGet(request);
  const valueRanges = response.data.valueRanges || [];
  const rowsBySheet = {};

  for (let i = 0; i < sheetNames.length; i += 1) {
    const sheetName = sheetNames[i];
    rowsBySheet[sheetName] = valueRanges[i]?.values || [];
  }

  return rowsBySheet;
}

function formatStatusTimestamp(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// === Execution / saving ===
// Functions that execute per-document fetches and write CSV outputs.

async function writeCsv(outputPath, rows) {
  const csv = stringify(rows, {
    header: false,
    quoted: true,
  });
  await fs.promises.writeFile(outputPath, csv, 'utf8');
}

function executeDocumentGroup(group, fetcher) {
  const sheetNames = group.sheets.map(sheet => sheet.sheetName);

  for (const sheet of group.sheets) {
    const displayName = `${group.documentDisplayName || group.documentId}:${sheet.sheetName}`;
    setTaskStatus(`${group.documentId}:${sheet.sheetName}`, `${displayName} - pulling...`);
  }

  // Run the actual fetch/write flow in the background so the scheduler doesn't pause.
  (async () => {
    try {
      const rowsBySheet = await fetcher(group.documentId, sheetNames);

      for (const sheet of group.sheets) {
        const rows = rowsBySheet[sheet.sheetName] || [];
        try {
          await writeCsv(sheet.outputPath, rows);
          const relativePath = path.relative(process.cwd(), sheet.outputPath) || sheet.outputPath;
          const timestamp = formatStatusTimestamp();
          const displayName = `${group.documentDisplayName || group.documentId}:${sheet.sheetName}`;
          setTaskStatus(
            `${group.documentId}:${sheet.sheetName}`,
            `${displayName} - saved to ${relativePath} (updated ${timestamp})`
          );
        } catch (writeErr) {
          setTaskStatus(
            `${group.documentId}:${sheet.sheetName}`,
            `${group.documentId}:${sheet.sheetName} - failed to save: ${formatGoogleError(writeErr)}`
          );
        }
      }
    } catch (err) {
      for (const sheet of group.sheets) {
        setTaskStatus(
          `${group.documentId}:${sheet.sheetName}`,
          `${group.documentId}:${sheet.sheetName} - failed: ${interpretGoogleSheetsError(err, group.documentId, sheet.sheetName)}`
        );
      }
    }
  })();
}

function formatGoogleError(err) {
  if (err && err.response && err.response.data) {
    return `${err.message} (${JSON.stringify(err.response.data)})`;
  }
  return err.message || String(err);
}

function interpretGoogleSheetsError(err, documentId, sheetName) {
  const message = formatGoogleError(err);
  const notFound = err && err.response && err.response.status === 404;
  const requestedEntity = message.includes('Requested entity was not found');

  if (notFound || requestedEntity) {
    let detail = `Spreadsheet not found or inaccessible: ${documentId}`;
    if (sheetName) {
      detail += `, sheet: ${sheetName}`;
    }
    detail += '. Check that the spreadsheet ID is correct, that the sheet exists, and that the document is shared with the service account or is publicly readable when using an API key.';
    return detail;
  }

  return message;
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

// === Main scheduler ===
// Orchestrates startup, selects the appropriate fetcher (API keys,
// service accounts), and runs the periodic loop.
async function scheduleRuns() {
  const config = loadConfig();
  try {
    validateConfig(config);
  } catch (e) {
    console.error('Configuration error:', e.message);
    process.exit(1);
  }
  const apiBatchFetcher = createApiKeyBatchFetcher(config);
  const svcBatchFetcher = createServiceAccountBatchFetcher(config);
  let fetcher;

  if (apiBatchFetcher) {
    fetcher = apiBatchFetcher;
  } else if (svcBatchFetcher) {
    fetcher = svcBatchFetcher;
  } else {
    const auth = await loadAuth(config);
    const baseRate = config.rateLimitPerMinute || 50;
    const bufferedRate = applyRateLimitBuffer(baseRate);
    const throttle = buildThrottle(bufferedRate);
    fetcher = throttle((documentId, sheetNames) => batchFetchDocumentSheets({authClient: auth}, documentId, sheetNames));
  }

  const groups = buildDocumentGroups(config);
  if (groups.length === 0) {
    throw new Error('No sheets configured to pull in config.json');
  }

  const firstApiKey = getFirstApiKey(config);
  const titleMap = {};

  // If running in single-auth mode, try to warm the token
  if (!apiBatchFetcher && !svcBatchFetcher) {
    try {
      const singleAuth = await loadAuth(config);
      if (singleAuth) {
        try {
          const at = await singleAuth.getAccessToken();
          console.log('Service account token acquired (len=', (at && at.token) ? at.token.length : 'no', ')');
        } catch (e) {
          console.error('Failed to acquire initial access token from service account:', e && e.message);
        }
      }
    } catch (_) {
      // loadAuth will throw if missing credentials; continue and let title fetch handle errors
    }
  }

  // build a context for fetching titles: prefer API key, then first service account
  let titleContext = null;
  if (firstApiKey) {
    titleContext = {apiKey: firstApiKey};
  } else if (svcBatchFetcher) {
    const firstSvcAuth = getFirstServiceAccountAuthClient(config);
    if (firstSvcAuth) titleContext = {authClient: firstSvcAuth};
  } else {
    try {
      const singleAuth = await loadAuth(config);
      if (singleAuth) titleContext = {authClient: singleAuth};
    } catch (_) {
      // ignore
    }
  }

  for (const group of groups) {
    try {
      titleMap[group.documentId] = await fetchSpreadsheetTitle(titleContext || {}, group.documentId);
    } catch (err) {
      titleMap[group.documentId] = group.documentId;
      console.error(`Failed to load title for ${group.documentId}: ${formatGoogleError(err)}`);
    }
  }

  const tasks = groups.flatMap(group =>
    group.sheets.map(sheet => ({
      documentId: group.documentId,
      sheetName: sheet.sheetName,
    }))
  );

  tasks.forEach(task => {
    task.documentDisplayName = titleMap[task.documentId] || task.documentId;
  });

  groups.forEach(group => {
    group.documentDisplayName = titleMap[group.documentId] || group.documentId;
  });

  const totalRateLimit = getTotalRateLimitPerMinute(config);
  const intervalMs = Math.max(1, Math.ceil(60000 / totalRateLimit));
  console.log(`Configured for ${totalRateLimit} requests per minute across ${groups.length} documents (${intervalMs}ms interval)`);
  initializeTaskStatuses(tasks);

  let currentIndex = 0;
  while (true) {
    const group = groups[currentIndex];
    currentIndex = (currentIndex + 1) % groups.length;

    try {
      // Fire off the document fetch/save in the background and don't await it,
      // so the scheduler can continue to the next group immediately.
      executeDocumentGroup(group, fetcher);
    } catch (err) {
      for (const sheet of group.sheets) {
        setTaskStatus(
          `${group.documentId}:${sheet.sheetName}`,
          `${group.documentId}:${sheet.sheetName} - failed: ${interpretGoogleSheetsError(err, group.documentId, sheet.sheetName)}`
        );
      }
    }

    await sleep(intervalMs);
  }
}

if (require.main === module) {
  scheduleRuns().catch(err => {
    console.error('Application error:', err.message || err);
    process.exit(1);
  });
}
