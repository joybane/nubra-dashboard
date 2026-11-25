import { ColorType, CrosshairMode, LineStyle } from 'lightweight-charts';
import type { Theme } from '../types';

const palette = {
  dark: {
    background: '#101318',
    axis: '#aab6c8',
    grid: '#1d222a',
    border: '#2b313a',
    crosshair: '#8593a8',
    crosshairLabel: '#4657b7',
  },
  navy: {
    background: '#141d29',
    axis: '#afc0d3',
    grid: '#354252',
    border: '#354252',
    crosshair: '#a1b5cd',
    crosshairLabel: '#365888',
  },
  light: {
    background: '#ffffff',
    axis: '#4b6078',
    grid: 'rgba(71, 91, 118, 0.10)',
    border: '#cdd7e2',
    crosshair: '#647c99',
    crosshairLabel: '#4657b7',
  },
  graphite: {
    background: '#0b0e0f',
    axis: '#c1c7d0',
    grid: 'rgba(142, 151, 166, 0.075)',
    border: '#292d34',
    crosshair: '#7f8793',
    crosshairLabel: '#343b48',
  },
  bloomberg: {
    background: '#050709',
    axis: '#98a6b3',
    grid: 'rgba(116, 138, 157, 0.11)',
    border: '#26323b',
    crosshair: '#4ec9d7',
    crosshairLabel: '#126b76',
  },
  apex: {
    background: '#070b12',
    axis: '#aab8c8',
    grid: 'rgba(86, 197, 255, 0.075)',
    border: '#27364a',
    crosshair: '#56c5ff',
    crosshairLabel: '#2563eb',
  },
};

/** Shared visual options only. Callers retain their own scales, time zones and data. */
export function chartTheme(appearance: boolean | Theme, fontSize = 12) {
  const theme: Theme =
    typeof appearance === 'boolean' ? (appearance ? 'dark' : 'light') : appearance;
  const { background, axis, grid, border, crosshair, crosshairLabel } = palette[theme];
  return {
    layout: {
      background: {
        type: ColorType.Solid,
        color: background,
      },
      textColor: axis,
      fontSize,
      fontFamily:
        theme === 'bloomberg'
          ? "'Cascadia Mono', 'SFMono-Regular', Consolas, monospace"
          : "'Inter', 'Segoe UI', sans-serif",
    },
    grid: {
      vertLines: { color: grid, style: LineStyle.Solid },
      horzLines: { color: grid, style: LineStyle.Solid },
    },
    crosshair: {
      mode: CrosshairMode.Normal,
      vertLine: {
        color: crosshair,
        width: 1 as const,
        style: LineStyle.Dashed,
        labelBackgroundColor: crosshairLabel,
      },
      horzLine: {
        color: crosshair,
        width: 1 as const,
        style: LineStyle.Dashed,
        labelBackgroundColor: crosshairLabel,
      },
    },
    leftPriceScale: { borderColor: border },
    rightPriceScale: { borderColor: border },
    timeScale: { borderColor: border },
  };
}
