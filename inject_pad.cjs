const fs = require('fs');
const filepath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let code = fs.readFileSync(filepath, 'utf8');

const padFn = `
function padData<T extends { time: any }>(data: T[], underlyingBars: HistBar[]): (T | { time: any })[] {
  if (!underlyingBars || underlyingBars.length === 0) return data;
  const out: (T | { time: any })[] = [];
  const tFirst = underlyingBars[0].time as number;
  const tLast = underlyingBars[underlyingBars.length - 1].time as number;
  if (!data.length || (data[0].time as number) > tFirst) out.push({ time: tFirst });
  out.push(...data);
  if (!data.length || (data[data.length - 1].time as number) < tLast) out.push({ time: tLast });
  return out;
}
`;

// Insert padData function right before chartOpts
code = code.replace(/function chartOpts/, padFn + '\nfunction chartOpts');

// 1. Replace usages in the "cached" restoration block
code = code.replace(/if \(data\) seriesRef\.current\.legPnl\.get\(leg\.refId\)\?\.setData\(data\);/g, 'if (data) seriesRef.current.legPnl.get(leg.refId)?.setData(padData(data, cached.underlyingBars) as any);');
code = code.replace(/if \(cached\.basketPnlData\.length > 0\) basketSeries\.setData\(cached\.basketPnlData\);/g, 'if (cached.basketPnlData.length > 0) basketSeries.setData(padData(cached.basketPnlData, cached.underlyingBars) as any);');

// 2. Replace usages in the "chartData" effect block
code = code.replace(/if \(data\) seriesRef\.current\.legPnl\.get\(leg\.refId\)\?\.setData\(data\);/g, 'if (data) seriesRef.current.legPnl.get(leg.refId)?.setData(padData(data, chartData.underlyingBars) as any);');
code = code.replace(/seriesRef\.current\.basketPnl\?\.setData\(chartData\.basketPnlData\);/g, 'seriesRef.current.basketPnl?.setData(padData(chartData.basketPnlData, chartData.underlyingBars) as any);');
code = code.replace(/if \(chartData\.basketPnlData\.length > 0\) \{[\s\S]*?seriesRef\.current\.basketPnl\?\.setData\(chartData\.basketPnlData\);[\s\S]*?\}/g, match => {
  return match.replace(/setData\(chartData\.basketPnlData\)/, 'setData(padData(chartData.basketPnlData, chartData.underlyingBars) as any)');
});

// 3. Replace usages for Greeks
code = code.replace(/seriesRef\.current\.greeks\.get\(key\)\?\.setData\(points\.map\(p => \(\{\n\s*time: p\.time as any,\n\s*value: p\[k\]\n\s*\}\)\)\);/g, 'seriesRef.current.greeks.get(key)?.setData(padData(points.map(p => ({ time: p.time as any, value: p[k] })), chartData.underlyingBars) as any);');

// Ensure Greeks are also correctly padded in the backup section if it exists, but the regex above should cover it.
// Wait, the Greeks are set in a block that looks like:
// seriesRef.current.greeks.get(key)?.setData(points.map(p => ({ time: p.time as any, value: p[k] })));
// Let's use a simpler regex for Greeks:
code = code.replace(/seriesRef\.current\.greeks\.get\(key\)\?\.setData\((points\.map\([\s\S]*?\}\)\))\);/g, 'seriesRef.current.greeks.get(key)?.setData(padData($1, chartData.underlyingBars) as any);');

fs.writeFileSync(filepath, code);
console.log("Injected padData and applied to all P&L/Greeks setData calls!");
