const fs = require('fs');
const filepath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
// Restore from .bak
let code = fs.readFileSync(filepath + '.bak', 'utf8');

const padFn = '\n' +
'function padData<T extends { time: any }>(data: T[], underlyingBars: any[]): (T | { time: any })[] {\n' +
'  if (!underlyingBars || underlyingBars.length === 0) return data;\n' +
'  const out = [];\n' +
'  const tFirst = underlyingBars[0].time;\n' +
'  const tLast = underlyingBars[underlyingBars.length - 1].time;\n' +
'  if (!data.length || data[0].time > tFirst) out.push({ time: tFirst });\n' +
'  out.push(...data);\n' +
'  if (!data.length || data[data.length - 1].time < tLast) out.push({ time: tLast });\n' +
'  return out;\n' +
'}\n';

code = code.replace(/function chartOpts/, padFn + '\nfunction chartOpts');

code = code.replace(/priceScaleId:\s*'right'/g, "priceScaleId: 'left'");

code = code.replace(/seriesRef\.current\.legPrice\.get\(leg\.refId\)\?\.setData\(data\);/g, 'seriesRef.current.legPrice.get(leg.refId)?.setData(padData(data, cached.underlyingBars) as any);');
code = code.replace(/seriesRef\.current\.legPrice\.get\(leg\.refId\)\?\.setData\(data\);/g, 'seriesRef.current.legPrice.get(leg.refId)?.setData(padData(data, chartData.underlyingBars) as any);');

code = code.replace(/seriesRef\.current\.legPnl\.get\(leg\.refId\)\?\.setData\(fillPnlToGrid\(grid, data\) as any\);/g, 'seriesRef.current.legPnl.get(leg.refId)?.setData(padData(data, cached.underlyingBars) as any);');
code = code.replace(/seriesRef\.current\.legPnl\.get\(leg\.refId\)\?\.setData\(fillPnlToGrid\(grid, data\) as any\);/g, 'seriesRef.current.legPnl.get(leg.refId)?.setData(padData(data, chartData.underlyingBars) as any);');

code = code.replace(/basketSeries\.setData\(fillPnlToGrid\(grid, cached\.basketPnlData\) as any\);/g, 'basketSeries.setData(padData(cached.basketPnlData, cached.underlyingBars) as any);');
code = code.replace(/seriesRef\.current\.basketPnl\?\.setData\(fillPnlToGrid\(grid, chartData\.basketPnlData\) as any\);/g, 'seriesRef.current.basketPnl?.setData(padData(chartData.basketPnlData, chartData.underlyingBars) as any);');

code = code.replace(/setChartData\(\{ \.\.\.cached, legGreeksHist: new Map\(cached\.legGreeksHist\) \}\);/, '// setChartData({ ...cached, legGreeksHist: new Map(cached.legGreeksHist) });');

fs.writeFileSync(filepath, code);
console.log('Restored perfectly!');
