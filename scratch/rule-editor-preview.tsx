// Renders PositionRuleEditor on its own so the dialog can be reviewed without an open
// paper position. Dev-only scratch harness — not part of the app build (tsconfig.app.json
// includes "src" only) and never imported by it.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import PositionRuleEditor from '../src/components/PositionRuleEditor';

function Preview() {
  // Mode comes from the URL: the dialog's own backdrop is fixed inset-0, so any control
  // outside it is unclickable and a toggle button would be unreachable to a driver.
  const [mode] = useState<'LEG' | 'GROUP'>(
    new URLSearchParams(location.search).get('mode') === 'LEG' ? 'LEG' : 'GROUP',
  );
  const noop = () => {};
  return (
    <div style={{ padding: 12 }}>
      {mode === 'GROUP' ? (
        <PositionRuleEditor
          mode="GROUP"
          basketGroupId="bg_preview"
          strategyName="OTM 2 Crude"
          initial={null}
          onClose={noop}
          onSaved={noop}
        />
      ) : (
        <PositionRuleEditor
          mode="LEG"
          refId={101}
          basketGroupId="bg_preview"
          displayName="NIFTY 24000 CE"
          entryPriceRs={82.7}
          side="SELL"
          ltpRs={84.75}
          initial={null}
          onClose={noop}
          onSaved={noop}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Preview />);
