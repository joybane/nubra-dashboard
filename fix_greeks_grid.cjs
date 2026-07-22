const fs = require('fs');
const filepath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let code = fs.readFileSync(filepath, 'utf8');

code = code.replace(/for \(const src of GREEK_SOURCES\)/, "const greeksGrid = chartData.underlyingBars.map(b => b.time as number);\n      for (const src of GREEK_SOURCES)");

fs.writeFileSync(filepath, code);
console.log('Added greeksGrid back!');
