const fs = require('fs');
const p = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let txt = fs.readFileSync(p, 'utf8');

txt = txt.replace(/try \{ chart\.remove\(\); \} catch \{\}/g, 'try { chart.remove(); } catch (e) { console.error("chart.remove failed:", e); }');

fs.writeFileSync(p, txt);
console.log("Injected error logging for chart.remove");
