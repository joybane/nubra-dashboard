import { ColorType, CrosshairMode, LineStyle } from 'lightweight-charts';
import type { Theme } from '../types';

/** Shared visual options only. Callers retain their own scales, time zones and data. */
export function chartTheme(appearance: boolean | Theme, fontSize = 12) {
  const theme: Theme =
    typeof appearance === 'boolean' ? (appearance ? 'dark' : 'light') : appearance;
  const isDark = theme !== 'light';
  const isBloomberg = theme === 'bloomberg';
  const isGraphite = theme === 'graphite';
  const isApex = theme === 'apex';
  const grid = isBloomberg
    ? 'rgba(116, 138, 157, 0.11)'
    : isApex
      ? 'rgba(86, 197, 255, 0.075)'
      : isGraphite
        ? 'rgba(142, 151, 166, 0.075)'
        : isDark
          ? 'rgba(151, 169, 199, 0.08)'
          : 'rgba(59, 78, 106, 0.08)';
  const crosshair = isBloomberg
    ? '#4ec9d7'
    : isApex
      ? '#56c5ff'
      : isGraphite
        ? '#7f8793'
        : isDark
          ? '#7789a4'
          : '#7a8ba5';
  const border = isBloomberg
    ? '#26323b'
    : isApex
      ? '#27364a'
      : isGraphite
        ? '#292d34'
        : isDark
          ? '#2b3340'
          : '#dce2ec';
  return {
    layout: {
      background: {
        type: ColorType.Solid,
        color: isBloomberg
          ? '#050709'
          : isApex
            ? '#070b12'
            : isGraphite
              ? '#0b0e0f'
              : isDark
                ? '#101318'
                : '#ffffff',
      },
      textColor: isBloomberg
        ? '#98a6b3'
        : isApex
          ? '#aab8c8'
          : isGraphite
            ? '#c1c7d0'
            : isDark
              ? '#aebbd0'
              : '#4b5c73',
      fontSize,
      fontFamily: isBloomberg
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
        labelBackgroundColor: isBloomberg
          ? '#126b76'
          : isApex
            ? '#2563eb'
            : isGraphite
              ? '#343b48'
              : '#4657b7',
      },
      horzLine: {
        color: crosshair,
        width: 1 as const,
        style: LineStyle.Dashed,
        labelBackgroundColor: isBloomberg
          ? '#126b76'
          : isApex
            ? '#2563eb'
            : isGraphite
              ? '#343b48'
              : '#4657b7',
      },
    },
    leftPriceScale: { borderColor: border },
    rightPriceScale: { borderColor: border },
    timeScale: { borderColor: border },
  };
}
