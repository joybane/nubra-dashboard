const fs = require('fs');
const p = 'e:/Derivativesproject/nubra-dashboard/src/components/StrategyAnalysisView.tsx';
let txt = fs.readFileSync(p, 'utf8');

const correctBlock = `
// Min-max normalization factor: maps a series' [min,max] to [-1,1]. True value = plotted × half + mid.
function minMaxFactor(values: number[]): { mid: number; half: number } {
  let min = Infinity, max = -Infinity;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
  if (min === Infinity) return { mid: 0, half: 1 };
  const mid = (max + min) / 2, half = (max - min) / 2;
  return { mid, half: half > 0 ? half : 1 };
}
import { PriceTooltip, PnlTooltip, GreeksTooltip, PriceTooltipRef, PnlTooltipRef, GreeksTooltipRef } from './ChartTooltips';

export default function StrategyAnalysisView({ basketGroupId, strategyName, theme, onBack, snapshotId }: StrategyAnalysisViewProps) {
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

  const { subscribe, subscribeChart, unsubscribeChart, subscribeOC, unsubscribeOC } = useWs();
  const isSnapshot = !!snapshotId;

  // -- Position / order state --
  const [positions, setPositions] = useState<PaperPosition[]>([]);
  const [closedPositions, setClosedPositions] = useState<PaperPosition[]>([]);
`;

// we need to find where the first minMaxFactor starts, and where `const [orders, setOrders]` starts, and replace everything in between.
const startRegex = /\/\/ Min-max normalization factor: maps a series' \[min,max\] to \[-1,1\]\. True value = plotted [^\n]+ half \+ mid\.\nfunction minMaxFactor\(values: number\[\]\): \{ mid: number; half: number \} \{/s;
const endRegex = /  const \[orders, setOrders\] = useState<PaperOrder\[\]>\(\[\]\);/s;

const matchStart = txt.match(startRegex);
const matchEnd = txt.match(endRegex);

if (matchStart && matchEnd) {
    const startIndex = matchStart.index;
    const endIndex = matchEnd.index;
    const before = txt.substring(0, startIndex);
    const after = txt.substring(endIndex);
    txt = before + correctBlock + after;
    fs.writeFileSync(p, txt);
    console.log("Successfully repaired the file!");
} else {
    console.log("Could not find boundaries.");
}
