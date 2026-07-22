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

// 5. Provide grid to legPrice by moving it up in the useEffect block
code = code.replace(
  /if \(\!chartData\) return;\n/,
  "if (!chartData) return;\n    const grid = chartData.underlyingBars.map(b => b.time as number);\n"
);

// Remove the first grid duplicate in the PnL block
code = code.replace(
  /\/\/ Shared full-session grid\n\s*const grid = chartData\.underlyingBars\.map\(b => b\.time as number\);\n/,
  ''
);

// Rename the grid duplicate in the Greeks block to greeksGrid
code = code.replace(
  /\/\/ Same full-session grid as the P&L pane so greeks time-align with the other charts \(whitespace pad\)\.\n\s*const grid = chartData\.underlyingBars\.map\(b => b\.time as number\);\n/,
  "// Same full-session grid as the P&L pane so greeks time-align with the other charts (whitespace pad).\n      const greeksGrid = chartData.underlyingBars.map(b => b.time as number);\n"
);
code = code.replace(/fillGreeksToGrid\(grid,/g, "fillGreeksToGrid(greeksGrid,");

fs.writeFileSync(filepath, code);
console.log('Fixed everything successfully on pristine .bak!');
