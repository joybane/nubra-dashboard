
const fs = require('fs');
const file = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let code = fs.readFileSync(file, 'utf8');

// 1. Fix leftPriceScale to use showLeftScale and minimumWidth: 75
code = code.replace(
  /leftPriceScale:\s*\{\s*visible:\s*false,\s*borderColor:\s*isDark \? '#2a2d32' : '#e0e3eb',\s*\}/,
  \leftPriceScale: {
      visible: showLeftScale,
      borderColor: isDark ? '#2a2d32' : '#e0e3eb',
      minimumWidth: 75,
    }\
);

// 2. Fix legPrice priceScaleId from right to left
code = code.replace(
  /const s = priceChart\.addSeries\(LineSeries, \{\s*color: leg\.color, lineWidth: 2, priceScaleId: 'right',/,
  \const s = priceChart.addSeries(LineSeries, {
              color: leg.color, lineWidth: 2, priceScaleId: 'left',\
);

// 3. Fix pnlChartContainerRef and greeksChartContainerRef padding
code = code.replace(
  /<div ref=\{pnlChartContainerRef\} style=\{\{ height: pnlHeight, minHeight: 40, position: 'relative'(.*?) \}\}>/,
  \<div ref={pnlChartContainerRef} style={{ height: pnlHeight, minHeight: 40, position: 'relative', paddingLeft: 75, boxSizing: 'border-box' }}>\
);
code = code.replace(
  /<div ref=\{greeksChartContainerRef\} style=\{\{ height: greeksChartHeight, minHeight: 40, position: 'relative'(.*?) \}\}>/,
  \<div ref={greeksChartContainerRef} style={{ height: greeksChartHeight, minHeight: 40, position: 'relative', paddingLeft: 75, boxSizing: 'border-box' }}>\
);

// 4. TimeRange syncing
const syncCodeOld = \      let isSyncingRange = false;

      for (const c of charts) {
        const onRangeChange = (range: any) => {
          if (isSyncingRange || !range) return;
          isSyncingRange = true;
          try {
            for (const target of charts) {
              if (target !== c) safeSetVisibleLogicalRange(target, range);
            }
          } catch (e) {} finally {
            isSyncingRange = false;
          }
        };
        try {
          c.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange);
          unsubs.push(() => { try { c.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange); } catch (e) {} });
        } catch (e) {}
      }\;

const syncCodeNew = \      let isSyncingRange = false;

      for (const c of charts) {
        const onRangeChange = (range: any) => {
          if (isSyncingRange || !range) return;
          isSyncingRange = true;
          try {
            for (const target of charts) {
              if (target !== c) target.timeScale().setVisibleRange(range);
            }
          } catch (e) {} finally {
            isSyncingRange = false;
          }
        };
        try {
          c.timeScale().subscribeVisibleTimeRangeChange(onRangeChange);
          unsubs.push(() => { try { c.timeScale().unsubscribeVisibleTimeRangeChange(onRangeChange); } catch (e) {} });
        } catch (e) {}
      }\;

code = code.replace(syncCodeOld, syncCodeNew);
code = code.replace(/function safeSetVisibleLogicalRange\([\\s\\S]*?\\}\\s*\\}\\s*catch[^\\n]*\\n\\s*\\}/, '');

fs.writeFileSync(file, code);
console.log('Patched final!');

