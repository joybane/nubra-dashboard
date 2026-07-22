const fs = require('fs');
const filepath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
const backup = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx.tmp.12120.8d8c78eea9b2';

let code = fs.readFileSync(backup, 'utf8');

// 1. Convert subscribeVisibleLogicalRangeChange to subscribeVisibleTimeRangeChange
const syncCodeOld = `        const h1 = (range: any) => { if (syncing || !range) return; syncing = true; try { b.timeScale().setVisibleLogicalRange(range); } catch {} syncing = false; };
        const h2 = (range: any) => { if (syncing || !range) return; syncing = true; try { a.timeScale().setVisibleLogicalRange(range); } catch {} syncing = false; };
        a.timeScale().subscribeVisibleLogicalRangeChange(h1);
        b.timeScale().subscribeVisibleLogicalRangeChange(h2);
        unsubs.push(() => { try { a.timeScale().unsubscribeVisibleLogicalRangeChange(h1); } catch {} try { b.timeScale().unsubscribeVisibleLogicalRangeChange(h2); } catch {} });`;

const syncCodeNew = `        const h1 = (range: any) => { if (syncing || !range) return; syncing = true; try { b.timeScale().setVisibleRange(range); } catch {} syncing = false; };
        const h2 = (range: any) => { if (syncing || !range) return; syncing = true; try { a.timeScale().setVisibleRange(range); } catch {} syncing = false; };
        a.timeScale().subscribeVisibleTimeRangeChange(h1);
        b.timeScale().subscribeVisibleTimeRangeChange(h2);
        unsubs.push(() => { try { a.timeScale().unsubscribeVisibleTimeRangeChange(h1); } catch {} try { b.timeScale().unsubscribeVisibleTimeRangeChange(h2); } catch {} });`;

code = code.replace(syncCodeOld, syncCodeNew);

// 2. Fix Left Scales and Widths (similar to ultimate_sync)
code = code.replace(/function chartOpts\(isDark: boolean\) \{/, 'function chartOpts(isDark: boolean, hideLeftScale: boolean = false) {');
code = code.replace(/leftPriceScale:\s*\{\s*visible:\s*true,/, 'leftPriceScale: { visible: !hideLeftScale,\n      borderVisible: false,\n      minimumWidth: 75,');
code = code.replace(/rightPriceScale:\s*\{/, 'rightPriceScale: {\n      minimumWidth: 75,');

code = code.replace(/const chart = createChart\(pnlChartContainerRef\.current, chartOpts\(isDark\)\);/, 'const chart = createChart(pnlChartContainerRef.current, chartOpts(isDark, true));');
code = code.replace(/<div ref=\{pnlChartContainerRef\} style=\{\{ height: pnlHeight, minHeight: 40, position: 'relative' \}\}>/, '<div ref={pnlChartContainerRef} style={{ height: pnlHeight, minHeight: 40, position: \'relative\', paddingLeft: 75, boxSizing: \'border-box\' }}>');

code = code.replace(/priceScaleId: 'legs',/g, 'priceScaleId: \'left\',');

// Greeks scale forced to minimumWidth: 75
code = code.replace(/chart\.priceScale\(k\)\.applyOptions\(\{ scaleMargins:/g, 'chart.priceScale(k).applyOptions({ minimumWidth: 75, scaleMargins:');

fs.writeFileSync(filepath, code);
console.log("Restored backup and applied TimeRange and Alignment fixes!");
