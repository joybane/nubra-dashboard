const fs = require('fs');

function patchFile(filepath, isBacktest = false, isTradeChart = false) {
  let code = fs.readFileSync(filepath, 'utf8');

  // 1. Change 120 back to 60
  code = code.replace(/minimumWidth: 120/g, 'minimumWidth: 60');

  // 2. Remove titles from addSeries calls so badges shrink to just the price numbers
  code = code.replace(/title: underlying \|\| 'Underlying',/g, '');
  code = code.replace(/title: leg\.displayName,/g, '');
  code = code.replace(/title: 'Total P&L',/g, '');
  code = code.replace(/title: src === 'net' \? k\.charAt\(0\)\.toUpperCase\(\) \+ k\.slice\(1\) : \`\$\{src\} \$\{k\.charAt\(0\)\.toUpperCase\(\) \+ k\.slice\(1\)\}\`,/g, '');

  // 3. Inject dummy series into the P&L chart to force left margin rendering
  const dummySeries = `
    // Force left margin for perfect crosshair alignment
    ${isBacktest ? 'pnlChart' : isTradeChart ? 'nc' : 'chart'}.addSeries(LineSeries, {
      priceScaleId: 'left',
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
      color: 'transparent',
    });
`;

  if (isTradeChart) {
    code = code.replace(/const totalS = nc\.addSeries\(LineSeries, \{[^\}]+\}\);/, match => match + dummySeries);
  } else if (isBacktest) {
    code = code.replace(/basketSeries = pnlChart\.addSeries\(LineSeries, \{[^\}]+\}\);/, match => match + dummySeries);
  } else {
    code = code.replace(/seriesRef\.current\.basketPnl = basketSeries;/, match => match + dummySeries);
  }

  fs.writeFileSync(filepath, code);
  console.log('Patched ' + filepath);
}

patchFile('e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx', false, false);
patchFile('e:/Derivativesproject/nubra-dashboard/src/NubraBacktest.tsx', true, false);
patchFile('e:/Derivativesproject/nubra-dashboard/src/backtest/TradeChartView.tsx', false, true);
