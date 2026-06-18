export type Sentiment = 'Bullish' | 'Bearish' | 'Neutral' | 'Volatile';

export interface StrategyTemplate {
  id:          string;
  label:       string;
  sentiment:   Sentiment;
  description: string;
  legs:  Array<{
    optionType: 'CE' | 'PE';
    side:       'BUY' | 'SELL';
    strikeDist: number;
    lots:       number;
  }>;
}

export const STRATEGY_TEMPLATES: StrategyTemplate[] = [
  {
    id: 'bull_call_spread', label: 'Bull Call Spread', sentiment: 'Bullish',
    description: 'Profit from a moderate increase by buying a lower-strike call and selling a higher-strike call.',
    legs: [
      { optionType: 'CE', side: 'BUY',  strikeDist: 0,  lots: 1 },
      { optionType: 'CE', side: 'SELL', strikeDist: +2, lots: 1 },
    ],
  },
  {
    id: 'bear_call_spread', label: 'Bear Call Spread', sentiment: 'Bearish',
    description: 'Profit from neutral to bearish view by selling ATM/slightly OTM call & buying higher-strike OTM call.',
    legs: [
      { optionType: 'CE', side: 'SELL', strikeDist: 0,  lots: 1 },
      { optionType: 'CE', side: 'BUY',  strikeDist: +2, lots: 1 },
    ],
  },
  {
    id: 'long_straddle', label: 'Long Straddle', sentiment: 'Volatile',
    description: 'Profit from significant price movements by buying ATM call and put simultaneously.',
    legs: [
      { optionType: 'CE', side: 'BUY', strikeDist: 0, lots: 1 },
      { optionType: 'PE', side: 'BUY', strikeDist: 0, lots: 1 },
    ],
  },
  {
    id: 'short_straddle', label: 'Short Straddle', sentiment: 'Neutral',
    description: 'Profit from limited movement or volatility contraction by selling ATM call and put simultaneously.',
    legs: [
      { optionType: 'CE', side: 'SELL', strikeDist: 0, lots: 1 },
      { optionType: 'PE', side: 'SELL', strikeDist: 0, lots: 1 },
    ],
  },
  {
    id: 'long_call_butterfly', label: 'Bull Butterfly', sentiment: 'Neutral',
    description: 'Profit from a specific price range with limited risk in a range-bound market (uses multiple calls).',
    legs: [
      { optionType: 'CE', side: 'BUY',  strikeDist: -2, lots: 1 },
      { optionType: 'CE', side: 'SELL', strikeDist: 0,  lots: 2 },
      { optionType: 'CE', side: 'BUY',  strikeDist: +2, lots: 1 },
    ],
  },
  {
    id: 'iron_condor', label: 'Iron Condor', sentiment: 'Neutral',
    description: 'Profit from moderate range-bound movement with limited risk (combines bull put and bear call spreads).',
    legs: [
      { optionType: 'PE', side: 'BUY',  strikeDist: -4, lots: 1 },
      { optionType: 'PE', side: 'SELL', strikeDist: -2, lots: 1 },
      { optionType: 'CE', side: 'SELL', strikeDist: +2, lots: 1 },
      { optionType: 'CE', side: 'BUY',  strikeDist: +4, lots: 1 },
    ],
  },
  {
    id: 'bear_put_spread', label: 'Bear Put Spread', sentiment: 'Bearish',
    description: 'Profit from moderate downward movement with limited risk by buying ATM put and selling OTM put.',
    legs: [
      { optionType: 'PE', side: 'BUY',  strikeDist: 0,  lots: 1 },
      { optionType: 'PE', side: 'SELL', strikeDist: -2, lots: 1 },
    ],
  },
  {
    id: 'bull_put_spread', label: 'Bull Put Spread', sentiment: 'Bullish',
    description: 'Profit from neutral to bullish view by selling higher-strike OTM put & buying ATM/slightly ITM put.',
    legs: [
      { optionType: 'PE', side: 'SELL', strikeDist: 0,  lots: 1 },
      { optionType: 'PE', side: 'BUY',  strikeDist: -2, lots: 1 },
    ],
  },
  {
    id: 'long_strangle', label: 'Long Strangle', sentiment: 'Volatile',
    description: 'Profit from large price movements in either direction by buying OTM call and OTM put.',
    legs: [
      { optionType: 'CE', side: 'BUY', strikeDist: +2, lots: 1 },
      { optionType: 'PE', side: 'BUY', strikeDist: -2, lots: 1 },
    ],
  },
  {
    id: 'short_strangle', label: 'Short Strangle', sentiment: 'Neutral',
    description: 'Profit from low volatility by selling OTM call and OTM put.',
    legs: [
      { optionType: 'CE', side: 'SELL', strikeDist: +2, lots: 1 },
      { optionType: 'PE', side: 'SELL', strikeDist: -2, lots: 1 },
    ],
  },
  {
    id: 'iron_butterfly', label: 'Iron Butterfly', sentiment: 'Neutral',
    description: 'Profit from a tight range with defined risk by combining a short straddle with protective wings.',
    legs: [
      { optionType: 'PE', side: 'BUY',  strikeDist: -3, lots: 1 },
      { optionType: 'PE', side: 'SELL', strikeDist: 0,  lots: 1 },
      { optionType: 'CE', side: 'SELL', strikeDist: 0,  lots: 1 },
      { optionType: 'CE', side: 'BUY',  strikeDist: +3, lots: 1 },
    ],
  },
  {
    id: 'jade_lizard', label: 'Jade Lizard', sentiment: 'Bullish',
    description: 'Credit strategy combining a short put with a bear call spread to eliminate upside risk.',
    legs: [
      { optionType: 'PE', side: 'SELL', strikeDist: -2, lots: 1 },
      { optionType: 'CE', side: 'SELL', strikeDist: +2, lots: 1 },
      { optionType: 'CE', side: 'BUY',  strikeDist: +4, lots: 1 },
    ],
  },
];
