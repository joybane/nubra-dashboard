const fs = require('fs');
const p = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let txt = fs.readFileSync(p, 'utf8');

// 1. Enable time scale for all charts
txt = txt.replace(/chartOpts\(isDark, true, true\)/g, 'chartOpts(isDark, false, true)');
txt = txt.replace(/chartOpts\(isDark, true\)/g, 'chartOpts(isDark, false)');

// 2. Fix the range sync from Logical to Time
txt = txt.replace(/getVisibleLogicalRange/g, 'getVisibleTimeRange');
txt = txt.replace(/setVisibleLogicalRange/g, 'setVisibleTimeRange');
txt = txt.replace(/safeSetVisibleLogicalRange/g, 'safeSetVisibleTimeRange');
txt = txt.replace(/subscribeVisibleLogicalRangeChange/g, 'subscribeVisibleTimeRangeChange');
txt = txt.replace(/unsubscribeVisibleLogicalRangeChange/g, 'unsubscribeVisibleTimeRangeChange');

fs.writeFileSync(p, txt);
console.log("Fixed time scale visibility and sync mechanism");
