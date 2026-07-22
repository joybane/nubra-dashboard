const fs = require('fs');
const filepath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let code = fs.readFileSync(filepath, 'utf8');

code = code.replace(
  /\/\/ ? 3b\. Apply fetched data to existing charts ?\n\s*useEffect\(\(\) => \{\n\s*if \(\!chartData\) return;\n\s*try \{\n/,
  "// ? 3b. Apply fetched data to existing charts ?\n  useEffect(() => {\n    if (!chartData) return;\n    try {\n    const grid = chartData.underlyingBars.map(b => b.time as number);\n"
);
code = code.replace(
  /    \/\/ Shared full-session grid\n\s*const grid = chartData\.underlyingBars\.map\(b => b\.time as number\);\n/,
  ""
);

code = code.replace(
  /    \/\/ Same full-session grid as the P&L pane so greeks time-align with the other charts \(whitespace pad\)\.\n\s*const grid = chartData\.underlyingBars\.map\(b => b\.time as number\);\n/,
  "    // Same full-session grid as the P&L pane so greeks time-align with the other charts (whitespace pad).\n    const greeksGrid = chartData.underlyingBars.map(b => b.time as number);\n"
);

fs.writeFileSync(filepath, code);
console.log('Fixed grids!');
