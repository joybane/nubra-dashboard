const fs = require('fs');
const filepath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let code = fs.readFileSync(filepath, 'utf8');

code = code.replace(/requestAnimationFrame\(\(\) => chart\.timeScale\(\)\.fitContent\(\)\);/g, "requestAnimationFrame(() => { try { chart.timeScale().fitContent(); } catch {} });");
code = code.replace(/requestAnimationFrame\(\(\) => greeksChartRef\.current\?\.timeScale\(\)\.fitContent\(\)\);/g, "requestAnimationFrame(() => { try { greeksChartRef.current?.timeScale().fitContent(); } catch {} });");

fs.writeFileSync(filepath, code);
console.log('Fixed RAF perfectly!');
