// Google Sheets Rate Assistant
// Orchestrates periodic fetches of Google Sheets and writes CSV outputs.
// Uses `./lib/config`, `./lib/rate`, and `./lib/auth` for configuration,
// rate-limiting, and authentication/fetch helpers respectively.
// === Imports & constants ===
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const stringifyModule = require('./node_modules/csv-stringify/dist/cjs/sync.cjs');
const stringify = typeof stringifyModule === 'function'
  ? stringifyModule
  : stringifyModule.default || stringifyModule.stringify || stringifyModule;
const {loadConfig, resolveOutputPath} = require('./lib/config');
const {buildThrottle, applyRateLimitBuffer, getTotalRateLimitPerMinute} = require('./lib/rate');
const {runOnboarding} = require('./lib/onboarding');
const authHelpers = require('./lib/auth');
const {fetchSpreadsheetTitle, fetchSpreadsheetValuesBatch} = require('./lib/sheets');
const {createApiKeyBatchFetcher, createServiceAccountBatchFetcher, getFirstApiKey, getFirstServiceAccountAuthClient, loadAuth} = authHelpers;

// === Status rendering / console display ===
// Renders per-sheet status lines when running in a TTY, updating in-place.

function mapDocumentToFilename(sheetName) {
  const safeName = sheetName.replace(/[\\/:*?"<>|]/g, '_');
  return `${safeName}.csv`;
}

const statusManager = {
  keys: [],
  lineIndexes: new Map(),
  statuses: new Map(),
  anchorSaved: false,
  enabled: process.stdout && process.stdout.isTTY,
};

function clearConsoleForRun() {
  if (process.stdout && process.stdout.isTTY && typeof console.clear === 'function') {
    console.clear();
    return;
  }

  if (process.stdout && typeof process.stdout.write === 'function') {
    process.stdout.write('\u001b[2J\u001b[0f');
  }
}

function limitToTerminalWidth(text) {
  const width = Math.max(20, (process.stdout && process.stdout.columns) || 80);
  if (text.length <= width) {
    return text;
  }

  if (width <= 1) {
    return text.slice(0, width);
  }

  return text.slice(0, width - 1) + '…';
}

// === Document grouping & mapping ===
// Map `config.documents` entries to internal groups with resolved output paths.

function renderStatusBlock() {
  if (!statusManager.enabled || statusManager.keys.length === 0) {
    return;
  }

  process.stdout.write('\u001b[s');

  statusManager.keys.forEach((key, index) => {
    const statusText = statusManager.statuses.get(key) || `${key} - pending`;
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    process.stdout.write(limitToTerminalWidth(statusText));
    if (index < statusManager.keys.length - 1) {
      process.stdout.write('\n');
    }
  });

  statusManager.anchorSaved = true;
}

function updateStatusLine(taskId, statusText) {
  if (!statusManager.enabled || !statusManager.anchorSaved) {
    return;
  }

  const lineIndex = statusManager.lineIndexes.get(taskId);
  if (lineIndex === undefined) {
    return;
  }

  process.stdout.write('\u001b[u');
  if (lineIndex > 0) {
    readline.moveCursor(process.stdout, 0, lineIndex);
  }
  readline.cursorTo(process.stdout, 0);
  readline.clearLine(process.stdout, 0);
  process.stdout.write(limitToTerminalWidth(statusText));
  process.stdout.write('\u001b[u');
}

function setTaskStatus(taskId, statusText) {
  statusManager.statuses.set(taskId, statusText);
  updateStatusLine(taskId, statusText);
}

function initializeTaskStatuses(tasks) {
  statusManager.keys = tasks.map(task => `${task.documentId}:${task.sheetName}`);
  statusManager.lineIndexes.clear();
  statusManager.statuses.clear();
  statusManager.anchorSaved = false;

  for (const [index, key] of statusManager.keys.entries()) {
    statusManager.lineIndexes.set(key, index);
    statusManager.statuses.set(key, `${key} - pending`);
  }

  renderStatusBlock();
}

// Authentication helpers: see `./lib/auth` for credential loaders and
// per-credential, throttled batch fetchers (API key and service account modes).

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
      const outputFilename = sheetConfig.outputFilename || mapDocumentToFilename(name);
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
  return fetchSpreadsheetValuesBatch(context, documentId, sheetNames);
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

function waitForEnter() {
  if (!process.stdin || (!process.stdin.isTTY && !(process.stdout && process.stdout.isTTY))) {
    return Promise.resolve();
  }

  return new Promise(resolve => {
    const readline = require('readline');
    const rl = readline.createInterface({input: process.stdin, output: process.stdout});
    rl.question('Press Enter to close this window...', () => {
      rl.close();
      resolve();
    });
  });
}

function formatError(err) {
  if (!err) {
    return 'Unknown error';
  }

  if (err.message) {
    return err.message;
  }

  return String(err);
}

function isUserFacingError(err) {
  if (!err) {
    return false;
  }

  const message = formatError(err);
  return /config\.json|api key|service account|spreadsheet|sheet|credential|document/i.test(message);
}

async function handleFatalError(err, prefix = 'Application error:') {
  const message = formatError(err);
  const friendlyPrefix = prefix || 'Application error:';

  console.error(friendlyPrefix);

  if (isUserFacingError(err)) {
    console.error(message);
  } else {
    console.error('Something went wrong.');
    if (message && message !== 'Unknown error') {
      console.error(message);
    }
  }

  await waitForEnter();
  process.exit(1);
}

// === Main scheduler ===
// Orchestrates startup, selects the appropriate fetcher (API keys,
// service accounts), and runs the periodic loop.
async function scheduleRuns(config) {
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

  console.log('Google Sheets Rate Assistant');

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
  console.log(limitToTerminalWidth(`Configured for ${totalRateLimit} requests per minute across ${groups.length} documents (${intervalMs}ms interval)`));
  console.log('');
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
  process.on('uncaughtException', err => {
    handleFatalError(err, 'Unexpected error:').catch(() => process.exit(1));
  });

  process.on('unhandledRejection', err => {
    handleFatalError(err, 'Unexpected error:').catch(() => process.exit(1));
  });

  (async () => {
    try {
      clearConsoleForRun();

      let config;

      try {
        config = loadConfig();
      } catch (err) {
        if (err && err.code === 'ERR_CONFIG_MISSING') {
          const onboardingResult = await runOnboarding();
          if (onboardingResult && onboardingResult.mode === 'config') {
            return;
          }
          config = onboardingResult.config;
        } else {
          throw err;
        }
      }

      await scheduleRuns(config);
    } catch (err) {
      handleFatalError(err, 'Configuration error:').catch(() => process.exit(1));
    }
  })();
}
