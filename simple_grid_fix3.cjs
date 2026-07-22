const fs = require('fs');
const filepath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let code = fs.readFileSync(filepath, 'utf8');
const lines = code.split('\n');

for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('// ? 3b. Apply fetched data to existing charts ?')) {
    // Insert after "if (!chartData) return;"
    for (let j = i; j < i + 10; j++) {
      if (lines[j].includes('if (!chartData) return;')) {
        // Wait, did my splice work previously but maybe it didn't save?
        // Ah, splice changes the array length. But if I break, it's fine.
        lines.splice(j + 1, 0, '    const grid = chartData.underlyingBars.map(b => b.time as number);');
        break;
      }
    }
    break; // Break the outer loop too, so we don't insert multiple times
  }
}

fs.writeFileSync(filepath, lines.join('\n'));
console.log('Simple grid fixed natively AGAIN!');
