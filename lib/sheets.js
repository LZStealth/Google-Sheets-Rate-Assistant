const https = require('https');
const {URL} = require('url');

function parseResponseBody(body) {
  if (!body) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch (_) {
    return body;
  }
}

function extractErrorMessage(data) {
  if (!data) {
    return '';
  }

  if (typeof data === 'string') {
    return data;
  }

  if (data.error && typeof data.error === 'object') {
    if (typeof data.error.message === 'string' && data.error.message) {
      return data.error.message;
    }

    if (Array.isArray(data.error.errors) && data.error.errors.length > 0) {
      const firstError = data.error.errors[0];
      if (firstError && typeof firstError.message === 'string' && firstError.message) {
        return firstError.message;
      }
    }
  }

  if (typeof data.message === 'string' && data.message) {
    return data.message;
  }

  return '';
}

function requestJson(urlString, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const requestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 443,
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      headers: Object.assign({Accept: 'application/json'}, headers),
    };

    const request = https.request(requestOptions, response => {
      let body = '';
      response.setEncoding('utf8');

      response.on('data', chunk => {
        body += chunk;
      });

      response.on('end', () => {
        const data = parseResponseBody(body);

        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve({status: response.statusCode, headers: response.headers, data});
          return;
        }

        const message = extractErrorMessage(data) || `Request failed with status ${response.statusCode}`;
        const error = new Error(message);
        error.response = {status: response.statusCode, headers: response.headers, data};
        reject(error);
      });
    });

    request.on('error', reject);
    request.end();
  });
}

async function requestSheetsJson(pathname, context, queryParams = {}) {
  const url = new URL(`https://sheets.googleapis.com${pathname}`);

  for (const [key, value] of Object.entries(queryParams)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, item);
      }
    } else if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = {};

  if (context && context.authClient) {
    if (typeof context.authClient.getAccessToken === 'function') {
      const token = await context.authClient.getAccessToken();
      const accessToken = token && typeof token === 'object' ? token.token || token.access_token : token;
      if (accessToken) {
        headers.Authorization = `Bearer ${accessToken}`;
      }
    } else if (typeof context.authClient.getRequestHeaders === 'function') {
      const authHeaders = await context.authClient.getRequestHeaders(url.toString());
      Object.assign(headers, authHeaders || {});
    }
  }

  if (context && context.apiKey) {
    url.searchParams.set('key', context.apiKey);
  }

  return requestJson(url.toString(), headers);
}

async function fetchSpreadsheetTitle(context, documentId) {
  const response = await requestSheetsJson(
    `/v4/spreadsheets/${encodeURIComponent(documentId)}`,
    context,
    {fields: 'properties/title'}
  );

  return response.data && response.data.properties && response.data.properties.title || documentId;
}

async function fetchSpreadsheetValuesBatch(context, documentId, sheetNames) {
  const response = await requestSheetsJson(
    `/v4/spreadsheets/${encodeURIComponent(documentId)}/values:batchGet`,
    context,
    {ranges: sheetNames}
  );

  const valueRanges = response.data.valueRanges || [];
  const rowsBySheet = {};

  for (let i = 0; i < sheetNames.length; i += 1) {
    const sheetName = sheetNames[i];
    rowsBySheet[sheetName] = valueRanges[i] && valueRanges[i].values ? valueRanges[i].values : [];
  }

  return rowsBySheet;
}

module.exports = {
  fetchSpreadsheetTitle,
  fetchSpreadsheetValuesBatch,
};