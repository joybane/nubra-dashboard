const fs = require('fs');
const filepath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let code = fs.readFileSync(filepath + '.bak', 'utf8');

// 1. legPrice needs fillPnlToGrid to match the NIFTY grid perfectly, otherwise LogicalRange breaks
code = code.replace(
  /if \(data\) seriesRef\.current\.legPrice\.get\(leg\.refId\)\?\.setData\(data\.map\(d => \(\{ time: d\.time, value: d\.value \}\)\)\);/g,
  'if (data) seriesRef.current.legPrice.get(leg.refId)?.setData(fillPnlToGrid(grid, data.map(d => ({ time: d.time, value: d.value }))) as any);'
);

// 2. legPrice needs left scale to not squish NIFTY
code = code.replace(/priceScaleId:\s*'right'/g, "priceScaleId: 'left'");

// 3. hideTimeScale must be false so X-axis shows on all charts
code = code.replace(/chartOpts\(isDark,\s*true(?:,\s*true)?\)/g, match => {
  if (match.includes(', true, true')) return 'chartOpts(isDark, false, true)';
  return 'chartOpts(isDark, false)';
});

// 4. WebSocket option_chain listener should not setChartData and reset the chart every tick
code = code.replace(
  /setChartData\(\{ \.\.\.cached, legGreeksHist: new Map\(cached\.legGreeksHist\) \}\);/,
  '// setChartData({ ...cached, legGreeksHist: new Map(cached.legGreeksHist) });'
);

fs.writeFileSync(filepath, code);
console.log('Final fix applied to pristine .bak!');
