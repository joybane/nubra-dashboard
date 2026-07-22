const fs = require('fs');
const p = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let txt = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const oldChartOpts = `    leftPriceScale: {
      visible: false,
      borderColor: isDark ? '#2a2d32' : '#e0e3eb',
    },
    rightPriceScale: {
      visible: true,
      borderColor: isDark ? '#2a2d32' : '#e0e3eb',
    },`;

const newChartOpts = `    leftPriceScale: {
      visible: true,
      borderColor: isDark ? '#2a2d32' : '#e0e3eb',
      minimumWidth: 110,
    },
    rightPriceScale: {
      visible: true,
      borderColor: isDark ? '#2a2d32' : '#e0e3eb',
      minimumWidth: 110,
    },`;

if (txt.includes(oldChartOpts)) {
  txt = txt.replace(oldChartOpts, newChartOpts);
  fs.writeFileSync(p, txt);
  console.log("minimumWidth fix applied!");
} else {
  console.log("Could not find target!");
}
