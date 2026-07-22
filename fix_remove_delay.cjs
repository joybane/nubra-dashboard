const fs = require('fs');
const filepath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let code = fs.readFileSync(filepath, 'utf8');

code = code.replace(
  /try \{ chart\.remove\(\); \} catch \{\}/g,
  "setTimeout(() => { try { chart.remove(); } catch {} }, 100);"
);

fs.writeFileSync(filepath, code);
console.log('Fixed chart.remove delay!');
