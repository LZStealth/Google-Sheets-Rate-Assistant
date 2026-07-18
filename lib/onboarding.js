const fs = require('fs');
const path = require('path');
const readline = require('readline');
const {createStarterConfig, getDefaultConfigPath, writeConfigFile} = require('./config');
const {getFirstServiceAccountAuthClient} = require('./auth');
const {fetchSpreadsheetTitle} = require('./sheets');

function createPrompt() {
  const rl = readline.createInterface({input: process.stdin, output: process.stdout});

  const ask = question => new Promise(resolve => {
    rl.question(question, answer => resolve((answer || '').trim()));
  });

  const close = () => new Promise(resolve => {
    rl.close();
    resolve();
  });

  return {ask, close};
}

async function askNonEmpty(ask, question) {
  while (true) {
    const answer = await ask(question);
    if (answer) {
      return answer;
    }
    console.log('Please enter a value.');
  }
}

async function askPositiveInteger(ask, question) {
  while (true) {
    const answer = await ask(question);
    const value = Number.parseInt(answer, 10);
    if (Number.isInteger(value) && value > 0) {
      return value;
    }
    console.log('Please enter a whole number greater than zero.');
  }
}

async function askChoice(ask, question, options) {
  const optionText = options
    .map((option, index) => `${index + 1}. ${option.label}`)
    .join('\n');

  while (true) {
    const answer = await ask(`${question}\n${optionText}\n> `);
    const lower = answer.toLowerCase();

    const byNumber = Number.parseInt(answer, 10);
    if (Number.isInteger(byNumber) && byNumber >= 1 && byNumber <= options.length) {
      return options[byNumber - 1].value;
    }

    const match = options.find(option => option.value.toLowerCase() === lower || option.label.toLowerCase() === lower);
    if (match) {
      return match.value;
    }

    console.log('Please choose one of the listed options.');
  }
}

async function askOptionalPositiveInteger(ask, question, defaultValue) {
  while (true) {
    const answer = await ask(question);
    if (!answer) {
      return defaultValue;
    }

    const value = Number.parseInt(answer, 10);
    if (Number.isInteger(value) && value > 0) {
      return value;
    }

    console.log('Please enter a whole number greater than zero, or press Enter to use the default.');
  }
}

function getServiceAccountIdentity(inputPath, baseDir) {
  const value = (inputPath || '').trim();
  if (!value) {
    return '';
  }

  const fullPath = path.isAbsolute(value) ? value : path.resolve(baseDir || process.cwd(), value);
  if (!fs.existsSync(fullPath)) {
    return value;
  }

  const raw = fs.readFileSync(fullPath, 'utf8').trim();
  try {
    const parsed = JSON.parse(raw);
    const canonicalize = obj => {
      if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
      if (Array.isArray(obj)) return '[' + obj.map(canonicalize).join(',') + ']';
      const keys = Object.keys(obj).sort();
      return '{' + keys.map(key => JSON.stringify(key) + ':' + canonicalize(obj[key])).join(',') + '}';
    };
    return canonicalize(parsed);
  } catch (_) {
    return raw;
  }
}

function getServiceAccountsFolderPath(configPath) {
  return path.join(path.dirname(configPath), 'serviceAccounts');
}

function listServiceAccountFiles(folderPath) {
  if (!fs.existsSync(folderPath)) {
    return [];
  }

  return fs.readdirSync(folderPath)
    .map(fileName => path.join(folderPath, fileName))
    .filter(filePath => {
      try {
        return fs.statSync(filePath).isFile();
      } catch (_) {
        return false;
      }
    });
}

function extractSpreadsheetId(input) {
  const value = (input || '').trim();
  if (!value) {
    return '';
  }

  const urlMatch = value.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/i);
  if (urlMatch && urlMatch[1]) {
    return urlMatch[1];
  }

  return value;
}

async function askSpreadsheetIdOrUrl(ask, question) {
  while (true) {
    const answer = await ask(question);
    const documentId = extractSpreadsheetId(answer);

    if (documentId) {
      return documentId;
    }

    console.log('Please enter a Google Sheets URL or spreadsheet ID.');
  }
}

async function pauseForEnter(ask) {
  await ask('Press Enter to close this window...');
}

function buildTitleContext(authMode, config) {
  if (authMode === 'apiKeys' && Array.isArray(config.apiKeys) && config.apiKeys.length > 0) {
    return {apiKey: config.apiKeys[0].key};
  }

  if (authMode === 'serviceAccounts' && Array.isArray(config.serviceAccounts) && config.serviceAccounts.length > 0) {
    const authClient = getFirstServiceAccountAuthClient(config);
    if (authClient) {
      return {authClient};
    }
  }

  return {};
}

