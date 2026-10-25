#!/usr/bin/env tsx
/**
 * Cosmetically normalize `.d.ts` text so TS 6 and TS 7 declaration emit can be
 * compared for semantic equality (P2 gate,
 * docs/design/2026-10-09-ts7-transition-plan.md).
 *
 * Differences this collapses:
 *   - single-quoted vs double-quoted string-literal types
 *   - whitespace around `|` in unions and `;` / `,` in object types
 *   - trailing commas / semicolons inside type members
 *
 * It does NOT reorder union members or object keys — those need a real AST
 * pass if they appear. Usage:
 *   npx tsx scripts/dts-normalize.ts <file.d.ts>…   # print normalized to stdout
 *   npx tsx scripts/dts-normalize.ts --write <dir>  # rewrite every .d.ts under dir
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export function normalizeDts(text: string): string {
  let out = text
  // String-literal types: 'foo' → "foo" (only inside type positions is hard;
  // a global swap of single-quoted string literals is enough for our emit).
  out = out.replace(
    /'((?:\\'|[^'])*)'/g,
    (_m, inner: string) => `"${inner.replace(/\\'/g, "'").replace(/"/g, '\\"')}"`,
  )
  // Collapse runs of whitespace (keep newlines for readability of diffs).
  out = out.replace(/[ \t]+/g, ' ')
  out = out.replace(/ *\n */g, '\n')
  // Spacing around union / intersection.
  out = out.replace(/ *\| */g, ' | ')
  out = out.replace(/ *& */g, ' & ')
  // Trailing commas before } or ] in type positions.
  out = out.replace(/,(\s*[}\]])/g, '$1')
  // Normalize `;` vs `,` separators inside interfaces/types to `;`.
  out = out.replace(/,(\n\s*(?:readonly\s+)?[\w"'[\]]+:)/g, ';$1')
  return out.trimEnd() + '\n'
}

function walkDts(dir: string): string[] {
  const out: string[] = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...walkDts(full))
    else if (ent.name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

function main(argv: readonly string[]): number {
  if (argv[0] === '--write') {
    const root = argv[1]
    if (!root) {
      console.error('usage: dts-normalize.ts --write <dir>')
      return 2
    }
    for (const file of walkDts(root)) {
      const before = fs.readFileSync(file, 'utf8')
      const after = normalizeDts(before)
      if (after !== before) fs.writeFileSync(file, after)
    }
    return 0
  }
  if (argv.length === 0) {
    console.error('usage: dts-normalize.ts <file.d.ts>… | --write <dir>')
    return 2
  }
  for (const file of argv) {
    process.stdout.write(normalizeDts(fs.readFileSync(file, 'utf8')))
  }
  return 0
}

process.exit(main(process.argv.slice(2)))
