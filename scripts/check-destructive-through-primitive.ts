#!/usr/bin/env tsx
/**
 * One behaviour for every destructive action in the admin UI: the operator confirms, and a loader
 * stays on screen until the work settles. Two paths give that, and nothing else does:
 *
 * 1. INSIDE a `DataTable`: a column's `render(row, index, table)` calls `table.destructive(row, spec)`;
 *    the table owns the pending / failed row.
 * 2. OUTSIDE a table: `useConfirm()({ …, action })`, `useDestructiveAction`, `ConfirmActionButton` or
 *    `ConfirmActionDialog`; the dialog stays open with a spinner and shows a failure in itself.
 *
 * What this refuses, textually, over `packages/addon-admin-ui/src/{pages,components,hooks,lib}`: a call
 * of a delete / remove / uninstall / purge / discard / revoke / forget / wipe mutation
 * (`x.mutate(` / `x.mutateAsync(`, the variable or the tRPC procedure named so) that is NOT, within
 * the six lines above it, an `action:` / `run:` of one of those paths, a `() => x.mutateAsync(` (the
 * promise handed to something that awaits it), a `mutationFn:` (the mutation's own definition) or one
 * of the dialog components. Typically that is a `useConfirm()` that closes at
 * once and then fires `.mutate(...)` with no loader.
 *
 * Every file that breaks it today is in `scripts/destructive-through-primitive-baseline.json`, with
 * the reason. The baseline only shrinks: a listed file that no longer breaks the rule is an error too.
 * Specs, `__tests__` and generated code are skipped.
 *
 * Usage: npx tsx scripts/check-destructive-through-primitive.ts
 */
import path from 'node:path'
import {
  compareToBaseline,
  type FamilyBaseline,
  type Finding,
  isMain,
  isProductSource,
  loadBaseline,
  ROOT,
  readSources,
  report,
  type SourceFile,
  type Violation,
  walk,
} from './lib/family-baseline.js'

export const BASELINE_PATH = 'scripts/destructive-through-primitive-baseline.json'
const ADMIN_UI_SRC = 'packages/addon-admin-ui/src/'
const SCANNED_DIRS: readonly string[] = ['pages/', 'components/', 'hooks/', 'lib/'].map(
  (dir) => `${ADMIN_UI_SRC}${dir}`,
)

const VERBS = String.raw`(?:delete|remove|uninstall|purge|discard|revoke|forget|wipe)`
/** `removeFoo.mutate(`, `deleteMutation.mutateAsync(`, `.integrationInstances.deleteInstance.mutate(`. */
const DESTRUCTIVE_CALL_RE = new RegExp(String.raw`\b\w*${VERBS}\w*\.mutate(?:Async)?\(`, 'i')
/** A line that sits inside one of the two approved paths, or is a mutation's own definition. */
const APPROVED_CONTEXT_RE =
  /\b(?:action|run)\s*:|=>\s*[\w.]+\.mutateAsync\(|\bmutationFn\s*:|\bConfirmAction(?:Button|Dialog)\b|\buseDestructiveAction\b|\btable\.destructive\(/
const COMMENT_LINE_RE = /^\s*(?:\*|\/\/|\/\*)/
const LOOKBACK_LINES = 6

function inScope(file: SourceFile): boolean {
  return (
    SCANNED_DIRS.some((dir) => file.path.startsWith(dir)) &&
    !file.path.includes('/__tests__/') &&
    !file.path.endsWith('.test.ts') &&
    !file.path.endsWith('.test.tsx')
  )
}

/** The 1-based lines of destructive mutation calls that no approved path wraps. */
export function bareDestructiveCalls(file: SourceFile): number[] {
  if (!inScope(file)) return []
  const lines = file.text.split('\n')
  const out: number[] = []
  lines.forEach((line, index) => {
    if (COMMENT_LINE_RE.test(line) || !DESTRUCTIVE_CALL_RE.test(line)) return
    const from = Math.max(0, index - LOOKBACK_LINES)
    const context = lines.slice(from, index + 1)
    if (context.some((l) => APPROVED_CONTEXT_RE.test(l))) return
    out.push(index + 1)
  })
  return out
}

export function findViolations(
  sources: readonly SourceFile[],
  baseline: FamilyBaseline,
): Violation[] {
  const findings: Finding[] = []
  for (const file of sources) {
    const lines = bareDestructiveCalls(file)
    if (lines.length === 0) continue
    findings.push({
      key: file.path,
      where: `${file.path}:${lines.join(',')}`,
      message: `a destructive mutation runs outside the two paths (no loader until it settles). Inside a DataTable use \`table.destructive(row, spec)\`; elsewhere \`useConfirm()({ …, action })\` / \`useDestructiveAction\` / \`ConfirmActionButton\` (docs/ui/README.md, "Destructive actions"). A file that cannot move yet is listed, with its reason, in ${BASELINE_PATH}`,
    })
  }
  return compareToBaseline(findings, baseline, BASELINE_PATH)
}

function main(): number {
  const files = walk(path.join(ROOT, ADMIN_UI_SRC), isProductSource)
  const violations = findViolations(readSources(files), loadBaseline(BASELINE_PATH))
  return report('check-destructive-through-primitive', violations)
}

if (isMain(import.meta.url)) process.exit(main())
