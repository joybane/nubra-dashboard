import type { Instrument } from '../types';
import { getInstrumentType } from '../types';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

interface ParsedContract {
  type: 'FUT' | 'OPT';
  asset: string;
  expiry?: string;
  optionType?: string;
  strike?: number;
}

function cleanName(value: unknown): string {
  return String(value ?? '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function contractSymbol(item: Instrument): string {
  return String(
    item.zanskar_name ||
      item.nubra_name ||
      item.trading_symbol ||
      item.symbol ||
      item.stock_name ||
      item.display_name ||
      '',
  ).toUpperCase();
}

function parseContractSymbol(item: Instrument): ParsedContract | null {
  const symbol = contractSymbol(item);
  const future = /^FUT_([A-Z][A-Z0-9]*)_(\d{8})$/.exec(symbol);
  if (future) return { type: 'FUT', asset: future[1], expiry: future[2] };

  const option = /^OPT_([A-Z][A-Z0-9]*)_(\d{8})_(CE|PE)_(\d+(?:\.\d+)?)$/.exec(symbol);
  if (option) {
    return {
      type: 'OPT',
      asset: option[1],
      expiry: option[2],
      optionType: option[3],
      strike: Number(option[4]),
    };
  }
  return null;
}

function expiryParts(value: string | number | null | undefined): {
  day: string;
  month: string;
  year: string;
} | null {
  if (value == null || value === '') return null;
  const raw = String(value);
  if (/^\d{8}$/.test(raw)) {
    const monthIndex = Number(raw.slice(4, 6)) - 1;
    if (monthIndex >= 0 && monthIndex < 12) {
      return { day: raw.slice(6, 8), month: MONTHS[monthIndex], year: raw.slice(2, 4) };
    }
  }

  const numeric = Number(value);
  const date =
    Number.isFinite(numeric) && numeric > 1_000_000_000
      ? new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric)
      : new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return {
    day: String(date.getUTCDate()).padStart(2, '0'),
    month: MONTHS[date.getUTCMonth()],
    year: String(date.getUTCFullYear()).slice(-2),
  };
}

function strikeValue(item: Instrument, parsed: ParsedContract | null): number | null {
  const raw = Number(item.strike_price ?? parsed?.strike);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return raw > 10_000 ? raw / 100 : raw;
}

function formatStrike(value: number): string {
  return value.toLocaleString('en-IN', {
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

function baseName(item: Instrument, parsed: ParsedContract | null, isDerivative: boolean): string {
  if (isDerivative && item.asset) return cleanName(item.asset).toUpperCase();
  if (isDerivative && parsed?.asset) return cleanName(parsed.asset).toUpperCase();

  const preferred = item.stock_name || item.display_name || item.symbol || contractSymbol(item);
  return cleanName(preferred) || 'Unknown';
}

/** Human-facing instrument name. Trading/API symbols must continue using getSymbol(). */
export function formatInstrumentName(item: Instrument): string {
  const parsed = parseContractSymbol(item);
  const type = parsed?.type || getInstrumentType(item);
  const asset = baseName(item, parsed, type === 'FUT' || type === 'OPT');
  const expiry = expiryParts(item.expiry ?? parsed?.expiry);

  if (type === 'FUT') {
    return expiry ? `${asset} ${expiry.month} ${expiry.year} FUT` : `${asset} FUT`;
  }

  if (type === 'OPT') {
    const strike = strikeValue(item, parsed);
    const optionType = String(item.option_type || parsed?.optionType || '').toUpperCase();
    return [
      asset,
      expiry ? `${expiry.day} ${expiry.month} ${expiry.year}` : '',
      strike == null ? '' : formatStrike(strike),
      optionType,
    ]
      .filter(Boolean)
      .join(' ');
  }

  return asset;
}

/** A useful ticker alias for cash instruments; hides opaque derivative vendor symbols. */
export function instrumentSearchAlias(item: Instrument): string {
  const type = getInstrumentType(item);
  if (type === 'FUT' || type === 'OPT') return '';
  const alias = cleanName(
    item.nubra_name || item.zanskar_name || item.symbol || item.trading_symbol,
  );
  const name = formatInstrumentName(item);
  return alias && alias.toUpperCase() !== name.toUpperCase() ? alias : '';
}
