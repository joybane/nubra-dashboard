const fs = require('fs');

function comprehensiveSyncPatch(filepath, isBacktest = false, isTradeChart = false) {
  let code = fs.readFileSync(filepath, 'utf8');

  // 1. Update chartOpts minimumWidths to 75
  code = code.replace(/minimumWidth:\s*60/g, 'minimumWidth: 75');

  // 2. Change CSS paddingLeft to 75
  code = code.replace(/paddingLeft:\s*60/g, 'paddingLeft: 75');

  // 3. Move legPnl to priceScaleId: 'right' (since it's P&L, it MUST share scale with Total P&L)
  // Find: color: leg.color, lineWidth: 2, priceScaleId: 'left',  <-- Wait, both legPrice and legPnl use this!
  // I only want to change it for legPnl.
  if (isTradeChart) {
    // In TradeChartView:
    // It's TradeChartView.tsx, legPnl isn't added there manually per leg, it's a single static chart?
    // Let's check TradeChartView manually later, or just replace for legPnl in the others first.
  }

  // StrategyAnalysisView & NubraBacktest:
  // Find where legPnl is created:
  // seriesRef.current.legPnl... addSeries
  code = code.replace(/(\.legPnl[\s\S]*?addSeries\([\s\S]*?)priceScaleId:\s*'left'/g, '$1priceScaleId: \'right\'');

  // 4. Force Greek custom scales to have minimumWidth: 75
  code = code.replace(/chart\.priceScale\(k\)\.applyOptions\(\{\s*scaleMargins/g, 'chart.priceScale(k).applyOptions({ minimumWidth: 75, scaleMargins');
  code = code.replace(/gc\.priceScale\(k\)\.applyOptions\(\{\s*scaleMargins/g, 'gc.priceScale(k).applyOptions({ minimumWidth: 75, scaleMargins');

  fs.writeFileSync(filepath, code);
  console.log('Patched ' + filepath);
}

comprehensiveSyncPatch('e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx', false, false);
comprehensiveSyncPatch('e:/Derivativesproject/nubra-dashboard/src/NubraBacktest.tsx', true, false);
comprehensiveSyncPatch('e:/Derivativesproject/nubra-dashboard/src/backtest/TradeChartView.tsx', false, true);
