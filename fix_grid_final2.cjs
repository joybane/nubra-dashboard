const fs = require('fs');
const filepath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let lines = fs.readFileSync(filepath, 'utf8').split('\n');

for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('  useEffect(() => {') && lines[i+1] && lines[i+1].includes('if (!chartData) return;')) {
    if (lines[i+3] && lines[i+3].includes('const priceChart = priceChartRef.current;')) {
      lines.splice(i+2, 0, '    const grid = chartData.underlyingBars.map(b => b.time as number);');
      break;
    }
  }
}

fs.writeFileSync(filepath, lines.join('\n'));
console.log('Fixed grid FOR REAL!');
