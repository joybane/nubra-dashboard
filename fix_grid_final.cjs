const fs = require('fs');
const filepath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let code = fs.readFileSync(filepath, 'utf8');

code = code.replace(
  "  useEffect(() => {\n    if (!chartData) return;\n\n    const priceChart = priceChartRef.current;",
  "  useEffect(() => {\n    if (!chartData) return;\n    const grid = chartData.underlyingBars.map(b => b.time as number);\n\n    const priceChart = priceChartRef.current;"
);

fs.writeFileSync(filepath, code);
console.log('Fixed grid!');
