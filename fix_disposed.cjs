const fs = require('fs');
const p = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let txt = fs.readFileSync(p, 'utf8');

txt = txt.replace(/requestAnimationFrame\(\(\) => (.*?)\.timeScale\(\)\.fitContent\(\)\);/g, 'requestAnimationFrame(() => { try { $1.timeScale().fitContent(); } catch (e) {} });');

fs.writeFileSync(p, txt);
console.log("Fixed requestAnimationFrame Object is disposed bug");
