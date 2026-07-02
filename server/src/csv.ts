// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * CSV cell encoding for the donations export.
 *
 * Two jobs, both required (see CLAUDE.md §13 "Security invariants — DO NOT REGRESS"):
 *  1. Standard CSV quoting — wrap a value in double quotes (and double any embedded quote)
 *     when it contains a comma, quote, CR or LF, so columns can't bleed into each other.
 *  2. Spreadsheet formula / DDE injection defence — donor name + email reach the export
 *     from the PUBLIC, UNAUTHENTICATED donation-intent endpoint, so a value like
 *     `=HYPERLINK(...)`, `+cmd|'/C calc'!A1` or `@SUM(...)` would EXECUTE when an admin
 *     opens the file in Excel / Google Sheets / LibreOffice. We prefix any value that
 *     begins with a formula trigger (`= + - @`, tab or CR) with a single quote — the OWASP
 *     mitigation — which is harmless for every legitimate value.
 *
 * Every cell written to the export MUST go through this function. Kept as its own module
 * so the invariant is locked by csv.test.ts and can't silently regress.
 */
export function csvCell(v: string): string {
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
