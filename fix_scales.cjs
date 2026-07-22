const fs = require('fs');
const p = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let txt = fs.readFileSync(p, 'utf8');

// 1. Rollback TimeRange to LogicalRange
txt = txt.replace(/getVisibleRange/g, 'getVisibleLogicalRange');
txt = txt.replace(/setVisibleRange/g, 'setVisibleLogicalRange');
txt = txt.replace(/subscribeVisibleTimeRangeChange/g, 'subscribeVisibleLogicalRangeChange');
txt = txt.replace(/unsubscribeVisibleTimeRangeChange/g, 'unsubscribeVisibleLogicalRangeChange');

// 2. Ensure all 3 charts have time scale (false) AND left scale (true)
txt = txt.replace(/chartOpts\(isDark, false, true\)/g, 'chartOpts(isDark, false, true)');
txt = txt.replace(/chartOpts\(isDark, false\)/g, 'chartOpts(isDark, false, true)');
txt = txt.replace(/chartOpts\(isDark\)/g, 'chartOpts(isDark, false, true)');

fs.writeFileSync(p, txt);
console.log("Fixed: LogicalRange restored, left scale enabled on all charts.");
