const { build } = require('@zeit/ncc');
const fs = require('fs');
const path = require('path');

(async () => {
  const { code } = await build(path.join(__dirname, '../bin/next'));
  const outputPath = path.join(__dirname, '../dist/bin/next');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, code);
})();
