const fs = require('fs');
const p = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let txt = fs.readFileSync(p, 'utf8');

const target = /    useEffect\(\(\) => \{\s+const syncAll = \(\) => \{/;

const replacement = `    useEffect(() => {
      let widthSyncInterval;
      if (typeof window !== 'undefined') {
        widthSyncInterval = setInterval(() => {
          try {
            const charts = [priceChartRef.current, pnlChartRef.current, greeksChartRef.current].filter(Boolean);
            if (charts.length < 2) return;
            let maxRight = 0;
            let maxLeft = 0;
            for (const c of charts) {
              maxRight = Math.max(maxRight, c.priceScale('right').width());
              maxLeft = Math.max(maxLeft, c.priceScale('left').width());
            }
            if (maxRight > 0) {
              for (const c of charts) {
                if (c.priceScale('right').width() !== maxRight) {
                  c.priceScale('right').applyOptions({ minimumWidth: maxRight });
                }
              }
            }
            if (maxLeft > 0) {
              for (const c of charts) {
                if (c.priceScale('left').width() !== maxLeft) {
                  c.priceScale('left').applyOptions({ minimumWidth: maxLeft });
                }
              }
            }
          } catch (e) {}
        }, 50);
      }

      const syncAll = () => {`;

txt = txt.replace(target, replacement);

const returnTarget = /      return \(\) => \{\s+ro\.disconnect\(\);\s+\};\s+\}, \[priceVisible, pnlVisible, greeksVisible, chartEpoch\]\);/;

const returnReplacement = `      return () => {
        ro.disconnect();
        if (widthSyncInterval) clearInterval(widthSyncInterval);
      };
    }, [priceVisible, pnlVisible, greeksVisible, chartEpoch]);`;

txt = txt.replace(returnTarget, returnReplacement);

fs.writeFileSync(p, txt);
console.log("Dynamically synced widths!");
