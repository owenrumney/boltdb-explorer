const fs = require('fs');
const path = require('path');
const binDir = path.join(__dirname, '../bin');
const files = fs.readdirSync(binDir).filter(f => f.startsWith('bolthelper-'));
console.log('Packaged binaries:', files);
