const fs = require('fs');
const filepath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let code = fs.readFileSync(filepath, 'utf8');

if (!code.includes('function safeSetVisibleLogicalRange')) {
  const func = '\nfunction safeSetVisibleLogicalRange(chart: IChartApi | null | undefined, range: any): void {\n' +
    '  if (!chart || !range) return;\n' +
    '  try {\n' +
    '    chart.timeScale().setVisibleLogicalRange(range);\n' +
    '  } catch (e) {}\n' +
    '}\n';
  code = code.replace(/import .*?;\n\n/, match => match + func);
}

code = code.replace(/subscribeVisibleTimeRangeChange/g, 'subscribeVisibleLogicalRangeChange');
code = code.replace(/unsubscribeVisibleTimeRangeChange/g, 'unsubscribeVisibleLogicalRangeChange');
code = code.replace(/target\.timeScale\(\)\.setVisibleRange\(range\)/g, 'safeSetVisibleLogicalRange(target, range)');

fs.writeFileSync(filepath, code);
console.log('Restored LogicalRange!');