async function runOnboarding() {
  const {ask, close} = createPrompt();
  const configPath = getDefaultConfigPath();

  try {
    console.log('Google Sheets Rate Assistant setup');
    console.log('');

    const setupMode = await askChoice(
      ask,
      'Would you like to use the wizard or just create a config file?',
      [
        {label: 'Wizard', value: 'wizard'},
        {label: 'Config file', value: 'config'},
      ]
    );

    if (setupMode === 'config') {
      createStarterConfig(configPath);
      console.log('');
      console.log(`Starter config created at ${configPath}`);
      console.log('Edit that file, then run the app again.');
      await pauseForEnter(ask);
      return {mode: 'config', configPath};
    }

    const authMode = await askChoice(
      ask,
      'Which authentication method do you want to use?',
      [
        {label: 'API keys', value: 'apiKeys'},
        {label: 'Service accounts', value: 'serviceAccounts'},
      ]
    );

    if (authMode === 'apiKeys') {
      console.log('Warning: when using API keys, the spreadsheet must be publicly accessible.');
      console.log('');
    }

    const config = {
      apiKeys: [],
      serviceAccounts: [],
      documents: [],
    };
    Object.defineProperty(config, '__configPath', {
      value: configPath,
      enumerable: false,
      configurable: true,
      writable: true,
    });

    if (authMode === 'apiKeys') {
      const credentialCount = await askPositiveInteger(
        ask,
        'How many API keys do you want to add? '
      );

      const seenKeys = new Set();

      for (let index = 0; index < credentialCount; index += 1) {
        let key;
        while (true) {
          key = await askNonEmpty(ask, `Enter API key ${index + 1}: `);
          if (seenKeys.has(key)) {
            console.log('That API key was already entered. Please enter a unique API key.');
            continue;
          }
          break;
        }

        const rateLimitPerMinute = await askOptionalPositiveInteger(
          ask,
          `Rate limit per minute for API key ${index + 1} (press Enter for 50): `,
          50
        );

        seenKeys.add(key);
        config.apiKeys.push({key, rateLimitPerMinute});
      }
    } else {
      const serviceAccountsFolder = getServiceAccountsFolderPath(configPath);
      if (!fs.existsSync(serviceAccountsFolder)) {
        fs.mkdirSync(serviceAccountsFolder, {recursive: true});
      }

      console.log(`A serviceAccounts folder has been created at ${serviceAccountsFolder}.`);
      console.log('Paste your service account files into that folder, then press Enter to continue.');
      await pauseForEnter(ask);

      const serviceAccountFiles = listServiceAccountFiles(serviceAccountsFolder);
      console.log(`Found ${serviceAccountFiles.length} service account${serviceAccountFiles.length === 1 ? '' : 's'}.`);

      if (serviceAccountFiles.length === 0) {
        throw new Error(`No service account files were found in ${serviceAccountsFolder}`);
      }

      const seenServiceAccounts = new Set();

      for (const filePath of serviceAccountFiles) {
        const relativePath = path.relative(path.dirname(configPath), filePath).split(path.sep).join('/');
        const serviceAccountIdentity = getServiceAccountIdentity(relativePath, path.dirname(configPath));

        if (seenServiceAccounts.has(serviceAccountIdentity)) {
          console.log(`Skipping duplicate service account file: ${path.basename(filePath)}`);
          continue;
        }

        seenServiceAccounts.add(serviceAccountIdentity);
        const rateLimitPerMinute = await askOptionalPositiveInteger(
          ask,
          `Rate limit per minute for ${path.basename(filePath)} (press Enter for 50): `,
          50
        );

        config.serviceAccounts.push({path: relativePath, rateLimitPerMinute});
      }
    }

    const documentCount = await askPositiveInteger(ask, 'How many documents do you want to pull from? ');

    for (let documentIndex = 0; documentIndex < documentCount; documentIndex += 1) {
      const documentId = await askSpreadsheetIdOrUrl(
        ask,
        `Enter Google Sheets URL or document ID ${documentIndex + 1}: `
      );
      let documentTitle = documentId;

      try {
        const titleContext = buildTitleContext(authMode, config);
        documentTitle = await fetchSpreadsheetTitle(titleContext, documentId);
      } catch (err) {
        console.log(`Could not load spreadsheet title for ${documentId}; using the document ID instead.`);
      }

      const sheetCount = await askPositiveInteger(ask, `How many sheets for document ${documentIndex + 1}? `);
      const sheets = [];

      for (let sheetIndex = 0; sheetIndex < sheetCount; sheetIndex += 1) {
        const sheetName = await askNonEmpty(ask, `Enter sheet name ${sheetIndex + 1} for document ${documentIndex + 1}: `);
        sheets.push({
          name: sheetName,
          outputFilename: `${sheetName}.csv`,
        });
      }

      config.documents.push({
        documentId,
        outputDir: `output/${documentTitle}`,
        sheets,
      });
    }

    writeConfigFile(configPath, config);
    console.log('');
    console.log(`Config saved to ${configPath}`);
    return {mode: 'wizard', configPath, config};
  } finally {
    await close();
  }
}

module.exports = {runOnboarding};
