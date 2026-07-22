const fs = require('fs');

function patchFile(filepath) {
  let code = fs.readFileSync(filepath, 'utf8');

  // StrategyAnalysisView.tsx Top Chart
  if (filepath.includes('StrategyAnalysisView')) {
    // Add dummy series to Top Chart to force left scale rendering
    const dummyTop = `
      chart.addSeries(LineSeries, { priceScaleId: 'left', color: 'transparent', crosshairMarkerVisible: false, lastValueVisible: false, priceLineVisible: false });
    `;
    code = code.replace(/seriesRef\.current\.underlying = chart\.addSeries\(CandlestickSeries/g, match => dummyTop + match);
  }

  fs.writeFileSync(filepath, code);
  console.log('Fixed ' + filepath);
}

patchFile('e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx');
