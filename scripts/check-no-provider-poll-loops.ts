#!/usr/bin/env tsx
/**
 * A provider migrated to the core state refresh (D1062) owns no poll timer.
 *
 * The hub's state-refresh scheduler decides WHEN a device is re-read: its
 * cadence (the declared minimum, slowed only by the integration's setting),
 * the read a command awaits, the burst until the command is confirmed, and
 * the push heartbeat. A provider that keeps its own `setInterval` (or a
 * `setTimeout` that re-arms itself, or a `pollTimer` / `pollLoop`) reads on a
 * second clock the core cannot see — the overlap, cadence and burst rules no
 * longer hold, and the cloud is read twice.
 *
 * Scope: the runtime source (`src/`, excluding specs, `__tests__` and
 * generated code) of every provider in {@link MIGRATED}. A provider joins the
 * list when it moves to `device-state-refresh`. Comment-only lines are skipped
 * (prose may name the old loop), and so are lines marked `not-a-state-poll`. Textual: a timer reached through an alias
 * passes — the list is the contract, review is the rest.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** The providers whose device-state timing the core owns (D1062). */
export const MIGRATED: readonly string[] = [
  'packages/addon-provider-vesync',
  'packages/addon-provider-enpal',
  'packages/addon-provider-rademacher',
  'packages/addon-provider-unifi',
  'packages/addon-provider-gree',
  'packages/addon-provider-unraid',
]

const LOOP = /\bset(?:Interval|Timeout)\s*\(|\bpoll(?:Timer|Loop)\b|#?startPollLoop\b/

/**
 * A timer that is not a state poll (a connection heartbeat, a request deadline, a
 * debounce) says so on its own line or the line below: `// not-a-state-poll: <why>`. The reason is
 * required; the marker without one does not exempt.
 */
const EXEMPT = /\/\/\s*not-a-state-poll:\s*\S/

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
    if (statSync(full).isDirectory()) walk(full, out)
    else if (SOURCE_RE.test(name) && !NON_RUNTIME_RE.test(name)) out.push(full)
  }
}

function isCommentLine(text: string): boolean {
  const t = text.trimStart()
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')
}

export interface PollLoopFinding {
  readonly file: string
  readonly line: number
  readonly text: string
}

export function findProviderPollLoops(
  files: readonly { readonly rel: string; readonly content: string }[],
): PollLoopFinding[] {
  const findings: PollLoopFinding[] = []
  for (const { rel, content } of files) {
    const lines = content.split('\n')
    for (const [i, text] of lines.entries()) {
      if (isCommentLine(text)) continue
      // The formatter may move a trailing comment onto the next line, so the marker counts there too.
      if (EXEMPT.test(text) || EXEMPT.test(lines[i + 1] ?? '')) continue
      if (LOOP.test(text)) findings.push({ file: rel, line: i + 1, text: text.trim() })
    }
  }
  return findings
}

function main(): void {
  const paths: string[] = []
  for (const pkg of MIGRATED) walk(path.join(ROOT, pkg, 'src'), paths)
  const files = paths.map((p) => ({
    rel: path.relative(ROOT, p).split(path.sep).join('/'),
    content: readFileSync(p, 'utf-8'),
  }))
  const findings = findProviderPollLoops(files)
  if (findings.length === 0) {
    console.log(
      `check-no-provider-poll-loops: ${files.length} files in ${MIGRATED.length} migrated provider(s), no poll timer`,
    )
    return
  }
  console.error(
    'check-no-provider-poll-loops: a provider migrated to device-state-refresh owns no timer — ' +
      'the core scheduler decides when it reads (D1062):',
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
