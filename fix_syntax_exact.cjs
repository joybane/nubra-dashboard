const fs = require('fs');
const filepath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let code = fs.readFileSync(filepath, 'utf8');
const lines = code.split('\n');

if (lines[1621].includes('});')) {
  lines[1621] = '      } catch (e) {}\n' + lines[1621];
}

fs.writeFileSync(filepath, lines.join('\n'));
console.log('Fixed syntax exact!');
