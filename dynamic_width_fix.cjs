const fs = require('fs');
const filepath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let code = fs.readFileSync(filepath, 'utf8');

// 1. Remove minimumWidth from leftPriceScale
code = code.replace(
  "    leftPriceScale: {\n      visible: showLeftScale,\n      borderColor: isDark ? '#2a2d32' : '#e0e3eb',\n      minimumWidth: 80,\n    },",
  "    leftPriceScale: {\n      visible: showLeftScale,\n      borderColor: isDark ? '#2a2d32' : '#e0e3eb',\n    },"
);

// 2. Add dynamic width sync
const injection = \    const unsubs: (() => void)[] = [];

    let isSyncingWidth = true;
    let lastW = -1;
    const syncLoop = () => {
      if (!isSyncingWidth) return;
      try {
        const w = master.priceScale('left').width();
        if (w > 0 && w !== lastW) {
          lastW = w;
          for (const c of charts) {
            if (c !== master) c.applyOptions({ leftPriceScale: { minimumWidth: w } });
          }
        }
      } catch {}
      requestAnimationFrame(syncLoop);
    };
    requestAnimationFrame(syncLoop);
    unsubs.push(() => { isSyncingWidth = false; });\;

code = code.replace(
  "    const unsubs: (() => void)[] = [];",
  injection
);

fs.writeFileSync(filepath, code);
console.log('Dynamic width fix applied!');
