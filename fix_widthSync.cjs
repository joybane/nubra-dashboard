const fs = require('fs');
const p = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let txt = fs.readFileSync(p, 'utf8');

txt = txt.replace(/if \(widthSyncInterval\) clearInterval\(widthSyncInterval\);/g, '');

const target = /      return \(\) => \{\s+ro\.disconnect\(\);\s+\};\s+\}, \[\]\);/;
const replacement = `      return () => {
        ro.disconnect();
        if (widthSyncInterval) clearInterval(widthSyncInterval);
      };
    }, []);`;

txt = txt.replace(target, replacement);

fs.writeFileSync(p, txt);
console.log("Fixed scope for widthSyncInterval");
