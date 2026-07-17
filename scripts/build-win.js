const fs = require('fs');
const path = require('path');
const {exec} = require('pkg');
const {version: packageVersion} = require('../package.json');

function normalizeBuildVersion(value) {
  const version = (value || packageVersion || '0.0.0').toString().trim();
  return version.startsWith('v') ? version : `v${version}`;
}

async function main() {
  const distDir = path.resolve(__dirname, '..', 'dist');
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, {recursive: true});
  }

  const buildVersion = normalizeBuildVersion(process.env.BUILD_VERSION);
  const outputFile = path.join(distDir, `gSheets-Rate-Assistant-${buildVersion}.exe`);
  await exec(['.', '--targets', 'latest-win-x64', '--output', outputFile]);
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
