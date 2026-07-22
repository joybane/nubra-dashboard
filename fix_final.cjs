const fs = require('fs');
const p = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let txt = fs.readFileSync(p, 'utf8');
let lines = txt.split('\n');

// 325 is index 324
// 377 is index 376
lines.splice(324, 377 - 325 + 1);

fs.writeFileSync(p, lines.join('\n'));
console.log("Deleted damaged lines!");
