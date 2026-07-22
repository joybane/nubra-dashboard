const fs = require('fs');
const filepath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let code = fs.readFileSync(filepath, 'utf8');
const lines = code.split('\n');

for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('// ? 3b. Apply fetched data to existing charts ?')) {
    // Look for if (!chartData) return;
    for (let j = i; j < i + 10; j++) {
      if (lines[j].includes('if (!chartData) return;')) {
        lines.splice(j + 1, 0, '    const grid = chartData.underlyingBars.map(b => b.time as number);');
        break;
      }
    }
  }

  if (lines[i].includes('// Shared full-session grid')) {
    lines[i] = '';
    lines[i+1] = ''; // const grid = ...
  }

  if (lines[i].includes('// Same full-session grid as the P&L pane so greeks time-align with the other charts (whitespace pad).')) {
    lines[i+1] = '    const greeksGrid = chartData.underlyingBars.map(b => b.time as number);';
  }
}

fs.writeFileSync(filepath, lines.join('\n'));
console.log('Simple grid fixed natively!');
