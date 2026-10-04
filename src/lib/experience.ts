import type { Theme } from '../types';

export interface ExperienceOption {
  id: Theme;
  label: string;
  detail: string;
}

export const EXPERIENCE_OPTIONS: readonly ExperienceOption[] = [
  { id: 'dark', label: 'Dark', detail: 'Refined low-light workspace' },
  { id: 'light', label: 'Light', detail: 'Refined daytime workspace' },
  { id: 'graphite', label: 'Graphite', detail: 'Refined neutral chart workspace' },
  { id: 'bloomberg', label: 'Bloomberg', detail: 'High-density terminal' },
  { id: 'apex', label: 'Apex', detail: 'Next-generation institutional workspace' },
];

const THEMES = new Set<Theme>(EXPERIENCE_OPTIONS.map(({ id }) => id));

export function parseTheme(value: string | null | undefined): Theme {
  return value && THEMES.has(value as Theme) ? (value as Theme) : 'dark';
}

export function usesExperienceShell(theme: Theme): theme is 'bloomberg' | 'apex' {
  return theme === 'bloomberg' || theme === 'apex';
}
