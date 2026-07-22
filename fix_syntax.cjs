const fs = require('fs');
const p = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let txt = fs.readFileSync(p, 'utf8');

txt = txt.replace(/export default function StrategyAnalysisView\(\{\n\n  \/\/ Suppress lightweight-charts.*?\}, \[\]\);/s, `export default function StrategyAnalysisView({ basketGroupId, strategyName, theme, onBack, snapshotId }: StrategyAnalysisViewProps) {`);

fs.writeFileSync(p, txt);
console.log("Fixed syntax");
