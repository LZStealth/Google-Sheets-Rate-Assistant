## Google Sheets Rate Assistant

### Instructions

First fill out the config.json with the required information.


### Run
*Node must be installed on your system*

Download the .zip of the repository and extract into a folder.

1. Open Powershell in the directory
2. run `npm install`
3. run `node index`

### Config Extract

```
{
    "apiKey": "--- API key ---",
    "documents": [
        {
            "googleDocId": "--- Google Sheet ID ---",
            "sheets": [
                "-- Sheet Name ---",
                "-- 2nd Sheet Name ---"
            ],
            "pollRate": 1500
        },
        {
            "googleDocId": "--- 2nd Google Sheet ID ---",
            "sheets": [
                "-- Sheet Name ---"
            ],
            "pollRate": 10000
        }
    ]
}
```

+ Lowest PollRate for a single API key is recommended at 1200 to keep these under the free tier of 60 per minute.
+ Each API key should be different, this is not checked.
+ Multiple documents can be polled from a single key and the rate will be calculated.
+ Multiple sheets can be included under each 'googleDocId' and will not add to each APIKey rate limit.
