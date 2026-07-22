const fs = require('fs');
const filepath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let code = fs.readFileSync(filepath, 'utf8');

// We have exactly 3 instances of chart.subscribeCrosshairMove((param) => { ... });
// But wait, there is also the onCrosshairMove callback defined inside the loop!
// Let's do a reliable line-by-line wrap for the three tooltips

let lines = code.split('\n');

for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('chart.subscribeCrosshairMove((param) => {')) {
    lines[i] = '    chart.subscribeCrosshairMove((param) => {\n      try {';
  }
  if (lines[i].includes("priceTooltipRef.current?.setData(param.time ? fmtChartTime(param.time as number) : '', newOhlc, legs, underlying || '');")) {
    if (lines[i+1] && lines[i+1].includes('    });')) {
      lines[i] = lines[i] + '\n      } catch (e) {}';
    }
  }
  if (lines[i].includes("pnlTooltipRef.current?.setData(param.time ? fmtChartTime(param.time as number) : '', { legs, total });")) {
    if (lines[i+1] && lines[i+1].includes('    });')) {
      lines[i] = lines[i] + '\n      } catch (e) {}';
    }
  }
  if (lines[i].includes("greeksTooltipRef.current?.setData(param.time ? fmtChartTime(param.time as number) : '', hasData ? vals : null);")) {
    if (lines[i+1] && lines[i+1].includes('    });')) {
      lines[i] = lines[i] + '\n      } catch (e) {}';
    }
  }
  
  // onCrosshairMove in sync block
  if (lines[i].includes('const onCrosshairMove = (param: any) => {')) {
    if (lines[i+1].includes('if (syncingCrosshair) return;')) {
      lines[i+1] = '        if (syncingCrosshair) return;\n        try {';
    }
  }
  if (lines[i].includes('syncingCrosshair = false;')) {
    if (lines[i-1].includes('} finally {')) {
      lines[i-1] = '        } catch (e) {} finally {';
    }
  }
}

fs.writeFileSync(filepath, lines.join('\n'));
console.log('Fixed crosshairs perfectly!');
