const fs = require('fs');
const filepath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let code = fs.readFileSync(filepath, 'utf8');

// 1. Make timeScale visible on all charts
code = code.replace(/chartOpts\(isDark,\s*true(?:,\s*true)?\)/g, match => {
  if (match.includes(', true, true')) return 'chartOpts(isDark, false, true)';
  return 'chartOpts(isDark, false)';
});

// 2. Change sync logic to VisibleTimeRange
code = code.replace(/subscribeVisibleLogicalRangeChange/g, 'subscribeVisibleTimeRangeChange');
code = code.replace(/unsubscribeVisibleLogicalRangeChange/g, 'unsubscribeVisibleTimeRangeChange');
code = code.replace(/getVisibleLogicalRange/g, 'getVisibleRange');
code = code.replace(/safeSetVisibleLogicalRange\(pnlChartRef\.current, r\)/g, 'try { pnlChartRef.current?.timeScale().setVisibleRange(r); } catch {}');
code = code.replace(/safeSetVisibleLogicalRange\(greeksChartRef\.current, r\)/g, 'try { greeksChartRef.current?.timeScale().setVisibleRange(r); } catch {}');
code = code.replace(/safeSetVisibleLogicalRange\(c, masterRange\)/g, 'try { c.timeScale().setVisibleRange(masterRange); } catch {}');
code = code.replace(/safeSetVisibleLogicalRange\(target, range\)/g, 'try { target.timeScale().setVisibleRange(range); } catch {}');
code = code.replace(/setVisibleLogicalRange/g, 'setVisibleRange');

fs.writeFileSync(filepath, code);
console.log('Fixed sync and scales!');
