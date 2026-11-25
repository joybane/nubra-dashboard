interface SignalMoney {
  ceDelta: number;
  peDelta: number;
  totalDelta: number;
  gap: number;
}

interface SignalPrices extends SignalMoney {
  ce1: number;
  ce2: number;
  pe1: number;
  pe2: number;
}

/** Read one lot of signal money from the two marks, even in older lists without the run's qty. */
export function signalLotMoney(signal: SignalPrices, lot: number): SignalMoney {
  const callPoints = signal.ce1 - signal.ce2;
  const putPoints = signal.pe1 - signal.pe2;
  const side = Math.sign(callPoints * signal.ceDelta + putPoints * signal.peDelta);
  if (!side) {
    const { ceDelta, peDelta, totalDelta, gap } = signal;
    return { ceDelta, peDelta, totalDelta, gap };
  }
  const money = (value: number) => Math.round(value * 100) / 100;
  const ceDelta = money(callPoints * side * lot);
  const peDelta = money(putPoints * side * lot);
  return {
    ceDelta,
    peDelta,
    totalDelta: money(ceDelta + peDelta),
    gap: money(Math.abs(ceDelta - peDelta)),
  };
}
