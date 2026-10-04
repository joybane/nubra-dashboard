import { describe, expect, it } from 'vitest';
import { EXPERIENCE_OPTIONS, parseTheme, usesExperienceShell } from './experience';

describe('experience configuration', () => {
  it('keeps every experience in the shared picker exactly once', () => {
    const ids = EXPERIENCE_OPTIONS.map(({ id }) => id);

    expect(ids).toEqual(['dark', 'light', 'graphite', 'bloomberg', 'apex']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('restores supported themes and safely falls back for stale values', () => {
    expect(parseTheme('apex')).toBe('apex');
    expect(parseTheme('bloomberg')).toBe('bloomberg');
    expect(parseTheme('classic')).toBe('dark');
    expect(parseTheme(null)).toBe('dark');
  });

  it('uses a dedicated shell only for the autonomous experiences', () => {
    expect(usesExperienceShell('bloomberg')).toBe(true);
    expect(usesExperienceShell('apex')).toBe(true);
    expect(usesExperienceShell('dark')).toBe(false);
    expect(usesExperienceShell('light')).toBe(false);
    expect(usesExperienceShell('graphite')).toBe(false);
  });
});
