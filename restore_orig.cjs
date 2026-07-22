const fs = require('fs');

const targetPath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let code = fs.readFileSync(targetPath, 'utf8');

// Fix 1: Left scale taking up black space when hidden
code = code.replace(
  /leftPriceScale:\s*\{\s*visible:\s*showLeftScale,\s*borderColor:[^,]+,\s*minimumWidth:\s*60,\s*\}/g,
  `leftPriceScale: {
      visible: showLeftScale,
      borderColor: isDark ? '#2a2d32' : '#e0e3eb',
    }`
);
code = code.replace(
  /rightPriceScale:\s*\{\s*visible:\s*true,\s*borderColor:[^\}]+\}/g,
  `rightPriceScale: {
      visible: true,
      borderColor: isDark ? '#2a2d32' : '#e0e3eb',
      minimumWidth: 75,
    }`
);

// Fix 2: Add grid to cache restore
code = code.replace(
  /const cached = chartDataRef\.current;\s*if \(cached\) \{\s*for \(const leg of legMetasRef\.current\) \{/g,
  `const cached = chartDataRef.current;
    if (cached) {
      const grid = cached.underlyingBars.map(b => b.time as number);
      for (const leg of legMetasRef.current) {`
);

// Fix 3: Fix legPnlData cache restore
code = code.replace(
  /const data = cached\.legPnlData\.get\(leg\.refId\);\s*if \(data\) seriesRef\.current\.legPnl\.get\(leg\.refId\)\?\.setData\(data\);/g,
  `const data = cached.legPnlData.get(leg.refId);
        if (data) seriesRef.current.legPnl.get(leg.refId)?.setData(fillPnlToGrid(grid, data) as any);`
);

// Fix 4: Fix basketPnlData cache restore
code = code.replace(
  /if \(cached\.basketPnlData\.length > 0\) basketSeries\.setData\(cached\.basketPnlData\);/g,
  `if (cached.basketPnlData.length > 0) basketSeries.setData(fillPnlToGrid(grid, cached.basketPnlData) as any);`
);

fs.writeFileSync(targetPath, code);
console.log('Restored original backup with minor fixes applied! (Round 2)');
