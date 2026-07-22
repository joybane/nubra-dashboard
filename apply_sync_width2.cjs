const fs = require('fs');
const p = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let txt = fs.readFileSync(p, 'utf8');

txt = txt.replace(/clearInterval\(pollTimer\);\s*ro\.disconnect\(\);/, `clearInterval(pollTimer);\n        ro.disconnect();\n        if (widthSyncInterval) clearInterval(widthSyncInterval);`);

fs.writeFileSync(p, txt);
console.log("Dynamically synced widths injected properly!");
