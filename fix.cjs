const fs = require('fs');
const p = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let txt = fs.readFileSync(p, 'utf8');

const t1 = txt.includes('const [lotSizeOverride, setLotSizeOverride]');
const t2 = txt.includes('// setChartData({ ...cached, legGreeksHist: new Map(cached.legGreeksHist) });');
console.log('t1:', t1, 't2:', t2);
