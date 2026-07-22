const fs = require('fs');
const badPath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
const bakPath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx.bak';

const badLines = fs.readFileSync(badPath, 'utf8').split('\n');
const bakLines = fs.readFileSync(bakPath, 'utf8').split('\n');

const bakStart = bakLines.findIndex(l => l.includes('  const [lotSizeOverride, setLotSizeOverride]'));

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

// bad file top part: from 0 to where it says lotSizeOverride
const cutStart = badLines.findIndex(l => l.includes('  const [lotSizeOverride, setLotSizeOverride]'));
// bad file bottom part: from the first '        const t = nowChartTime();' we can find, but actually that's gone.
// Where does the bad file resume? Let's find '    return () => unsub();' which is after the missing block.
const cutEnd = badLines.findIndex(l => l.includes('    return () => unsub();'));

if (cutStart > 0 && bakStart > 0 && bakEnd > 0 && cutEnd > 0) {
  const newLines = [
    ...badLines.slice(0, cutStart),
    ...bakLines.slice(bakStart, bakEnd),
    ...badLines.slice(cutEnd - 2) // just before '    return () => unsub();' there's some closing braces
  ];
  fs.writeFileSync(badPath, newLines.join('\n'));
  console.log('Restored the missing lines perfectly!');
} else {
  console.log('Indices:', cutStart, bakStart, bakEnd, cutEnd);
}
