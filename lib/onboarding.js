const readline = require('readline');
const {google} = require('googleapis');
const {createStarterConfig, getDefaultConfigPath, writeConfigFile} = require('./config');
const {getFirstServiceAccountAuthClient} = require('./auth');

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

async function pauseForEnter(ask) {
  await ask('Press Enter to close this window...');
}

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

    const credentialCount = await askPositiveInteger(
      ask,
      `How many ${authMode === 'apiKeys' ? 'API keys' : 'service accounts'} do you want to add? `
    );

    const config = {
      apiKeys: [],
      serviceAccounts: [],
      documents: [],
    };

    if (authMode === 'apiKeys') {
      for (let index = 0; index < credentialCount; index += 1) {
        const key = await askNonEmpty(ask, `Enter API key ${index + 1}: `);
        const rateLimitPerMinute = await askOptionalPositiveInteger(
          ask,
          `Rate limit per minute for API key ${index + 1} (press Enter for 50): `,
          50
        );

        config.apiKeys.push({key, rateLimitPerMinute});
      }
    } else {
      for (let index = 0; index < credentialCount; index += 1) {
        const pathValue = await askNonEmpty(ask, `Enter service account path ${index + 1}: `);
        const rateLimitPerMinute = await askOptionalPositiveInteger(
          ask,
          `Rate limit per minute for service account ${index + 1} (press Enter for 50): `,
          50
        );

        config.serviceAccounts.push({path: pathValue, rateLimitPerMinute});
      }
    }

    const documentCount = await askPositiveInteger(ask, 'How many documents do you want to pull from? ');

    for (let documentIndex = 0; documentIndex < documentCount; documentIndex += 1) {
      const documentId = await askNonEmpty(ask, `Enter document ID ${documentIndex + 1}: `);
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
