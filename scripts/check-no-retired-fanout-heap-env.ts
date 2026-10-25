#!/usr/bin/env tsx
/**
 * No runtime code reads the retired heap-snapshot or event-fanout mode envs.
 *
 * D718 removed:
 *   - `CAMSTACK_RUNNER_HEAP_SNAPSHOT` (and the `writeHeapSnapshot` writer —
 *     also refused by `check-no-heap-dump-command.ts`)
 *   - `CAMSTACK_MOLECULER_EVENT_FANOUT` / `CAMSTACK_UDS_EVENT_FANOUT`
 *     (`filter | shadow | broadcast` mode switches)
 *
 * Both event planes always filter. SIGUSR2 reports heap spaces and never
 * writes a snapshot. A container template that still sets these variables is
 * ignored by the product; this guard keeps a reader from coming back.
 *
 * Scope: runtime source under `packages/<pkg>/src` and `server/backend/src`,
 * excluding specs and generated code. Comment-only lines may name the
 * variables to explain the removal.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const RETIRED = /\bCAMSTACK_(?:RUNNER_HEAP_SNAPSHOT|MOLECULER_EVENT_FANOUT|UDS_EVENT_FANOUT)\b/

const SKIP_DIRS = new Set([
  'dist',
  'node_modules',
  '.git',
  'coverage',
  'generated',
  '__tests__',
  '__mocks__',
])
const SOURCE_RE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/
const NON_RUNTIME_RE = /\.(?:spec|test|d)\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/

function walk(dir: string, out: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue
    const full = path.join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) walk(full, out)
    else if (SOURCE_RE.test(name) && !NON_RUNTIME_RE.test(name)) out.push(full)
  }
}

function runtimeRoots(): string[] {
  const roots = [path.join(ROOT, 'server/backend/src')]
  for (const pkg of readdirSync(path.join(ROOT, 'packages'))) {
    roots.push(path.join(ROOT, 'packages', pkg, 'src'))
  }
  return roots
}

function isCommentLine(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')
}

export interface RetiredFanoutHeapEnvFinding {
  readonly file: string
  readonly line: number
  readonly text: string
}

export function findRetiredFanoutHeapEnvReads(
  files: readonly { readonly rel: string; readonly content: string }[],
): RetiredFanoutHeapEnvFinding[] {
  const findings: RetiredFanoutHeapEnvFinding[] = []
  for (const { rel, content } of files) {
    for (const [i, text] of content.split('\n').entries()) {
      if (isCommentLine(text)) continue
      if (RETIRED.test(text)) findings.push({ file: rel, line: i + 1, text: text.trim() })
    }
  }
  return findings
}

function main(): void {
  const paths: string[] = []
  for (const root of runtimeRoots()) walk(root, paths)
  const files = paths.map((p) => ({
    rel: path.relative(ROOT, p).split(path.sep).join('/'),
    content: readFileSync(p, 'utf-8'),
  }))
  const findings = findRetiredFanoutHeapEnvReads(files)
  if (findings.length === 0) {
    console.log(
      `check-no-retired-fanout-heap-env: ${files.length} runtime files, none name the retired vars`,
    )
    return
  }
  console.error(
    'check-no-retired-fanout-heap-env: CAMSTACK_RUNNER_HEAP_SNAPSHOT / ' +
      'CAMSTACK_MOLECULER_EVENT_FANOUT / CAMSTACK_UDS_EVENT_FANOUT are gone (D718) — ' +
      'event planes always filter; no process writes a heap snapshot:',
  )
  for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.text}`)
  process.exit(1)
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main()
}
