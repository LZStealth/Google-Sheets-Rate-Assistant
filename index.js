const { GoogleSpreadsheet } = require('google-spreadsheet');
const fs = require('fs');
const readline = require('readline').createInterface({
    input: process.stdin,
    output: process.stdout,
});
const config = require('./config.json');

const check = new Promise(function (resolve) {
    var count = 0;
    config.apis.forEach(function (document, d) {
        var totalRate = 0;
        document.documents.forEach(function (item, i) {
            count += 1;
            totalRate += (60 / (item.pollRate / 1000));
            config.apis[d].documents[i].sheets.itemNo = count;
        });
        var stdin = process.openStdin();
        if (totalRate > 50) {
            console.log('\n---------- RATE LIMIT WARNING ----------');
            readline.question(`\nYour poll rate will be ${totalRate} per minute, this is above the recommendation of 50 per minute.\nIf the GoogleAPI limit is reached (60 per min on free) you will receive no updates until a break period has passed.\n(API: ${document.apiKey})\n\nAre you sure you want to continue? [y/n]: `, answer => {
                if (answer == 'y') {
                    readline.close();
                    resolve();
                } else {
                    process.exit();
                }
            });
        } else if (config.apis.length == count) {
            resolve();
        }
    });
})

check.then(function () {
    console.clear();
    process.stdout.cursorTo(0, 1);
    console.log(`Ctrl+C to kill the application.`);
    config.apis.forEach(api => {
        api.documents.forEach(docs => {
            const doc = new GoogleSpreadsheet(docs.googleDocId);
            doc.useApiKey(api.apiKey);

            setInterval(function () {
                (async function () {
                    await doc.loadInfo();
                    if (!fs.existsSync(`${config.outputFolder}/${doc.title}/`)) {
                        fs.mkdirSync(`${config.outputFolder}/${doc.title}/`, { recursive: true });
                    }
                    docs.sheets.forEach(sheet => {
                        (async function () {
                            downloadCSV = await doc.sheetsByTitle[sheet].downloadAsCSV();
                            fs.writeFile(`${config.outputFolder}/${doc.title}/${sheet}.csv`, downloadCSV, function (err) {
                                if (err) {
                                    return console.log(err);
                                }
                                const d = new Date();
                                process.stdout.cursorTo(0, docs.sheets.itemNo + 2);
                                process.stdout.clearLine();
                                console.log(`"${doc.title} - ${sheet}" last updated at ${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}`);
                                process.stdout.cursorTo(31, 1);
                            });
                        }());
                    });
                }());
            }, docs.pollRate)
        });

    });
}, function (err) {
    console.log(err);
})


function pad(n, width, z) {
    z = z || '0';
    n = n + '';
    return n.length >= width ? n : new Array(width - n.length + 1).join(z) + n;
}