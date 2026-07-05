# Google Sheets Rate Assistant

This Node.js application pulls configured Google Sheets documents and exports them as CSV files.

## Setup

1. Copy `config.example.json` to `config.json`.
2. Configure authentication in `config.json` — choose one of:

- Service account: place your service account JSON in `credentials.json` and set `credentialsPath`, or add one or more entries to the `serviceAccounts` array (each entry may be a path string or an object with `path` and optional `rateLimitPerMinute`).
- API keys: add one or more API keys to the `apiKeys` array in `config.json` (each entry may be a string or an object with `key` and optional `rateLimitPerMinute`).

3. Install dependencies:

  npm install

4. Run the application:

  node index.js

## Setup Guides

For detailed instructions on authentication methods, please refer to the following guides:

- [Service Account Setup](./GUIDE_SERVICE_ACCOUNT.md)
- [API Key Setup Guide](./GUIDE_API_KEY.md)

### Sample `config.json`

Here is an example `config.json` matching the repository's `config.example.json`:

```json
{
  "apiKeys": [
    { "key": "YOUR_API_KEY_1", "rateLimitPerMinute": 50 },
    { "key": "YOUR_API_KEY_2", "rateLimitPerMinute": 50 }
  ],
  "serviceAccounts": [
    { "path": "credentials.json", "rateLimitPerMinute": 50 },
    { "path": "credentials_2.json", "rateLimitPerMinute": 50 }
  ],
  "documents": [
    {
      "documentId": "YOUR_SPREADSHEET_ID",
      "outputDir": "output/your-document",
      "sheets": [
        { "name": "Sheet1", "outputFilename": "sheet1.csv" },
        { "name": "Sheet2", "outputFilename": "sheet2.csv" }
      ]
    }
  ]
}
```

Your `config.json` should ONLY contain `apiKeys` OR `serviceAccounts`.

## Rate limiting

The app enforces a maximum of `rateLimitPerMinute` requests per minute to avoid exceeding API limits.
There is a 5% buffer applied to any limitation to cater for any network fluctuations. A rate limit of 50 will only call 47.5 times (rounded down to 47).

## Output

CSV files are written to `output` by default. Individual documents may override this with their own `outputDir` in `config.json`.
