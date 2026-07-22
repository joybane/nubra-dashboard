const fs = require('fs');
const p = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let txt = fs.readFileSync(p, 'utf8');

const injection = `
  // Suppress lightweight-charts "Object is disposed" rogue animation frame errors
  useEffect(() => {
    const handler = (e: ErrorEvent) => {
      if (e.message && e.message.includes('Object is disposed')) {
        e.preventDefault(); // Stop the error from crashing the UI / showing overlay
        e.stopPropagation();
      }
    };
    const unhandledHandler = (e: PromiseRejectionEvent) => {
      if (e.reason && e.reason.message && e.reason.message.includes('Object is disposed')) {
        e.preventDefault();
      }
    };
    window.addEventListener('error', handler, true);
    window.addEventListener('unhandledrejection', unhandledHandler, true);
    return () => {
      window.removeEventListener('error', handler, true);
      window.removeEventListener('unhandledrejection', unhandledHandler, true);
    };
  }, []);
`;

txt = txt.replace(/const \{ subscribe, subscribeChart, unsubscribeChart, subscribeOC, unsubscribeOC \} = useWs\(\);/, '$&\n' + injection);

fs.writeFileSync(p, txt);
console.log("Injected error suppression safely");
