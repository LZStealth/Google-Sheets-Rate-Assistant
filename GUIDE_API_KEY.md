# API Key Setup Guide

This guide explains how to create and configure API keys for use with the Google Sheets Rate Assistant. The application expects an `apiKeys` array in `config.json` (even a single key should be provided as a single-element array).

## Overview

- The app supports using API keys instead of a service account by providing an `apiKeys` array in `config.json`.
- Each entry in `apiKeys` may be a string (the key) or an object with `{ key, rateLimitPerMinute }`.

## Create an API key

1. Go to the Google Cloud Console: https://console.cloud.google.com/
2. Select or create a project.
3. Enable the **Google Sheets API** (and **Drive API** if you need it) under "APIs & Services > Library".
4. Go to "APIs & Services > Credentials" and click **Create credentials > API key**. Copy the key value.

## Secure the key

- Click **Restrict key** on the credentials page and set:
  - Application restrictions (IP addresses or HTTP referrers) where possible.
  - API restrictions: select **Google Sheets API** only.
- Do not leave keys unrestricted in production.

## Example `config.json` snippet

To configure one key:

```json
{
  "apiKeys": [
    "YOUR_API_KEY_1"
  ]
}
```

To configure multiple keys with per-key rate limits:

```json
{
  "apiKeys": [
    { "key": "API_KEY_1", "rateLimitPerMinute": 60 },
    { "key": "API_KEY_2", "rateLimitPerMinute": 30 }
  ]
}
```

The app will round-robin requests across configured keys and respect `rateLimitPerMinute` values.

## Storing keys safely

- Do not commit `config.json` with keys to version control. Add `config.json` to `.gitignore`.
- Alternatively, keep a `config.json.example` in the repo and place the real keys in a local `config.json`.
- If you prefer to use environment variables, you can have a small loader script that reads an env var and writes `config.json` before running the app.

## Troubleshooting

- If you get quota or 403 errors, check API restrictions, project quotas, and whether the key is restricted to the wrong IP/referrer.
- Use multiple keys to spread requests if you hit per-key quotas.

*** End of guide ***
