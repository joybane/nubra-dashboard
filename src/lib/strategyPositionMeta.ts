import type { Instrument, PaperPosition } from '../types';
import { exchangeFromName } from '../types';
import { mcxFutureSymbol, mcxUnderlyingFutureExpiry } from './GexService';

const MONTH_CODES: Record<string, string> = {
  '1': '01',
  '2': '02',
  '3': '03',
  '4': '04',
  '5': '05',
  '6': '06',
  '7': '07',
  '8': '08',
  '9': '09',
  O: '10',
  N: '11',
  D: '12',
};

export function strategyPositionExchange(positions: PaperPosition[]): string {
  for (const position of positions) {
    // The readable display name intentionally hides the MCX zanskar shape, so the
    // trading name must win when both are present.
    const exchange = exchangeFromName(position.zanskar_name || position.display_name);
    if (exchange !== 'NSE') return exchange;
  }
  return 'NSE';
}

export function strategyPositionAsset(positions: PaperPosition[]): string | null {
  for (const position of positions) {
    // Try the trading name first. Human-facing labels such as "CRUDEOIL 7550 PE"
    // deliberately no longer contain the structural OPT_/FUT_ prefix.
    for (const value of [position.zanskar_name, position.display_name]) {
      const name = String(value || '').toUpperCase();
      const mcx = /^(?:OPT|FUT)_([A-Z][A-Z0-9]*)_\d{8}/.exec(name);
      if (mcx) return mcx[1];
      const index = /^(NIFTY|BANKNIFTY|FINNIFTY|SENSEX|MIDCPNIFTY)/.exec(name);
      if (index) return index[1];
    }
  }
  return null;
}

export function strategyPositionExpiry(position: PaperPosition): string | null {
  const explicit = String(position.expiry ?? '');
  if (/^\d{8}$/.test(explicit)) return explicit;

  const name = String(position.zanskar_name || position.display_name || '').toUpperCase();
  const mcx = /^(?:OPT|FUT)_[A-Z][A-Z0-9]*_(\d{8})(?:_|$)/.exec(name);
  if (mcx) return mcx[1];

  const nse = /^[A-Z]+(\d{2})([0-9OND])(\d{2})\d+(?:CE|PE)$/.exec(name);
  if (!nse) return null;
  return `20${nse[1]}${MONTH_CODES[nse[2]] || '01'}${nse[3]}`;
}

export function resolveMcxStrategyFuture(
  asset: string,
  positions: PaperPosition[],
  futures: Instrument[],
): string | null {
  const expiries = futures
    .map((future) => {
      const symbol = String(
        future.zanskar_name || future.nubra_name || future.symbol || future.stock_name || '',
      );
      const expiry = String(future.expiry ?? /(?:^|_)(\d{8})(?:_|$)/.exec(symbol)?.[1] ?? '');
      return { expiry, symbol };
    })
    .filter((future) => /^\d{8}$/.test(future.expiry));
  if (!expiries.length) return null;

  const optionExpiries = positions
    .map(strategyPositionExpiry)
    .filter((expiry): expiry is string => !!expiry)
    .sort();
  const targetExpiry = optionExpiries[0];
  const futureExpiry = targetExpiry
    ? mcxUnderlyingFutureExpiry(
        targetExpiry,
        expiries.map((future) => future.expiry),
      )
    : expiries.map((future) => future.expiry).sort()[0];
  if (!futureExpiry) return null;

  return (
    expiries.find((future) => future.expiry === futureExpiry)?.symbol ||
    mcxFutureSymbol(asset, futureExpiry)
  );
}

export function strategyChartSubscription(
  symbol: string,
  _exchange: string,
): { indexes: string[] } {
  // Nubra names this subscription input `indexes` for every symbol, including
  // equities and futures. Responses can still place those rows in `instruments`.
  return { indexes: [symbol] };
}
