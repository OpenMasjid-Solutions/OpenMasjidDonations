// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
/**
 * The accent palette is MEASURED, not trusted.
 *
 * OpenMasjidOS hands an app one of five accent colours and the app repaints its buttons with it.
 * This app shipped doing half of that: `applyAccent` set the FILL (`--color-btn`) and left the INK
 * (`--color-on-primary`) at whatever the theme said — which in light theme is white. White on the
 * raw accents measures 1.67:1 (gold) to 2.72:1 (violet) against AA's 4.5:1, and the element it
 * lands on is the Donate button. The platform's UI spec §3 calls this out by name as a bug it had
 * already paid for once; Display and the platform both carry `onPrimary`, and only this app didn't.
 *
 * So the pairings are checked here arithmetically. Three things make this test worth its lines:
 *
 *  1. It reads `web/src/prefs.ts` and `web/src/styles/tokens.css` AS TEXT. Nothing in the server
 *     imports the web tree, and no test runner reaches it (see the header of `web/src/phone.ts`) —
 *     parsing the real files is the only way this suite can see them at all, and it means the
 *     numbers here cannot drift from the numbers that ship.
 *  2. It measures WCAG contrast rather than asserting hex strings, so a future colour change is
 *     judged on whether it is readable, not on whether it matches a value somebody pasted.
 *  3. It asserts that `applyAccent` writes the ink at all. A palette with a perfect `onPrimary`
 *     column is worth nothing if the function stops setting it, which is exactly the regression
 *     this file exists to prevent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PREFS = path.join(__dirname, '..', '..', 'web', 'src', 'prefs.ts');
const TOKENS = path.join(__dirname, '..', '..', 'web', 'src', 'styles', 'tokens.css');

/** AA for normal-size text. Large text may use 3.0; nothing here relies on being large. */
const AA = 4.5;

// The surfaces an accent actually lands on, from tokens.css. Named so a failure says WHERE.
const LIGHT_PAGE = '#F0F9FF'; // --color-surface, light
const LIGHT_CARD = '#FFFFFF'; // --color-surface-raised, light
const DARK_PAGE = '#030D1A'; // --color-surface, dark
const DARK_CARD = '#0A1828'; // --color-surface-raised, dark

