# Google Service Account Setup for Google Sheets Rate Assistant

This guide explains how to create a Google service account, enable the Sheets API, and configure the project to use service account credentials.

## 1. Enable the Google Sheets API

1. Open the Google Cloud Console: https://console.cloud.google.com/
2. Select an existing project or create a new one.
3. In the left menu, open **APIs & Services > Library**.
4. Search for **Google Sheets API** and click it.
5. Click **Enable**.

## 2. Create a service account

1. In the Cloud Console, open **IAM & Admin > Service Accounts**.
2. Click **Create Service Account**.
3. Enter a name and description.
4. Click **Create and continue**.
5. Skip granting optional roles or add a minimal role if required.
6. Click **Done**.

## 3. Create and download credentials

1. Find the service account you created in the list.
2. Click the service account name.
3. Open the **Keys** tab.
4. Click **Add Key > Create new key**.
5. Choose **JSON** and click **Create**.
6. Save the downloaded JSON file securely in your project folder, for example `credentials.json`.

## 4. Share your Google Sheets with the service account

1. Open the Google Sheet you want to export.
2. Click **Share**.
3. Add the service account email address, which looks like `...@...iam.gserviceaccount.com`.
4. Give it **Viewer** access.

## 5. Configure the project

In `config.json`, add the service account credentials under the `serviceAccounts` array. Here's an example using service account authentication:

```json
{
  "serviceAccounts": [
    {
      "path": "credentials.json",
      "rateLimitPerMinute": 50
    },
    {
      "path": "credentials_2.json",
      "rateLimitPerMinute": 50
    }
  ],
  "documents": [
    {
      "documentId": "YOUR_SPREADSHEET_ID",
      "outputDir": "output/your-document",
      "sheets": [
        {
          "name": "Sheet1",
          "outputFilename": "sheet1.csv"
        }
      ]
    }
  ]
}
```

The app will round-robin requests across configured accounts and respect `rateLimitPerMinute` values.