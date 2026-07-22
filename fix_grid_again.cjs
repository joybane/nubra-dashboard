const fs = require('fs');
const filepath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let code = fs.readFileSync(filepath, 'utf8');

code = code.replace(/if \(\!chartData\) return;\n/, "if (!chartData) return;\n    const grid = chartData.underlyingBars.map(b => b.time as number);\n");

fs.writeFileSync(filepath, code);
console.log('Fixed grid declaration again!');
