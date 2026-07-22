const fs = require('fs');
const filepath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let code = fs.readFileSync(filepath, 'utf8');

const lines = code.split('\n');

for (let i = 1030; i < 1100; i++) {
  if (lines[i] && lines[i].includes('cached.underlyingBars')) {
    lines[i] = lines[i].replace('cached.underlyingBars', 'chartData.underlyingBars');
  }
}

code = lines.join('\n');
fs.writeFileSync(filepath, code);
console.log('Fixed cached references');
