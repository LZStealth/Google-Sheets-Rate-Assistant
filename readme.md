# Google Sheets Rate Assistant

This Node.js application pulls configured Google Sheets documents and exports them as CSV files.

## Setup

Download the latest version from the [Releases tab](./releases) and run it.

1. If `config.json` does not exist, the app will ask whether you want a wizard or a starter config file.
2. If you choose the config-file path instead of the wizard, configure authentication in `config.json` — choose one of:

- Service account: place your service account JSON in `credentials.json` and set `credentialsPath`, or add one or more entries to the `serviceAccounts` array (each entry may be a path string or an object with `path` and optional `rateLimitPerMinute`).
- API keys: add one or more API keys to the `apiKeys` array in `config.json` (each entry may be a string or an object with `key` and optional `rateLimitPerMinute`).

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

**Warning:** If you configure multiple `apiKeys` or `serviceAccounts`, ensure each credential comes from a different Google Cloud project. Keys or service accounts created within the same project share the same underlying quota and will still hit the same project-level rate limits, causing throttling despite multiple credentials being supplied.

## Output

CSV files are written to `output` by default. The onboarding wizard uses that output directory automatically and names each file after the sheet.

If `config.json` is missing, the app creates a starter file next to the executable when packaged, or in the current working directory when running from source, and exits so you can fill it in before the next run.

If you choose the wizard, it will ask for the auth method, credential count, document count, and sheet names. It will not ask for output directories or file names.

## AI Disclosure

A large chunk of the project was coded using AI, this is the first pass at integrating some AI assistance into my projects. However all code written has been verified and checked before submission. AI use has only been included since the v2 rewrite.
While this project isn't intended for general usage i've chosen to be clear on the subject.
