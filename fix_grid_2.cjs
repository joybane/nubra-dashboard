const fs = require('fs');
const filepath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let code = fs.readFileSync(filepath, 'utf8');

code = code.replace(/const grid = chartData\.underlyingBars\.map\(b => b\.time as number\);\n\n      for \(const src of GREEK_SOURCES\)/g, "const greeksGrid = chartData.underlyingBars.map(b => b.time as number);\n\n      for (const src of GREEK_SOURCES)");

code = code.replace(/fillGreeksToGrid\(grid,/g, "fillGreeksToGrid(greeksGrid,");

fs.writeFileSync(filepath, code);
console.log('Fixed Greeks grid!');
