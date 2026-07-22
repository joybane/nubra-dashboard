const fs = require('fs');
const filepath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let code = fs.readFileSync(filepath, 'utf8');

code = code.replace(
  /        if \(syncingCrosshair\) return;\n        try \{\n        syncingCrosshair = true;\n        try \{/g,
  "        if (syncingCrosshair) return;\n        syncingCrosshair = true;\n        try {"
);

fs.writeFileSync(filepath, code);
console.log('Fixed the extra try!');
