const fs = require('fs');
const filepath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let code = fs.readFileSync(filepath, 'utf8');

code = code.replace(
  /const greeksChart = greeksChartRef\.current;\n\s*if \(greeksChart && seriesRef\.current\.underlying\) \{/,
  "const greeksChart = greeksChartRef.current;\n    if (greeksChart && seriesRef.current.underlying) {\n      const greeksGrid = chartData.underlyingBars.map(b => b.time as number);"
);

fs.writeFileSync(filepath, code);
console.log('Fixed greeksGrid!');
