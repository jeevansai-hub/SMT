import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// A11Y-6: text >= 4.5:1, UI components and focus >= 3:1, for the light and dark token sets.
const css = readFileSync(resolve(__dirname, '../styles/app.css'), 'utf8');

function tokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]] = m[2];
  return out;
}
const lightBlock = css.slice(css.indexOf(':root {'), css.indexOf('@media (prefers-color-scheme: dark)'));
const darkStart = css.indexOf('@media (prefers-color-scheme: dark)');
const darkBlock = css.slice(darkStart, css.indexOf('*, *::before', darkStart));
const light = tokens(lightBlock);
const dark = { ...light, ...tokens(darkBlock) };

function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
export function ratio(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const TEXT_PAIRS: Array<[string, string]> = [
  ['color-text', 'color-surface'],
  ['color-text', 'color-surface-alt'],
  ['color-text-muted', 'color-surface'],
  ['color-text-muted', 'color-surface-alt'],
  ['color-primary', 'color-surface'],
  ['color-primary', 'color-surface-alt'],
  ['color-on-primary', 'color-primary'],
  ['color-success', 'color-surface'],
  ['color-success', 'color-surface-alt'],
  ['color-warning-text', 'color-warning-bg'],
  ['color-error', 'color-surface'],
  ['color-error', 'color-surface-alt'],
  ['color-text', 'color-neutral-chip-bg'],
];
const UI_PAIRS: Array<[string, string]> = [
  ['color-border', 'color-surface'],
  ['color-focus', 'color-surface'],
];

describe.each([
  ['light', light],
  ['dark', dark],
] as const)('design tokens (%s)', (_name, t) => {
  it.each(TEXT_PAIRS)('should_give_text_pair_%s_on_%s_at_least_4.5_to_1', (fg, bg) => {
    expect(ratio(t[fg], t[bg])).toBeGreaterThanOrEqual(4.5);
  });
  it.each(UI_PAIRS)('should_give_component_pair_%s_on_%s_at_least_3_to_1', (fg, bg) => {
    expect(ratio(t[fg], t[bg])).toBeGreaterThanOrEqual(3);
  });
});

describe('ux-flows 9.1 light tokens are used as specified', () => {
  it('should_match_the_documented_values', () => {
    expect(light['color-text']).toBe('#0d1c2e');
    expect(light['color-primary']).toBe('#4338ca');
    expect(light['color-error']).toBe('#ba1a1a');
    expect(light['color-border']).toBe('#777586');
  });
});
