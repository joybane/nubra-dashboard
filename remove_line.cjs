const fs = require('fs');
const filepath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let lines = fs.readFileSync(filepath, 'utf8').split('\n');

for (let i = 0; i < lines.length; i++) {
  if (lines[i] === '        try {' && lines[i+1] === '        syncingCrosshair = true;' && lines[i+2] === '        try {') {
    lines.splice(i, 1);
    break;
  }
}

fs.writeFileSync(filepath, lines.join('\n'));
console.log('Line removed!');
