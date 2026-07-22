const fs = require('fs');
const filepath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let code = fs.readFileSync(filepath, 'utf8');

// 1. Remove fillPnlToGrid function entirely
code = code.replace(/function fillPnlToGrid\([\s\S]*?return result;\s*\}/, '');

// 2. Remove usages of fillPnlToGrid
code = code.replace(/setData\(fillPnlToGrid\(grid, data\) as any\);/g, 'setData(data);');
code = code.replace(/setData\(fillPnlToGrid\(grid, chartData\.basketPnlData\) as any\);/g, 'setData(chartData.basketPnlData);');

// 3. Remove safeSetVisibleLogicalRange
code = code.replace(/function safeSetVisibleLogicalRange\([\s\S]*?\}\s*\}\s*catch[^\n]*\n\s*\}/, '');

// 4. Replace LogicalRange syncing with TimeRange syncing
const syncCodeOld = `      let isSyncingRange = false;

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
      }`;

const syncCodeNew = `      let isSyncingRange = false;

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
      }`;

code = code.replace(syncCodeOld, syncCodeNew);

// 5. In case the regex didn't match perfectly, let's just use generic replace for LogicalRange to TimeRange
code = code.replace(/subscribeVisibleLogicalRangeChange/g, 'subscribeVisibleTimeRangeChange');
code = code.replace(/unsubscribeVisibleLogicalRangeChange/g, 'unsubscribeVisibleTimeRangeChange');
code = code.replace(/safeSetVisibleLogicalRange\(target, range\)/g, 'target.timeScale().setVisibleRange(range)');

fs.writeFileSync(filepath, code);
console.log("Fixed syncing in StrategyAnalysisView!");
