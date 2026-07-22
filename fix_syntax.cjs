const fs = require('fs');
const filepath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let code = fs.readFileSync(filepath, 'utf8');

code = code.replace(
  /      priceTooltipRef\.current\?\.setData\(param\.time \? fmtChartTime\(param\.time as number\) : '', newOhlc, legs, underlying \|\| ''\);\n    \}\);/g,
  "      priceTooltipRef.current?.setData(param.time ? fmtChartTime(param.time as number) : '', newOhlc, legs, underlying || '');\n      } catch (e) {}\n    });"
);

code = code.replace(
  /      pnlTooltipRef\.current\?\.setData\(param\.time \? fmtChartTime\(param\.time as number\) : '', \{ legs, total \}\);\n    \}\);/g,
  "      pnlTooltipRef.current?.setData(param.time ? fmtChartTime(param.time as number) : '', { legs, total });\n      } catch (e) {}\n    });"
);

code = code.replace(
  /      greeksTooltipRef\.current\?\.setData\(param\.time \? fmtChartTime\(param\.time as number\) : '', hasData \? vals : null\);\n    \}\);/g,
  "      greeksTooltipRef.current?.setData(param.time ? fmtChartTime(param.time as number) : '', hasData ? vals : null);\n      } catch (e) {}\n    });"
);

fs.writeFileSync(filepath, code);
console.log('Fixed syntax errors!');
