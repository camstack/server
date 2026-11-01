#!/usr/bin/env tsx
/**
 * The three host-external lists name the same specifiers.
 *
 * A loader hook, the addon-bundler's helper and the zero-dependency starter each
 * keep their own copy of "which bare specifiers an addon may leave unbundled and
 * expect the framework to provide" (the starter and the raw-ESM hook cannot import
 * the TypeScript one). A specifier present in one and absent in another resolves
 * on one node role and fails on another, with an error that names nothing. When
 * the framework moved under `@camstack/server/system` the three had to move
 * together; this is the check that says they did.
 *
 *   packages/system/src/kernel/host-externals.ts
 *   packages/system/src/kernel/moleculer/framework-resolver-hook.mjs
 *   packages/node-root/src/starter-core.ts
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')

export const HOST_EXTERNAL_FILES: readonly string[] = [
  'packages/system/src/kernel/host-externals.ts',
  'packages/system/src/kernel/moleculer/framework-resolver-hook.mjs',
  'packages/node-root/src/starter-core.ts',
]

/** The quoted entries of the `HOST_EXTERNAL_SPECIFIERS` array literal, comments ignored. */
export function extractHostExternals(source: string): readonly string[] | null {
  const start = source.search(/HOST_EXTERNAL_SPECIFIERS(?:\s*:\s*readonly string\[\])?\s*=\s*\[/)
  if (start < 0) return null
  const open = source.indexOf('[', source.indexOf('=', start))
  const close = source.indexOf(']', open)
  if (open < 0 || close < 0) return null
  const body = source
    .slice(open + 1, close)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '')
}

export interface HostExternalDrift {
  readonly file: string
  readonly missing: readonly string[]
  readonly extra: readonly string[]
}

export function findHostExternalDrift(
  files: readonly { readonly rel: string; readonly content: string }[],
): readonly HostExternalDrift[] {
  const lists = files.map((f) => ({ rel: f.rel, list: extractHostExternals(f.content) }))
  const unparsed = lists.filter((l) => l.list === null)
  if (unparsed.length > 0) {
    return unparsed.map((l) => ({
      file: l.rel,
      missing: ['<no HOST_EXTERNAL_SPECIFIERS array>'],
      extra: [],
    }))
  }
  const union = new Set(lists.flatMap((l) => l.list ?? []))
  const drift: HostExternalDrift[] = []
  for (const l of lists) {
    const have = new Set(l.list)
    const missing = [...union].filter((s) => !have.has(s)).sort()
    if (missing.length > 0) drift.push({ file: l.rel, missing, extra: [] })
  }
  return drift
}

function main(): void {
  const files = HOST_EXTERNAL_FILES.map((rel) => ({
    rel,
    content: readFileSync(path.join(ROOT, rel), 'utf-8'),
  }))
  const drift = findHostExternalDrift(files)
  if (drift.length === 0) {
    console.log(
      `check-host-externals-identical: ${files.length} lists, ${extractHostExternals(files[0]?.content ?? '')?.length ?? 0} specifiers each, identical`,
    )
    return
  }
  console.error('check-host-externals-identical: the host-external lists have drifted:')
  for (const d of drift) console.error(`  ${d.file} lacks: ${d.missing.join(', ')}`)
  process.exit(1)
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main()
}
