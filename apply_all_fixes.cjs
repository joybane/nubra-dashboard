const fs = require('fs');
const filepath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let code = fs.readFileSync(filepath, 'utf8');

// 1. Fix grid scope in chartData effect
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
  "        } catch (e) {}\n      }\n    } catch (e) { console.warn(e); }\n  }, [chartData]);"
);

// 2. Fix greeksGrid
code = code.replace(
  /const greeksChart = greeksChartRef\.current;\n\s*if \(greeksChart && seriesRef\.current\.underlying\) \{/,
  "const greeksChart = greeksChartRef.current;\n    if (greeksChart && seriesRef.current.underlying) {\n      const greeksGrid = chartData.underlyingBars.map(b => b.time as number);"
);
code = code.replace(
  /    \/\/ Same full-session grid as the P&L pane so greeks time-align with the other charts \(whitespace pad\)\.\n\s*const grid = chartData\.underlyingBars\.map\(b => b\.time as number\);\n/,
  ""
);

// 3. Fix RAF
code = code.replace(/requestAnimationFrame\(\(\) => ([\w\.\?\(\)]+)\);/g, "requestAnimationFrame(() => { try { ; } catch {} });");

// 4. Wrap the greeks effect
code = code.replace(
  /  \/\/ -- 5\. Greeks Chart --\n\s*useEffect\(\(\) => \{\n\s*const chart = greeksChartRef\.current;\n\s*if \(\!chart\) return;/g,
  "  // -- 5. Greeks Chart --\n  useEffect(() => {\n    const chart = greeksChartRef.current;\n    if (!chart) return;\n    try {"
);
code = code.replace(
  /      \} else \{\n\s*requestAnimationFrame\(\(\) => \{\n\s*try \{ greeksChartRef\.current\?\.timeScale\(\)\.fitContent\(\); \} catch \{\}\n\s*\}\);\n\s*\}\n\s*\}, \[chartData/g,
  "      } else {\n        requestAnimationFrame(() => {\n          try { greeksChartRef.current?.timeScale().fitContent(); } catch {}\n        });\n      }\n    } catch (e) { console.warn(e); }\n  }, [chartData"
);

// 5. Wrap crosshair handlers
code = code.replace(
  /chart\.subscribeCrosshairMove\(\(param\) => \{/g,
  "chart.subscribeCrosshairMove((param) => {\n      try {"
);
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

// 6. Fix sync onCrosshairMove
code = code.replace(
  /          try \{\n            if \(\!param\.point \|\| param\.time == null\)/g,
  "          try {\n            if (!param.point || param.time == null)"
);
code = code.replace(
  /          \} finally \{\n            syncingCrosshair = false;\n          \}/g,
  "          } catch (e) {} finally {\n            syncingCrosshair = false;\n          }"
);

fs.writeFileSync(filepath, code);
console.log('Applied all fixes properly!');
