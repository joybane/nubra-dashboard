import { COLUMN_BY_KEY } from './tradeExplorer';

export interface Gloss {
  what: string;
  unlike?: string;
  where: string;
}

const WHAT: Record<string, string> = {
  ivNow:
    'The raw IV at the signal: the average of the call and put IV. It is not compared with anything.',
  ivUsual: 'What IV normally is on this day-to-expiry: the middle value of the last 20 such days.',
  ivRatio:
    'IV now divided by the usual IV. 1.00 means normal for this day-to-expiry; 1.20 means 20% higher than normal.',
  ivLevel:
    "The IV ratio placed in the phone app's five levels, Very low to Very high. The cut-offs differ by index and day-to-expiry.",
  warnGroup:
    'The report\'s warning group. "IV high for now" = IV now was well above the middle of the last 8 readings (a short memory, with the report\'s own cut-off for each day-to-expiry). "Other warning signs only" = IV was not high by that test, but the mismatch, the previous day\'s max loss or the morning move was large. "Calm" = none of these.',
  ceIv: 'IV of the one call leg (the 09:15 call) at the signal.',
  peIv: 'IV of the one put leg (the 09:15 put) at the signal.',
  skew: 'Put IV minus call IV, in points. Above zero means the put is priced richer than the call.',
  ceChange:
    'How much the seller gained or lost on the 09:15 call between t1 and the signal, ₹ per lot.',
  peChange:
    'How much the seller gained or lost on the 09:15 put between t1 and the signal, ₹ per lot.',
  both: 'The call and put changes added together, ₹ per lot.',
  gap: 'How far the call change and the put change disagreed, ₹ per lot. This is the mismatch the signal is built on.',
  gapPct: "The mismatch as a share of the bigger leg's change. The rule needs at least 50%.",
  premium: 'Call plus put price collected at entry, ₹ per lot.',
  theta: 'Time decay of both legs at the signal, ₹ per lot per day. More negative = more decay.',
  vega: 'How much both legs move for one point of IV, ₹ per lot.',
  deltaLean:
    'How one-sided the position is at the signal: 0 is balanced, higher leans to one side.',
  prevMaxLoss: "The previous trading day's max loss, ₹ per lot. Known before today's signal.",
  morning: 'How far spot moved from 09:15 to the signal.',
  dte: 'Trading days left to expiry: Exp is expiry day.',
};

const IV_UNLIKE =
  'There are several IV readings. "IV now" is the raw level. "IV ratio" and "IV level" compare it with the last 20 days on the same day-to-expiry (the phone\'s IV SIGNAL). The warning "IV high for now" compares it with only the last 8 readings and uses the report\'s cut-offs, so it picks partly different days from "IV level: Very high". "Call IV" and "Put IV" are single legs. "Put−call IV" is the gap between them. A finding about one is not a finding about the others.';
const LEG_UNLIKE =
  '"Call t1→t2" and "Put t1→t2" are each leg\'s own change. "Both" adds them. "Mismatch ₹" is how far they disagreed, and "Mismatch %" is that as a share of the bigger leg.';
const GREEK_UNLIKE =
  'Premium, Theta and Vega all grow with days to expiry and with IV, so they often pick the same days as "Day" or the IV readings.';
const TIME_UNLIKE =
  '"t1" is the first matching moment, "Signal" (t2) is when the trade is placed, and "t1→t2 min" is the wait between them.';

const UNLIKE: Record<string, string> = {};
for (const k of ['ivNow', 'ivUsual', 'ivRatio', 'ivLevel', 'ceIv', 'peIv', 'skew', 'warnGroup'])
  UNLIKE[k] = IV_UNLIKE;
for (const k of ['ceChange', 'peChange', 'both', 'gap', 'gapPct']) UNLIKE[k] = LEG_UNLIKE;
for (const k of ['premium', 'theta', 'vega']) UNLIKE[k] = GREEK_UNLIKE;
for (const k of ['t1', 't2', 'wait']) UNLIKE[k] = TIME_UNLIKE;

const PANEL: Record<string, string> = {
  Signal: 'In a day\'s detail: "The signal".',
  'IV signal': 'In a day\'s detail: "IV signal for this day".',
  Greeks: 'In a day\'s detail: "Greeks and IV at the signal".',
  Day: "In a day's detail: the facts at the top.",
  Trade: "In a day's detail: the facts at the top.",
  'After entry': 'In a day\'s detail: the chart and "Minute by minute".',
  'Report groups': 'In a day\'s detail: the chart and "Minute by minute".',
};
const PANEL_OVERRIDE: Record<string, string> = {
  prevMaxLoss: "In the table only: it is the previous day's Max loss.",
  warnGroup: "In a day's detail: the facts at the top.",
};
const LIVE = new Set(['ivRatio', 'ivLevel', 'ivNow', 'ivUsual']);

export function glossFor(key: string): Gloss {
  const c = COLUMN_BY_KEY.get(key);
  const panel = PANEL_OVERRIDE[key] ?? (c ? PANEL[c.section] : undefined) ?? '';
  const live = LIVE.has(key) ? ' Live: the IV SIGNAL card on the phone.' : '';
  return {
    what: WHAT[key] ?? c?.title ?? key,
    unlike: UNLIKE[key],
    where: `Table column "${c?.label ?? key}". ${panel}${live}`,
  };
}
