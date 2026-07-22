const fs = require('fs');
const p = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let txt = fs.readFileSync(p, 'utf8');

txt = txt.replace(/getVisibleTimeRange/g, 'getVisibleRange');
txt = txt.replace(/setVisibleTimeRange/g, 'setVisibleRange');
txt = txt.replace(/safeSetVisibleRange/g, 'safeSetVisibleRange');

fs.writeFileSync(p, txt);
console.log("Fixed method names to getVisibleRange / setVisibleRange");
