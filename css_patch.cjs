const fs = require('fs');

function applyCssFix(filepath, isBacktest = false, isTradeChart = false) {
  let code = fs.readFileSync(filepath, 'utf8');

  // 1. Remove the dummy series I added previously
  code = code.replace(/\/\/ Force left margin for perfect crosshair alignment[\s\S]*?color: 'transparent',\s*\}\);/g, '');

  // 2. Modify chartOpts to accept hideLeftScale and apply it to leftPriceScale.visible
  // Find: function chartOpts(isDark: boolean, hideTimeScale: boolean = false, showLeftScale: boolean = false) {
  // Wait, I might have modified it to not have showLeftScale. Let's just replace the whole chartOpts signature.
  code = code.replace(/function chartOpts\(isDark: boolean, hideTimeScale: boolean = false.*?\) \{/g, 'function chartOpts(isDark: boolean, hideTimeScale: boolean = false, hideLeftScale: boolean = false) {');
  
  // Find leftPriceScale: { visible: true, borderVisible: false, minimumWidth: 60 },
  code = code.replace(/leftPriceScale:\s*\{\s*visible:\s*true,/g, 'leftPriceScale: { visible: !hideLeftScale,');

  // 3. Pass true for hideLeftScale in P&L chart creation
  if (isTradeChart) {
    code = code.replace(/const nc = createChart\(pnlRef\.current, chartOpts\(\)\);/, 'const nc = createChart(pnlRef.current, chartOpts(false, false, true));');
    // Also need to pass false, false for priceChart and greeksChart to match signature? 
    // chartOpts in TradeChart doesn't have args currently: function chartOpts() { ... }
    // Let's modify TradeChart chartOpts specifically:
    code = code.replace(/function chartOpts\(\) \{/, 'function chartOpts(isDark = false, hideTimeScale = false, hideLeftScale = false) {');
    // And add padding to pnlChart div
    code = code.replace(/<div ref=\{pnlRef\} style=\{\{ height: pnlHeight, minHeight: 40, position: 'relative' \}\}>/, '<div ref={pnlRef} style={{ height: pnlHeight, minHeight: 40, position: \'relative\', paddingLeft: 60, boxSizing: \'border-box\' }}>');
  } else if (isBacktest) {
    code = code.replace(/const pnlChart = createChart\(pnlChartContainerRef\.current, chartOpts\(isDark, hideTime\)\);/, 'const pnlChart = createChart(pnlChartContainerRef.current, chartOpts(isDark, hideTime, true));');
    code = code.replace(/<div ref=\{pnlChartContainerRef\} style=\{\{ height: pnlHeight, minHeight: 40, position: 'relative'.*?\}\}>/, match => match.replace(/position: 'relative'/, 'position: \'relative\', paddingLeft: 60, boxSizing: \'border-box\''));
  } else {
    code = code.replace(/const chart = createChart\(pnlChartContainerRef\.current, chartOpts\(isDark, hideTime\)\);/, 'const chart = createChart(pnlChartContainerRef.current, chartOpts(isDark, hideTime, true));');
    code = code.replace(/<div ref=\{pnlChartContainerRef\} style=\{\{ height: pnlHeight, minHeight: 40, position: 'relative'.*?\}\}>/, match => match.replace(/position: 'relative'/, 'position: \'relative\', paddingLeft: 60, boxSizing: \'border-box\''));
  }

  fs.writeFileSync(filepath, code);
  console.log('Fixed CSS padding for ' + filepath);
}

applyCssFix('e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx', false, false);
applyCssFix('e:/Derivativesproject/nubra-dashboard/src/NubraBacktest.tsx', true, false);
applyCssFix('e:/Derivativesproject/nubra-dashboard/src/backtest/TradeChartView.tsx', false, true);
