const fs = require('fs');
const p = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let lines = fs.readFileSync(p, 'utf8').split('\n');
for (let i = 0; i < lines.length; i++) {
  if (lines[i].endsWith('\r')) lines[i] = lines[i].slice(0, -1);
}

// 1. Fix chartOpts
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('leftPriceScale: {')) {
    if (lines[i+1].includes('visible: false,')) {
      lines[i+1] = "      visible: showLeftScale,";
      lines[i+2] += "\n      minimumWidth: 110,";
    }
  }
  if (lines[i].includes('rightPriceScale: {') && lines[i+1].includes('visible: true,')) {
    if (!lines[i+2].includes('minimumWidth')) {
      lines[i+2] += "\n      minimumWidth: 110,";
    }
  }
}

// 2. Fix greeksConfigRef
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('const [lotSizeOverride, setLotSizeOverride]')) {
    if (!lines[i+3] || !lines[i+3].includes('greeksConfigRef')) {
      lines[i+1] += "\n\n  const greeksConfigRef = useRef({ mode: greeksMode, lotSize: lotSizeOverride, underlying, filter: greeksLegFilter });\n  useEffect(() => { greeksConfigRef.current = { mode: greeksMode, lotSize: lotSizeOverride, underlying, filter: greeksLegFilter }; }, [greeksMode, lotSizeOverride, underlying, greeksLegFilter]);";
    }
    break;
  }
}

// 3. Fix live update
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('setChartData({ ...cached, legGreeksHist: new Map(cached.legGreeksHist) });')) {
    // Comment it out
    lines[i] = '          // ' + lines[i].trim();
    // Inject the live update right after the closing brace of `if (cached && t >= ...)`
    const injectStr = `
        // ---- LIVE UPDATE GREEKS CHART ENGINE DIRECTLY ----
        try {
          const cfg = greeksConfigRef.current;
          const activeLotSize = cfg.lotSize ?? (cfg.underlying ? DEFAULT_LOT_SIZES[cfg.underlying] ?? 65 : 65);
          const multiplier = cfg.mode === 'lot' ? activeLotSize : 1;
          
          const liveVals = {
            net: { delta: 0, gamma: 0, theta: 0, vega: 0 },
            CE: { delta: 0, gamma: 0, theta: 0, vega: 0 },
            PE: { delta: 0, gamma: 0, theta: 0, vega: 0 },
          };

          for (const pos of allPositionsRef.current) {
            let g = updates.get(pos.ref_id);
            if (!g) {
               const hist = chartDataRef.current?.legGreeksHist.get(pos.ref_id);
               if (hist && hist.length > 0) g = hist[hist.length - 1];
            }
            if (!g) continue;

            const sign = (pos.order_side || '').includes('BUY') ? 1 : -1;
            const src = positionGreekSource(pos);
            
            for (const k of ['delta', 'gamma', 'theta', 'vega']) {
              const val = g[k] * sign * multiplier;
              liveVals.net[k] += val;
              if (src === 'CE' || src === 'PE') liveVals[src][k] += val;
            }
          }

          for (const src of ['net', 'CE', 'PE']) {
            if (!cfg.filter.has(src)) continue;
            for (const k of ['delta', 'gamma', 'theta', 'vega']) {
              const s = greeksSeriesRef.current[\`\${src}_\${k}\`];
              if (!s) continue;
              const f = greekFactorsRef.current[k] || { mid: 0, half: 1 };
              const nv = (liveVals[src][k] - f.mid) / f.half;
              s.update({ time: t, value: nv });
            }
          }
        } catch (e) { console.error('[Greeks Live Update]', e); }
        // --------------------------------------------------`;
    lines[i+1] += "\n" + injectStr;
    break; // Only the first occurrence inside the option_chain listener!
  }
}

fs.writeFileSync(p, lines.join('\n'));
console.log("All fixes applied successfully by array modification!");
