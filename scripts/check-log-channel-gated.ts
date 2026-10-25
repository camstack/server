#!/usr/bin/env tsx
/**
 * Log-channel gating guard (D62) — every channel an addon DECLARES must be
 * CONSULTED by a real gate, or be listed as a dated, reasoned exception.
 *
 * ## The failure this closes
 *
 * A declared channel that no code reads is a knob an operator turns with
 * nothing happening. Forever. Without a line. Nothing fails, nothing warns,
 * and the only symptom is a person concluding the wrong thing about a camera
 * because the diagnostic they armed produced silence.
 *
 * This repo has shipped that exact shape three times in two days:
 *
 *  - `audioThresholdDbfs` — authorized by the UI, read by every pure decision
 *    function in `band-decision.ts`, and fed by NOBODY. A band listening only
 *    to audio recorded not one frame, forever, with no log line;
 *  - the Home Assistant entities exported with no source behind them;
 *  - the second per-camera switch that wrote a settings row nobody read (D62).
 *
 * `check-recording-trigger-fed.ts` was written for the first and works. This
 * is the same guard for the same defect in the logging mechanism, before the
 * mechanism grows a fourth instance of it.
 *
 * ## What it checks
 *
 * Over `packages/<pkg>/src/**` and `server/backend/src/**` (production only —
 * `__tests__`, `dist` and `node_modules` are excluded), with comments stripped
 * first so a docblock example cannot fake a gate:
 *
 *  1. **Every declared channel has a binding.** A `declareLogChannel({ … })`
 *     call must be assigned to an exported `const`. An anonymous declaration
 *     cannot be consulted by name and is refused.
 *  2. **Names are unique cluster-wide.** Two addons declaring one name is a
 *     collision the operator experiences as "I armed it and only half the
 *     lines appeared". `LogChannelRegistry.declare` throws on a duplicate
 *     within a process; this catches it ACROSS processes, which the runtime
 *     cannot.
 *  3. **Every channel is consulted.** Somewhere in production source there is
 *     a `<BINDING>.on` read outside the declaring statement. That is the gate:
 *     the plain boolean field the hot path branches on.
 *  4. **The call shape holds.** Every `<BINDING>.wants(` and `<BINDING>.log(`
 *     is preceded, within the same statement neighbourhood, by `<BINDING>.on`.
 *     Without the `.on &&` prefix a disarmed channel would pay a method call
 *     and a `Set.has` on every line the process emits — the cost regression
 *     this whole design exists to avoid, and one that no test would notice.
 *
 * An exception must appear in `UNGATED_LOG_CHANNELS` with a date and a reason.
 * That set can only ever shrink: it is the record of a knob knowingly shipped
 * dark, not a place to park new ones.
 *
 * ## Why a text scan and not a type-level check
 *
 * The type system proves `CH_RTP` is a `LogChannelGate`. It cannot prove any
 * branch reads it — which is precisely the gap `audioThresholdDbfs` walked
 * through, where the types were perfect and the runtime feed was missing. A
 * call site is present or absent: no judgement, no false positives, and a
 * guard with false positives gets deleted.
 *
 * Usage: npx tsx scripts/check-log-channel-gated.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')

const SCAN_ROOTS: readonly string[] = ['packages', 'server/backend/src']

/**
 * Channels knowingly shipped without a gate. Dated, reasoned, and only ever
 * shrinking.
 *
 * Empty on purpose as of 2026-08-27: every declared channel is consulted. An
 * entry here is a promise to somebody, so it carries the date it was made.
 */
const UNGATED_LOG_CHANNELS: ReadonlyMap<string, string> = new Map<string, string>([])

/** How far back a `.wants(`/`.log(` call may look for its `.on &&` prefix. */
const CALL_SHAPE_LOOKBACK = 400

interface Declaration {
  readonly channel: string
  readonly binding: string
  readonly file: string
}

interface Failure {
  readonly channel: string
  readonly reason: string
}

function sourceFiles(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') {
      continue
    }
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      sourceFiles(full, out)
      continue
    }
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full)
  }
}

/** Comments removed so a docblock cannot stand in for a gate or a declaration. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

/**
 * `export const CH_X = declareLogChannel({ … name: 'a.b' … })`
 *
 * The binding is captured from the assignment and the name from the object
 * literal, so the guard learns the pair the same way a reader does.
 */
const DECLARATION_RE =
  /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*declareLogChannel\(\s*\{([^}]*)\}/g

/** An anonymous `declareLogChannel({ … })` — no binding to consult. */
const ANONYMOUS_RE = /declareLogChannel\(\s*\{([^}]*)\}/g

function nameOf(objectLiteral: string): string | null {
  return /name:\s*['"]([^'"]+)['"]/.exec(objectLiteral)?.[1] ?? null
}

