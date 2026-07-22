const fs = require('fs');
const filepath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let code = fs.readFileSync(filepath, 'utf8');

code = code.replace(/requestAnimationFrame\(\(\) => ([\w\.\?\(\)]+)\);/g, "requestAnimationFrame(() => { try { ; } catch {} });");

fs.writeFileSync(filepath, code);
console.log('Fixed RAF!');
