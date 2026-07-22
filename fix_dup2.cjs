const fs = require('fs');
const p = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let txt = fs.readFileSync(p, 'utf8');

// Find rightPriceScale block and fix it
const target = /rightPriceScale:\s*\{[\s\S]*?\},/;
const match = txt.match(target);
if (match) {
  let block = match[0];
  console.log("Found block:\n" + block);
  let lines = block.split('\n');
  let seen = false;
  let newLines = [];
  for (let l of lines) {
    if (l.includes('minimumWidth:')) {
      if (!seen) {
        seen = true;
        newLines.push(l);
      }
    } else {
      newLines.push(l);
    }
  }
  txt = txt.replace(block, newLines.join('\n'));
  fs.writeFileSync(p, txt);
  console.log("Duplicate completely removed via regex.");
}
