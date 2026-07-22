const fs = require('fs');
const filepath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let code = fs.readFileSync(filepath, 'utf8');

// Just wrap the entire insides of the chartData and Greeks effect in try/catch to be ultra safe against 'Object is disposed'
code = code.replace(
  /\/\/ ? 3b\. Apply fetched data to existing charts ?\n\s*useEffect\(\(\) => \{\n\s*if \(\!chartData\) return;\n\s*const grid = chartData\.underlyingBars\.map\(b => b\.time as number\);\n/,
  "// ? 3b. Apply fetched data to existing charts ?\n  useEffect(() => {\n    if (!chartData) return;\n    try {\n    const grid = chartData.underlyingBars.map(b => b.time as number);\n"
);

// Close the try-catch before the end of the effect
code = code.replace(
  /        } catch \(e\) \{\}\n\s*\}\n\s*\}\n\s*\}, \[chartData\]\);/g,
  "        } catch (e) {}\n      }\n    } catch (e) { console.warn('Caught Error in chartData effect:', e); }\n  }, [chartData]);"
);

// Also wrap the greeks effect
code = code.replace(
  /  \/\/ -- 5\. Greeks Chart --\n\s*useEffect\(\(\) => \{\n\s*const chart = greeksChartRef\.current;\n\s*if \(\!chart\) return;/g,
  "  // -- 5. Greeks Chart --\n  useEffect(() => {\n    const chart = greeksChartRef.current;\n    if (!chart) return;\n    try {"
);

code = code.replace(
  /      \} else \{\n\s*requestAnimationFrame\(\(\) => \{\n\s*try \{ greeksChartRef\.current\?\.timeScale\(\)\.fitContent\(\); \} catch \{\}\n\s*\}\);\n\s*\}\n\s*\}, \[chartData/g,
  "      } else {\n        requestAnimationFrame(() => {\n          try { greeksChartRef.current?.timeScale().fitContent(); } catch {}\n        });\n      }\n    } catch (e) { console.warn('Caught Error in greeks effect:', e); }\n  }, [chartData"
);

fs.writeFileSync(filepath, code);
console.log('Wrapped effects in try/catch!');
