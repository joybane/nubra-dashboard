const fs = require('fs');
const p = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let txt = fs.readFileSync(p, 'utf8');

txt = txt.replace(/minimumWidth: 110,\s*/g, '');
fs.writeFileSync(p, txt);
console.log("minimumWidth removed from chartOpts");
