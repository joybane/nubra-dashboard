const fs = require('fs');
const p = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let txt = fs.readFileSync(p, 'utf8');

// Replace leftPriceScale
txt = txt.replace(/leftPriceScale:\s*\{\s*visible:\s*true,\s*borderColor:\s*isDark \? '#2a2d32' : '#e0e3eb'(?:,\s*minimumWidth:\s*\d+)?,\s*\}/, `leftPriceScale: {
      visible: true,
      borderColor: isDark ? '#2a2d32' : '#e0e3eb',
      minimumWidth: 110,
    }`);
txt = txt.replace(/leftPriceScale:\s*\{\s*visible:\s*false,\s*borderColor:\s*isDark \? '#2a2d32' : '#e0e3eb'(?:,\s*minimumWidth:\s*\d+)?,\s*\}/, `leftPriceScale: {
      visible: true,
      borderColor: isDark ? '#2a2d32' : '#e0e3eb',
      minimumWidth: 110,
    }`);

// Replace rightPriceScale
txt = txt.replace(/rightPriceScale:\s*\{\s*visible:\s*true,\s*borderColor:\s*isDark \? '#2a2d32' : '#e0e3eb'(?:,\s*minimumWidth:\s*\d+)?,\s*\}/, `rightPriceScale: {
      visible: true,
      borderColor: isDark ? '#2a2d32' : '#e0e3eb',
      minimumWidth: 110,
    }`);
txt = txt.replace(/rightPriceScale:\s*\{\s*visible:\s*false,\s*borderColor:\s*isDark \? '#2a2d32' : '#e0e3eb'(?:,\s*minimumWidth:\s*\d+)?,\s*\}/, `rightPriceScale: {
      visible: true,
      borderColor: isDark ? '#2a2d32' : '#e0e3eb',
      minimumWidth: 110,
    }`);

fs.writeFileSync(p, txt);
console.log("minimumWidth strictly applied to BOTH scales!");
