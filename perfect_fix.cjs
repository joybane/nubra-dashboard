const fs = require('fs');
const filepath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let code = fs.readFileSync(filepath, 'utf8');

// 1. requestAnimationFrame wrapper
code = code.replace(/requestAnimationFrame\(\(\) => ([\w\.\?\(\)]+)\);/g, "requestAnimationFrame(() => { try { ; } catch {} });");

// 2. chartData effect grid and try/catch
code = code.replace(
  /\/\/ ? 3b\. Apply fetched data to existing charts ?\n\s*useEffect\(\(\) => \{\n\s*if \(\!chartData\) return;\n/,
  "// ? 3b. Apply fetched data to existing charts ?\n  useEffect(() => {\n    if (!chartData) return;\n    try {\n    const grid = chartData.underlyingBars.map(b => b.time as number);\n"
);
code = code.replace(
  /    \/\/ Shared full-session grid\n\s*const grid = chartData\.underlyingBars\.map\(b => b\.time as number\);\n/,
  ""
);
code = code.replace(
  /        } catch \(e\) \{\}\n\s*\}\n\s*\}\n\s*\}, \[chartData\]\);/g,
  "        } catch (e) {}\n      }\n    } catch (e) {}\n  }, [chartData]);"
);

// 3. greeksGrid and try/catch
code = code.replace(
  /  \/\/ -- 5\. Greeks Chart --\n\s*useEffect\(\(\) => \{\n\s*const chart = greeksChartRef\.current;\n\s*if \(\!chart\) return;/g,
  "  // -- 5. Greeks Chart --\n  useEffect(() => {\n    const chart = greeksChartRef.current;\n    if (!chart) return;\n    try {"
);
code = code.replace(
  /const greeksChart = greeksChartRef\.current;\n\s*if \(greeksChart && seriesRef\.current\.underlying\) \{/,
  "const greeksChart = greeksChartRef.current;\n    if (greeksChart && seriesRef.current.underlying) {\n      const greeksGrid = chartData.underlyingBars.map(b => b.time as number);"
);
code = code.replace(
  /    \/\/ Same full-session grid as the P&L pane so greeks time-align with the other charts \(whitespace pad\)\.\n\s*const grid = chartData\.underlyingBars\.map\(b => b\.time as number\);\n/,
  ""
);
code = code.replace(
  /      \} else \{\n\s*requestAnimationFrame\(\(\) => \{\n\s*try \{ greeksChartRef\.current\?\.timeScale\(\)\.fitContent\(\); \} catch \{\}\n\s*\}\);\n\s*\}\n\s*\}, \[chartData/g,
  "      } else {\n        requestAnimationFrame(() => {\n          try { greeksChartRef.current?.timeScale().fitContent(); } catch {}\n        });\n      }\n    } catch (e) {}\n  }, [chartData"
);

// 4. Wrap subscribeCrosshairMove properly
// Find every line with subscribeCrosshairMove((param) => { and add 	ry { after it.
// Find every priceTooltipRef, pnlTooltipRef, greeksTooltipRef setData line and add } catch (e) {} after it BEFORE });
const lines = code.split('\n');
for(let i=0; i<lines.length; i++) {
  if (lines[i].includes('chart.subscribeCrosshairMove((param) => {')) {
    lines[i] = lines[i] + '\n      try {';
  }
  if (lines[i].includes("priceTooltipRef.current?.setData(param.time ? fmtChartTime(param.time as number) : '', newOhlc, legs, underlying || '');")) {
    if (lines[i+1] && lines[i+1].includes('});')) {
      lines[i] = lines[i] + '\n      } catch (e) {}';
    }
  }
  if (lines[i].includes("pnlTooltipRef.current?.setData(param.time ? fmtChartTime(param.time as number) : '', { legs, total });")) {
    if (lines[i+1] && lines[i+1].includes('});')) {
      lines[i] = lines[i] + '\n      } catch (e) {}';
    }
  }
  if (lines[i].includes("greeksTooltipRef.current?.setData(param.time ? fmtChartTime(param.time as number) : '', hasData ? vals : null);")) {
    if (lines[i+1] && lines[i+1].includes('});')) {
      lines[i] = lines[i] + '\n      } catch (e) {}';
    }
  }
  // Sync onCrosshairMove
  if (lines[i].includes("try {") && lines[i+1] && lines[i+1].includes("if (!param.point || param.time == null) {")) {
     // it already has try
  }
  if (lines[i].includes("} finally {") && lines[i+1] && lines[i+1].includes("syncingCrosshair = false;")) {
    lines[i] = "          } catch (e) {} finally {";
  }
}

fs.writeFileSync(filepath, lines.join('\n'));
console.log('PERFECT FIX APPLIED!');
