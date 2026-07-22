const fs = require('fs');
const badPath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
const bakPath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx.bak';

const badLines = fs.readFileSync(badPath, 'utf8').split('\n');
const bakLines = fs.readFileSync(bakPath, 'utf8').split('\n');

const cutStart = badLines.findIndex(l => l.includes('  const greeksConfigRef = useRef({ mode: greeksMode'));
const cutEnd = badLines.findIndex(l => l.includes('        const t = nowChartTime();')) + 1; // around line 437 in bad file

const bakStart = bakLines.findIndex(l => l.includes('  const [lotSizeOverride, setLotSizeOverride]'));

// Find the 3rd or 4th setLegGreeks which is inside the option_chain listener!
let setLegGreeksCount = 0;
let bakEnd = -1;
for (let i = 0; i < bakLines.length; i++) {
  if (bakLines[i].includes('        setLegGreeks(prev => {')) {
    setLegGreeksCount++;
    if (setLegGreeksCount === 2) {
      bakEnd = i;
      break;
    }
  }
}

console.log('Bad file cut indices:', cutStart, cutEnd);
console.log('Bak file indices:', bakStart, bakEnd);

if (cutStart > 0 && bakStart > 0 && bakEnd > 0) {
  const newLines = [
    ...badLines.slice(0, cutStart),
    ...bakLines.slice(bakStart, bakEnd),
    ...badLines.slice(cutEnd) // Keep the injected live code
  ];
  fs.writeFileSync(badPath, newLines.join('\n'));
  console.log('Restored the missing lines properly!');
}
