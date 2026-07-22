const fs = require('fs');
const filepath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let code = fs.readFileSync(filepath, 'utf8');

code = code.replace(
  "      leftPriceScale: {\n        visible: false,\n        borderColor: isDark ? '#2a2d32' : '#e0e3eb',\n      },",
  "      leftPriceScale: {\n        visible: showLeftScale,\n        borderColor: isDark ? '#2a2d32' : '#e0e3eb',\n      },"
);

fs.writeFileSync(filepath, code);
console.log('Fixed left scale visibility again!');
