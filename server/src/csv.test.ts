// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
//
// Locks the CSV export invariant (CLAUDE.md §13 "Security invariants — DO NOT REGRESS"):
// donor-controlled values reach the export from the public, unauthenticated intent
// endpoint, so every formula/DDE trigger must be neutralised and CSV structure preserved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvCell } from './csv';

/** Decode one CSV cell back to the raw string a spreadsheet would parse (strip the outer
 *  quotes + unescape doubled quotes), so we can assert on what the cell actually holds. */
function decode(cell: string): string {
  return cell.startsWith('"') && cell.endsWith('"') ? cell.slice(1, -1).replace(/""/g, '"') : cell;
}

test('neutralises every spreadsheet formula/DDE trigger', () => {
  // A leading = + - @ tab or CR would execute in Excel/Sheets/LibreOffice. The decoded cell
  // must begin with the "'" guard so the spreadsheet treats it as inert text, regardless of
  // whether the value also needed standard CSV quoting (comma/quote/newline).
  for (const v of ['=1+1', '=HYPERLINK("http://evil","x")', "=cmd|'/C calc'!A1", '+1', '-1', '@SUM(A1)', '\ttab', '\rcr']) {
    assert.equal(decode(csvCell(v)).startsWith("'"), true, `not neutralised: ${JSON.stringify(v)} → ${JSON.stringify(csvCell(v))}`);
  }
});

test('a dangerous value that also has a comma is BOTH prefixed and quoted', () => {
  // '=1,2' → prefix "'" then wrap because of the comma: "'=1,2" inside double quotes.
  assert.equal(csvCell('=1,2'), '"\'=1,2"');
});

test('leaves ordinary donor values untouched', () => {
  assert.equal(csvCell('Aisha Khan'), 'Aisha Khan');
  assert.equal(csvCell('aisha@example.com'), 'aisha@example.com');
  assert.equal(csvCell('£50.00'), '£50.00');
  assert.equal(csvCell(''), '');
  // A minus that is part of a normal value only matters at position 0; "A-1" is fine.
  assert.equal(csvCell('A-1'), 'A-1');
});

test('applies standard CSV quoting for commas, quotes and newlines', () => {
  assert.equal(csvCell('Khan, Aisha'), '"Khan, Aisha"');
  assert.equal(csvCell('she said "hi"'), '"she said ""hi"""');
  assert.equal(csvCell('line1\nline2'), '"line1\nline2"');
});

test('a phone-like "+1 555…" (formula trigger) is quoted, not executed', () => {
  assert.equal(csvCell('+1 555 0100'), "'+1 555 0100");
});
