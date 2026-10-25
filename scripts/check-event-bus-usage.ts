#!/usr/bin/env tsx
/**
 * D11 event-bus guard — fail the build if any file OUTSIDE the kernel's
 * event-bus module hand-rolls a raw cross-process event topic.
 *
 * Cross-process events MUST travel exclusively through `ctx.eventBus`
 * (`getBrokerEventBus` / `createBrokerEventBus`). The files permitted to
 * construct `camstack.evt.*` topic strings or call `broker.broadcast` /
 * `broker.emit` with such a topic are:
 *
 *   packages/kernel/src/moleculer/event-bus.ts
 *     — the event-bus implementation; owns the transport layer.
 *   packages/kernel/src/moleculer/addon-context-factory.ts
 *     — imports and re-exports `EVENT_TOPIC_PREFIX` as part of the
 *       kernel's public API barrel.
 *   packages/kernel/src/index.ts
 *     — kernel public barrel; re-exports the constant.
 *
 * All other files must emit cross-process events via `ctx.eventBus` and
 * must NOT construct topic strings or call `broker.broadcast/emit` directly.
 *
 * Detection rules (line-based scan — simple and robust):
 *
 *   Rule 1 — camstack.evt. literal
 *     Flags any non-comment line that contains the string `camstack.evt.`.
 *     "Comment line" = a line whose trimmed content starts with `//` or `*`
 *     (the `*` catches JSDoc `* text` and block-comment ` * text` lines).
 *     Rationale: inline comments explaining that a module uses this prefix
 *     (e.g. "camstack.evt.<category>") are documentation and don't introduce
 *     a raw topic construction. If a comment would confusingly contain the
 *     literal AND the file is otherwise clean, that is acceptable — we
 *     tolerate doc comments mentioning the prefix.
 *
 *   Rule 2 — EVENT_TOPIC_PREFIX reference
 *     Flags any line that references the exported constant `EVENT_TOPIC_PREFIX`
 *     (e.g. to construct a topic string manually).
 *     Exempt: only the three files above are legitimate re-exporters of the
 *     constant itself.
 *
 *   Rule 3 — raw broker broadcast/emit with camstack.evt topic
 *     Flags any line that contains `.broadcast(` or `.emit(` immediately
 *     followed (within the same line) by a string argument that starts with
 *     `'camstack.evt.` or `"camstack.evt.`.
 *     This catches the most obvious form of hand-rolled cluster emit. The
 *     multi-line form (topic on a separate line) is already caught by Rule 1.
 *
 *   Rule 4 — clusterEventTopic identifier reference
 *     Flags any non-comment line that references the identifier
 *     `clusterEventTopic` outside the three exempt files.
 *     `clusterEventTopic(category)` builds a `camstack.evt.*` topic from a
 *     non-literal argument, bypassing Rules 1–3. Cross-process events MUST
 *     travel through `ctx.eventBus` — never via a hand-built topic regardless
 *     of how the topic string is constructed.
 *
 * Usage: npx tsx scripts/check-event-bus-usage.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')

// ---------------------------------------------------------------------------
// Files that are exempt from ALL checks. These are the ONLY files permitted
// to reference EVENT_TOPIC_PREFIX or construct camstack.evt.* topics:
//
//   1. event-bus.ts — owns the event-bus implementation and transport layer
//   2. addon-context-factory.ts — re-exports EVENT_TOPIC_PREFIX in kernel API
//   3. index.ts — kernel public barrel; re-exports the constant
// ---------------------------------------------------------------------------
const EXEMPT_DIRS: readonly string[] = []
const EXEMPT_FILES: readonly string[] = [
  // Kernel sources moved into @camstack/system (Task A1/A3 refactor)
  path.join(ROOT, 'packages/system/src/kernel/moleculer/event-bus.ts'),
  path.join(ROOT, 'packages/system/src/kernel/moleculer/addon-context-factory.ts'),
  path.join(ROOT, 'packages/system/src/kernel/index.ts'),
]

// ---------------------------------------------------------------------------
// Directories/patterns to skip while walking.
// ---------------------------------------------------------------------------
const SKIP_DIRS = new Set(['dist', 'node_modules', '__tests__', '.git'])

// ---------------------------------------------------------------------------
// Violation record.
// ---------------------------------------------------------------------------
interface Violation {
  readonly file: string
  readonly line: number
  readonly content: string
  readonly reason: string
}

function isExempt(filePath: string): boolean {
  for (const dir of EXEMPT_DIRS) {
    if (filePath.startsWith(dir + path.sep) || filePath.startsWith(dir + '/')) return true
  }
  for (const f of EXEMPT_FILES) {
    if (filePath === f) return true
  }
  return false
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('*')
}

function checkFile(filePath: string): readonly Violation[] {
  const violations: Violation[] = []
  const src = fs.readFileSync(filePath, 'utf-8')
  const lines = src.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    const lineNo = i + 1

    // Rule 1: camstack.evt. literal on a non-comment line.
    if (!isCommentLine(raw) && raw.includes('camstack.evt.')) {
      violations.push({
        file: filePath,
        line: lineNo,
        content: raw.trim(),
        reason: 'contains raw `camstack.evt.` topic prefix — use ctx.eventBus instead (D11)',
      })
    }

    // Rule 2: EVENT_TOPIC_PREFIX reference.
    if (raw.includes('EVENT_TOPIC_PREFIX')) {
      violations.push({
        file: filePath,
        line: lineNo,
        content: raw.trim(),
        reason:
          'references `EVENT_TOPIC_PREFIX` — construct topics only inside packages/system/src/kernel/moleculer/event-bus.ts (D11)',
      })
    }

    // Rule 3: broker.broadcast / broker.emit with a camstack.evt topic string on the same line.
    if (
      (raw.includes('.broadcast(') || raw.includes('.emit(')) &&
      (raw.includes("'camstack.evt.") || raw.includes('"camstack.evt.'))
    ) {
      // Avoid double-reporting if Rule 1 already flagged this line.
      const alreadyFlagged = violations.some((v) => v.file === filePath && v.line === lineNo)
      if (!alreadyFlagged) {
        violations.push({
          file: filePath,
          line: lineNo,
          content: raw.trim(),
          reason:
            'raw broker.broadcast/emit with a `camstack.evt.*` topic — use ctx.eventBus instead (D11)',
        })
      }
    }

    // Rule 4: clusterEventTopic identifier reference on a non-comment line.
    // clusterEventTopic(category) constructs a camstack.evt.* topic from a non-literal
    // argument, bypassing Rules 1–3. Cross-process events must go through ctx.eventBus,
    // never via a hand-built topic — regardless of how the topic string is constructed.
    if (!isCommentLine(raw) && raw.includes('clusterEventTopic')) {
      // Avoid double-reporting if another rule already flagged this line.
      const alreadyFlagged = violations.some((v) => v.file === filePath && v.line === lineNo)
      if (!alreadyFlagged) {
        violations.push({
          file: filePath,
          line: lineNo,
          content: raw.trim(),
          reason:
            'references `clusterEventTopic` — cross-process events must go through ctx.eventBus, never a hand-built topic (D11)',
        })
      }
    }
  }

  return violations
}

function walkTs(dir: string, results: string[] = []): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return results
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walkTs(path.join(dir, entry.name), results)
    } else if (
      entry.isFile() &&
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      !entry.name.endsWith('.spec.ts') &&
      !entry.name.endsWith('.spec.tsx')
    ) {
      results.push(path.join(dir, entry.name))
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const SCAN_ROOTS = [path.join(ROOT, 'packages'), path.join(ROOT, 'server/backend/src')]

const allFiles: string[] = []
for (const scanRoot of SCAN_ROOTS) {
  walkTs(scanRoot, allFiles)
}

const allViolations: Violation[] = []

for (const filePath of allFiles) {
  if (isExempt(filePath)) continue
  const v = checkFile(filePath)
  allViolations.push(...v)
}

if (allViolations.length === 0) {
  // eslint-disable-next-line no-console
  console.log(
    '  \x1b[32m✔\x1b[0m event-bus usage guard passed — no hand-rolled camstack.evt topics found',
  )
  process.exit(0)
}

// eslint-disable-next-line no-console
console.error('\n\x1b[31m✘ event-bus usage violations detected:\x1b[0m')
// eslint-disable-next-line no-console
console.error(
  '  Cross-process events must be emitted through ctx.eventBus (getBrokerEventBus /\n  createBrokerEventBus). Never construct `camstack.evt.*` topics by hand. (D11)\n',
)
for (const v of allViolations) {
  // eslint-disable-next-line no-console
  console.error(`    ${path.relative(ROOT, v.file)}:${v.line}  ${v.reason}`)
  // eslint-disable-next-line no-console
  console.error(`      \x1b[2m${v.content}\x1b[0m`)
}
// eslint-disable-next-line no-console
console.error('')
process.exit(1)
