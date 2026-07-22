const fs = require('fs');
const p = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let txt = fs.readFileSync(p, 'utf8');

txt = txt.replace(/const s = priceChart\.addSeries\(LineSeries, \{\s*color: leg\.color, lineWidth: 2, priceScaleId: 'right',/g, `const s = priceChart.addSeries(LineSeries, {\n              color: leg.color, lineWidth: 2, priceScaleId: 'left',`);

// Also fix leftPriceScale: { visible: true } back to visible: showLeftScale
txt = txt.replace(/leftPriceScale: \{\s*visible: true,\s*borderColor:/g, `leftPriceScale: {\n        visible: showLeftScale,\n        borderColor:`);

fs.writeFileSync(p, txt);
console.log("Fixed priceScaleId and leftPriceScale visibility");
