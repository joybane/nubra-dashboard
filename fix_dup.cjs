const fs = require('fs');
const p = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let txt = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const dupMinW = `    rightPriceScale: {
      visible: true,
      borderColor: isDark ? '#2a2d32' : '#e0e3eb',
      minimumWidth: 75,
      minimumWidth: 110,
    },`;

if (txt.includes(dupMinW)) {
  txt = txt.replace(dupMinW, `    rightPriceScale: {
      visible: true,
      borderColor: isDark ? '#2a2d32' : '#e0e3eb',
      minimumWidth: 110,
    },`);
}

fs.writeFileSync(p, txt);
console.log("Duplicate fixed!");
