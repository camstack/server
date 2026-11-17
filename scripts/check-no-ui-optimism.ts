#!/usr/bin/env tsx
/**
 * The client-side optimism helpers stay removed from the UI (D1061).
 *
 * What it checks: no UI source names `useOptimisticSlice`,
 * `applyOptimistic*`, `OptimisticApply`, `UseOptimisticSlice*` or imports
 * `use-optimistic-slice`. What it does NOT check: a control that patches a
 * served slice by hand (local state copied from the slice and overwritten on
 * a command) — that is a review item, not something this scan can see.
 *
 * The hub holds a commanded value until the device confirms it, and serves
 * that held slice to every client. A control that patched its own display
 * (the former `useOptimisticSlice` / `applyOptimisticAction`) showed what THIS
 * client sent, on its own timers, so two clients disagreed and a refused or
 * slow command looked different in each. A control now renders the served
 * slice and runs its command through `useDeviceCommand`, which only reports a
 * refusal.
 *
 * Scope: the UI — `packages/ui-library/src`, `packages/addon-admin-ui/src`
 * and every `.tsx` under `packages/<pkg>/src` (addon pages and widgets),
 * specs included (a spec has no reason to mock a client-side patch). A device
 * provider's own `.ts` is not UI and is not scanned. Comment-only lines are
 * skipped (prose may name the old hook to explain its removal). The viewer
 * lives in its own repository.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const FORBIDDEN =
  /\b(?:useOptimisticSlice|applyOptimistic\w*|OptimisticApply|UseOptimisticSlice\w*)\b|use-optimistic-slice/

/** Packages whose whole `src` is UI. */
const UI_PACKAGES = new Set(['ui-library', 'addon-admin-ui'])

const SKIP_DIRS = new Set(['dist', 'node_modules', '.git', 'coverage', 'generated'])
const SOURCE_RE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/

export interface SourceFile {
  readonly path: string
  readonly text: string
}

export interface UiOptimismFinding {
  readonly file: string
  readonly line: number
  readonly text: string
}

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
    if (statSync(full).isDirectory()) walk(full, out)
    else if (SOURCE_RE.test(name)) out.push(full)
  }
}

/** Is `rel` (repo-relative, `/`-separated) UI code? */
export function isUiSource(rel: string): boolean {
  const m = /^packages\/([^/]+)\/src\//.exec(rel)
  if (m === null) return false
  return UI_PACKAGES.has(m[1] ?? '') || rel.endsWith('.tsx')
}

function isCommentLine(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')
}

export function findUiOptimism(files: readonly SourceFile[]): UiOptimismFinding[] {
  const findings: UiOptimismFinding[] = []
  for (const { path: rel, text: content } of files) {
    if (!isUiSource(rel)) continue
    for (const [i, text] of content.split('\n').entries()) {
      if (isCommentLine(text)) continue
      if (FORBIDDEN.test(text)) findings.push({ file: rel, line: i + 1, text: text.trim() })
    }
  }
  return findings
}

function main(): void {
  const paths: string[] = []
  for (const pkg of readdirSync(path.join(ROOT, 'packages'))) {
    walk(path.join(ROOT, 'packages', pkg, 'src'), paths)
  }
  const files = paths
    .map((p) => path.relative(ROOT, p).split(path.sep).join('/'))
    .filter(isUiSource)
    .map((rel) => ({ path: rel, text: readFileSync(path.join(ROOT, rel), 'utf-8') }))
  const findings = findUiOptimism(files)
  if (findings.length === 0) {
    console.log(
      `check-no-ui-optimism: ${files.length} UI files, none uses the removed optimism helpers`,
    )
    return
  }
  console.error(
    'check-no-ui-optimism: a control renders the slice the hub serves (it holds a commanded ' +
      'value until the device confirms it, D1061); run the command through useDeviceCommand:',
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
