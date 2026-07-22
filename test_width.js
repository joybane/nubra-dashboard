const fs = require('fs');
const filepath = 'e:/Derivativesproject/nubra-dashboard/node_modules/lightweight-charts/dist/lightweight-charts.d.ts';
if (fs.existsSync(filepath)) {
  const code = fs.readFileSync(filepath, 'utf8');
  if (code.includes('width(): number;')) {
    console.log('HAS WIDTH()');
  } else {
    console.log('NO WIDTH()');
  }
}
