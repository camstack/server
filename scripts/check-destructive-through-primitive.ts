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
/** `action: async (x) =>` / `run: () =>` / `mutationFn: id =>` — the head of an approved arrow, just before `{`. */
const APPROVED_ARROW_HEAD_RE =
  /\b(?:action|run|mutationFn)\s*:\s*(?:async\s*)?(?:\([^()]*\)|\w+)\s*=>$/
/** The promise handed straight to something that awaits it: `=> x.mutateAsync(`, `run: () => x.mutate(`. */
const ARROW_BEFORE_CALL_RE = /=>\s*$/
const APPROVED_TAG_RE = /<ConfirmAction(?:Button|Dialog)\b/g
const COMMENT_LINE_RE = /^\s*(?:\*|\/\/|\/\*)/
const OPENERS: Readonly<Record<string, string>> = { '(': ')', '{': '}', '[': ']' }

/** Offsets of the brackets still open at `offset`, outermost first. */
function openBracketsAt(text: string, offset: number): number[] {
  const stack: number[] = []
  for (let i = 0; i < offset; i += 1) {
    const ch = text.charAt(i)
    if (OPENERS[ch] !== undefined) stack.push(i)
    else if (ch === ')' || ch === '}' || ch === ']') stack.pop()
  }
  return stack
}

/** True when the `{` at `open` is the body of an `action:` / `run:` / `mutationFn:` arrow. */
function isApprovedArrowBody(text: string, open: number): boolean {
  if (text.charAt(open) !== '{') return false
  const head = text.slice(Math.max(0, open - 160), open).trimEnd()
  return APPROVED_ARROW_HEAD_RE.test(head)
}

/** True when an approved dialog tag is open (its `/>` not reached) around `offset`. */
function insideApprovedTag(text: string, offset: number): boolean {
  let tagAt = -1
  for (const match of text.slice(0, offset).matchAll(APPROVED_TAG_RE)) tagAt = match.index
  if (tagAt < 0) return false
  const between = text.slice(tagAt, offset)
  return !/\/>|<\/ConfirmAction/.test(between) && openBracketsAt(between, between.length).length > 0
}

/** The mutate call sits inside the value of an approved path, not merely below one. */
function enclosedByApproved(text: string, callOffset: number, callEnd: number): boolean {
  const before = text
    .slice(0, callOffset)
    .replace(/[\w.$?]*$/, '')
    .trimEnd()
  if (APPROVED_ARROW_HEAD_RE.test(before)) return true
  if (ARROW_BEFORE_CALL_RE.test(before) && text.startsWith('mutateAsync(', callEnd)) return true
  if (openBracketsAt(text, callOffset).some((open) => isApprovedArrowBody(text, open))) return true
  return insideApprovedTag(text, callOffset)
}

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
  let lineStart = 0
  lines.forEach((line, index) => {
    const match = COMMENT_LINE_RE.test(line) ? null : DESTRUCTIVE_CALL_RE.exec(line)
    if (
      match !== null &&
      !enclosedByApproved(
        file.text,
        lineStart + match.index,
        lineStart + match.index + match[0].lastIndexOf('.') + 1,
      )
    )
      out.push(index + 1)
    lineStart += line.length + 1
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
