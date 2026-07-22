const fs = require('fs');
const filepath = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let code = fs.readFileSync(filepath, 'utf8');
let lines = code.split('\n');

for (let i = 0; i < lines.length; i++) {
  // 1. legPrice fillPnlToGrid
  if (lines[i].includes('if (data) seriesRef.current.legPrice.get(leg.refId)?.setData(data.map(d => ({ time: d.time, value: d.value })));')) {
    lines[i] = '        if (data) seriesRef.current.legPrice.get(leg.refId)?.setData(fillPnlToGrid(grid, data.map(d => ({ time: d.time, value: d.value }))) as any);';
  }
  
  // 2. legPrice left scale
  if (lines[i].includes("priceScaleId: 'right'")) {
    lines[i] = lines[i].replace("priceScaleId: 'right'", "priceScaleId: 'left'");
  }

  // 3. chartOpts hideTimeScale = false
  if (lines[i].includes('chartOpts(isDark, true, true)')) {
    lines[i] = lines[i].replace('chartOpts(isDark, true, true)', 'chartOpts(isDark, false, true)');
  }
  if (lines[i].includes('chartOpts(isDark, true)')) {
    lines[i] = lines[i].replace('chartOpts(isDark, true)', 'chartOpts(isDark, false)');
  }

  // 4. WebSocket option_chain listener setChartData loop issue
  if (lines[i].includes('setChartData({ ...cached, legGreeksHist: new Map(cached.legGreeksHist) });')) {
    lines[i] = '          // setChartData({ ...cached, legGreeksHist: new Map(cached.legGreeksHist) });';
  }

  // 5. Grid stuff
  if (lines[i].includes('// ? 3b. Apply fetched data to existing charts ?')) {
    for (let j = i; j < i + 10; j++) {
      if (lines[j].includes('if (!chartData) return;')) {
        lines.splice(j + 1, 0, '    const grid = chartData.underlyingBars.map(b => b.time as number);');
        break;
      }
    }
  }
  if (lines[i].includes('// Shared full-session grid')) {
    lines[i] = '';
    lines[i+1] = '';
  }
  if (lines[i].includes('// Same full-session grid as the P&L pane so greeks time-align with the other charts (whitespace pad).')) {
    lines[i+1] = '    const greeksGrid = chartData.underlyingBars.map(b => b.time as number);';
  }
  if (lines[i].includes('fillGreeksToGrid(grid,')) {
    lines[i] = lines[i].replace('fillGreeksToGrid(grid,', 'fillGreeksToGrid(greeksGrid,');
  }

  // 6. Fix RAF calls unprotected
  if (lines[i].includes('requestAnimationFrame(() => chart.timeScale().fitContent());')) {
    lines[i] = lines[i].replace('requestAnimationFrame(() => chart.timeScale().fitContent());', 'requestAnimationFrame(() => { try { chart.timeScale().fitContent(); } catch {} });');
  }
  if (lines[i].includes('requestAnimationFrame(() => priceChart.timeScale().fitContent());')) {
    lines[i] = lines[i].replace('requestAnimationFrame(() => priceChart.timeScale().fitContent());', 'requestAnimationFrame(() => { try { priceChart.timeScale().fitContent(); } catch {} });');
  }
  if (lines[i].includes('requestAnimationFrame(() => greeksChartRef.current?.timeScale().fitContent());')) {
    lines[i] = lines[i].replace('requestAnimationFrame(() => greeksChartRef.current?.timeScale().fitContent());', 'requestAnimationFrame(() => { try { greeksChartRef.current?.timeScale().fitContent(); } catch {} });');
  }

  // 7. Wrapping tooltip/crosshair move callbacks with try/catch
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

  // 8. The onCrosshairMove inside the sync block ONLY NEEDS TO CATCH
  if (lines[i].includes('syncingCrosshair = false;')) {
    if (lines[i-1] && lines[i-1].includes('} finally {')) {
      lines[i-1] = '        } catch (e) {} finally {';
    }
  }
}

fs.writeFileSync(filepath, lines.join('\n'));
console.log('ULTIMATE SCRIPT FINISHED');