function collect(files: readonly string[]): {
  readonly declarations: readonly Declaration[]
  readonly anonymous: readonly string[]
  readonly corpus: string
} {
  const declarations: Declaration[] = []
  const anonymous: string[] = []
  const parts: string[] = []
  for (const file of files) {
    const src = stripComments(fs.readFileSync(file, 'utf8'))
    parts.push(src)
    const bound = new Set<string>()
    for (const match of src.matchAll(DECLARATION_RE)) {
      const binding = match[1]
      const channel = nameOf(match[2] ?? '')
      if (binding === undefined || channel === null) continue
      bound.add(channel)
      declarations.push({ channel, binding, file: path.relative(ROOT, file) })
    }
    for (const match of src.matchAll(ANONYMOUS_RE)) {
      const channel = nameOf(match[1] ?? '')
      if (channel !== null && !bound.has(channel)) anonymous.push(channel)
    }
  }
  return { declarations, anonymous, corpus: parts.join('\n') }
}

/** A `<binding>.on` read that is not the declaration's own assignment. */
function hasGateRead(corpus: string, binding: string): boolean {
  return new RegExp(`\\b${binding}\\.on\\b`).test(corpus)
}

/**
 * Every `<binding>.wants(` / `<binding>.log(` sits behind a `<binding>.on`.
 *
 * Returns the offending snippets so the message points at something real
 * rather than saying "somewhere".
 */
function unguardedCalls(corpus: string, binding: string): readonly string[] {
  const bad: string[] = []
  const calls = new RegExp(`\\b${binding}\\.(wants|log)\\s*\\(`, 'g')
  const guard = new RegExp(`\\b${binding}\\.on\\b`)
  for (const match of corpus.matchAll(calls)) {
    const at = match.index ?? 0
    const before = corpus.slice(Math.max(0, at - CALL_SHAPE_LOOKBACK), at)
    if (!guard.test(before)) {
      bad.push(
        corpus
          .slice(at, at + 60)
          .replace(/\s+/g, ' ')
          .trim(),
      )
    }
  }
  return bad
}

function main(): void {
  const files: string[] = []
  for (const root of SCAN_ROOTS) sourceFiles(path.join(ROOT, root), files)
  if (files.length === 0) {
    console.error(
      '\x1b[31m✘ no source files found — SCAN_ROOTS has moved, fix this guard rather than deleting it\x1b[0m',
    )
    process.exit(1)
  }

  const { declarations, anonymous, corpus } = collect(files)
  const failures: Failure[] = []

  for (const channel of anonymous) {
    failures.push({
      channel,
      reason:
        'declared without being assigned to a const — an anonymous channel cannot be ' +
        'consulted by name, so nothing can ever gate on it',
    })
  }

  const seen = new Map<string, Declaration>()
  for (const declaration of declarations) {
    const previous = seen.get(declaration.channel)
    if (previous !== undefined) {
      failures.push({
        channel: declaration.channel,
        reason:
          `declared twice — ${previous.file} and ${declaration.file}. One name must mean ` +
          'one gate: an operator arming a duplicated name lights one of them and sees ' +
          'half the lines they asked for',
      })
      continue
    }
    seen.set(declaration.channel, declaration)
  }

  for (const [channel, declaration] of seen) {
    if (UNGATED_LOG_CHANNELS.has(channel)) continue
    if (!hasGateRead(corpus, declaration.binding)) {
      failures.push({
        channel,
        reason:
          `declared in ${declaration.file} as \`${declaration.binding}\`, but no production ` +
          `code anywhere reads \`${declaration.binding}.on\` — arming it would do nothing, ` +
          'forever, with no log line. Write the gate, or list the channel in ' +
          'UNGATED_LOG_CHANNELS with a date and a reason',
      })
      continue
    }
    const unguarded = unguardedCalls(corpus, declaration.binding)
    if (unguarded.length > 0) {
      failures.push({
        channel,
        reason:
          `called without the \`${declaration.binding}.on &&\` prefix: ${unguarded.join(' | ')}. ` +
          'Without it a DISARMED channel pays a method call (and a Set lookup) on every ' +
          'line this process emits — the cost regression no test would ever notice',
      })
    }
  }

  const stale = [...UNGATED_LOG_CHANNELS.keys()].filter((channel) => !seen.has(channel))
  for (const channel of stale) {
    failures.push({
      channel,
      reason:
        'listed in UNGATED_LOG_CHANNELS but no longer declared anywhere — remove the ' +
        'exception. A stale exception reads as verification and silently widens the guard',
    })
  }

  if (failures.length === 0) {
    console.log(
      `\x1b[32m  ✔ every declared log channel is gated (${seen.size} channel(s), ` +
        `${UNGATED_LOG_CHANNELS.size} declared exception(s))\x1b[0m`,
    )
    return
  }

  console.error(`\x1b[31m✘ ${failures.length} log channel problem(s)\x1b[0m:`)
  for (const failure of failures) {
    console.error(`    ${failure.channel}: ${failure.reason}`)
  }
  console.error('    → a declared channel nobody consults is a dead knob: the operator arms it,')
  console.error('      nothing happens, and no line says why. This is D62 — audioThresholdDbfs,')
  console.error('      the HA entities with no source, the switch that wrote a store nobody read.')
  process.exit(1)
}

main()