function channel(c: number): number {
  const x = c / 255;
  return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance of an `#rrggbb` colour. */
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const n = parseInt(h, 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

/** WCAG contrast ratio between two `#rrggbb` colours, 1.0 (identical) to 21.0 (black on white). */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

interface Accent {
  id: string;
  primary: string;
  hover: string;
  onPrimary: string;
  textLight: string;
}

/** Parse the ACCENTS table out of `web/src/prefs.ts`. Kept as a flat literal there so this works. */
function accents(): Accent[] {
  const src = fs.readFileSync(PREFS, 'utf8');
  const start = src.indexOf('export const ACCENTS');
  assert.ok(start > 0, 'web/src/prefs.ts must export an ACCENTS table');
  const body = src.slice(start, src.indexOf('};', start));
  const out: Accent[] = [];
  const row =
    /(\w+):\s*\{\s*primary:\s*'(#[0-9A-Fa-f]{6})',\s*hover:\s*'(#[0-9A-Fa-f]{6})',\s*onPrimary:\s*'(#[0-9A-Fa-f]{6})',\s*textLight:\s*'(#[0-9A-Fa-f]{6})'\s*\}/g;
  for (let m = row.exec(body); m; m = row.exec(body)) {
    out.push({ id: m[1], primary: m[2], hover: m[3], onPrimary: m[4], textLight: m[5] });
  }
  return out;
}

/** A `--custom-property: #rrggbb;` from a named block of tokens.css. */
function token(block: string, name: string): string {
  const css = fs.readFileSync(TOKENS, 'utf8');
  const at = css.indexOf(block);
  assert.ok(at > 0, `tokens.css must contain a ${block} block`);
  const scope = css.slice(at, css.indexOf('\n}', at));
  const m = new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(scope);
  assert.ok(m, `${block} must define ${name}`);
  return m[1];
}

test('the five platform accents are all present, and only those five', () => {
  const ids = accents().map((a) => a.id);
  // From the platform's UI spec §3. A sixth would be one this app invented; a missing one is a
  // masjid whose chosen colour silently falls back to cyan.
  assert.deepEqual(ids, ['cyan', 'teal', 'sky', 'violet', 'gold']);
});

test('every accent fill carries ink that clears AA — this is the Donate button', () => {
  for (const a of accents()) {
    const onFill = contrast(a.onPrimary, a.primary);
    assert.ok(
      onFill >= AA,
      `accent "${a.id}": ink ${a.onPrimary} on fill ${a.primary} is ${onFill.toFixed(2)}:1, under AA ${AA}`,
    );
    const onHover = contrast(a.onPrimary, a.hover);
    assert.ok(
      onHover >= AA,
      `accent "${a.id}": ink ${a.onPrimary} on HOVER fill ${a.hover} is ${onHover.toFixed(2)}:1, under AA ${AA}`,
    );
  }
});

test('white ink on a raw accent fails — the regression this palette exists to prevent', () => {
  // Not a style assertion: it is the witness. If some future edit makes white readable on these,
  // the fills have stopped being the platform's fills and the rest of this file means nothing.
  for (const a of accents()) {
    const white = contrast('#FFFFFF', a.primary);
    assert.ok(
      white < AA,
      `accent "${a.id}" is no longer a bright fill (white measures ${white.toFixed(2)}:1) — re-check that it still matches the platform`,
    );
  }
});

test('the accent as TEXT clears AA on the light card AND the light page', () => {
  for (const a of accents()) {
    for (const [where, bg] of [
      ['light card', LIGHT_CARD],
      ['light page', LIGHT_PAGE],
    ] as const) {
      const r = contrast(a.textLight, bg);
      assert.ok(
        r >= AA,
        `accent "${a.id}": textLight ${a.textLight} on the ${where} ${bg} is ${r.toFixed(2)}:1, under AA ${AA}`,
      );
    }
    // And it must still be recognisably the masjid's colour, not a slide into grey.
    assert.notEqual(a.textLight.toLowerCase(), a.primary.toLowerCase());
  }
});

test('the dark theme needs no text variant — the raw accent already reads there', () => {
  // This is why `applyAccent` only swaps in `textLight` when the theme is light. If it ever stopped
  // being true, that branch would be hiding an unreadable colour rather than avoiding one.
  for (const a of accents()) {
    for (const [where, bg] of [
      ['dark page', DARK_PAGE],
      ['dark card', DARK_CARD],
    ] as const) {
      const r = contrast(a.primary, bg);
      assert.ok(
        r >= AA,
        `accent "${a.id}": raw ${a.primary} as text on the ${where} ${bg} is ${r.toFixed(2)}:1, under AA ${AA}`,
      );
    }
  }
});

test("the stylesheet's own primary clears AA as text in BOTH themes", () => {
  // The accent is only applied when a dashboard hands us one. A standalone masjid never gets past
  // these two values, so they are the ones most installs actually read.
  const light = token('[data-theme="light"]', '--color-primary');
  for (const [where, bg] of [
    ['light card', LIGHT_CARD],
    ['light page', LIGHT_PAGE],
  ] as const) {
    const r = contrast(light, bg);
    assert.ok(r >= AA, `light --color-primary ${light} on the ${where} is ${r.toFixed(2)}:1, under AA ${AA}`);
  }
  const dark = token('[data-theme="dark"]', '--color-primary');
  for (const [where, bg] of [
    ['dark card', DARK_CARD],
    ['dark page', DARK_PAGE],
  ] as const) {
    const r = contrast(dark, bg);
    assert.ok(r >= AA, `dark --color-primary ${dark} on the ${where} is ${r.toFixed(2)}:1, under AA ${AA}`);
  }
});

test('applyAccent writes the ink whenever it writes a fill, and clears it when it clears one', () => {
  // The palette above is worthless if the function stops applying half of it. Read as text for the
  // same reason as everything else here: the server cannot import the web tree.
  const src = fs.readFileSync(PREFS, 'utf8');
  const fn = src.slice(src.indexOf('export function applyAccent'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));

  assert.ok(body.includes("setProperty('--color-btn'"), 'applyAccent must set the fill');
  assert.ok(
    body.includes("setProperty('--color-on-primary'"),
    'applyAccent sets a fill without its ink — this is the 1.67:1 Donate button, see the header of this file',
  );
  assert.ok(
    body.includes("removeProperty") && body.includes('--color-on-primary'),
    'the "no accent" branch must remove --color-on-primary too, or the last accent\'s ink sticks to the stylesheet\'s own button',
  );
  // The text form must be theme-dependent; a flat `a.primary` here is the light-theme bug again.
  assert.match(
    body,
    /setProperty\('--color-primary',\s*light \? a\.textLight : a\.primary\)/,
    'applyAccent must use textLight for --color-primary in the light theme',
  );
});
