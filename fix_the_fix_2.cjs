const fs = require('fs');
const filepath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let code = fs.readFileSync(filepath, 'utf8');

code = code.replace(
  /        try \{\n        syncingCrosshair = true;\n        try \{/g,
  "        syncingCrosshair = true;\n        try {"
);

fs.writeFileSync(filepath, code);
console.log('Fixed the extra try FOR REAL!');
