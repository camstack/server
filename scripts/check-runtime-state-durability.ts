#!/usr/bin/env tsx
/**
 * Runtime-state durability guard — a value reaches disk only because its own
 * capability asked for it, in a diff someone reviewed.
 *
 * ── The bug class this prevents ────────────────────────────────────────────
 * `device-runtime-state` persists a slice for EVERY cap that declares
 * `runtimeState`. That whitelist-by-construction sounds safe and is not: it
 * means adding one field to one cap can silently add a SQLite commit per
 * second per camera to the hub's busiest write path. Measured on the live hub
 * on 2026-08-13, with 62 caps declaring a slice:
 *
 *   - offered write rate                  12–19/s = 1.0–1.6 M/day
 *   - bytes rewritten to maintain 161 KB  ~2.6–5 GB/day  (≈20,000× amplification)
 *   - share from just TWO of the 62 caps  ~90 %  (`audio-metrics`, `zone-analytics`)
 *
 * Neither of those two ever needed to be persisted. Nobody chose to persist
 * them either — they inherited it by declaring a shape. On a database that
 * lives on a FUSE share and whose checkpoint has been measured stalling
 * hub-main for 25 s (D96), that is not a default anyone should get for free.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 * 1. A cap declaring `runtimeState` MUST declare `durability`.
 * 2. A `durability: 'restored'` cap whose runtime-state schema carries a field
 *    from {@link CLOCK_FIELD_NAMES} MUST either list it in
 *    `volatileStateFields` or state, in that array's absence, that it is not a
 *    clock — by naming the field in {@link CLOCK_FIELD_EXEMPTIONS} here, with
 *    the reason.
 *
 * Rule 2 is the one that pays. Half of every non-hot runtime-state write on
 * this installation is a clock advancing under an unchanged value: `battery`
 * 526 writes / 0 value changes in 25 minutes, `privacy-mask` 22/22,
 * `humidity-sensor` 67/75, `temperature-sensor` 69/125, `numeric-sensor`
 * 251/669. The kernel holds no list of clock names — the cap declares them.
 * This guard holds the list only to ask the question.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAllCaps } from './lib/parse-cap.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CAPS_DIR = path.join(ROOT, 'packages/types/src/capabilities')

/**
 * Field names that are a clock unless the cap says otherwise. Used ONLY to
 * decide whether to ask the question — never to answer it.
 */
const CLOCK_FIELD_NAMES: readonly string[] = [
  'lastFetchedAt',
  'lastUpdated',
  'lastChangedAt',
  'lastProbedAt',
  'lastSeenAt',
  'lastContactAt',
  'updatedAt',
  'ts',
  'timestamp',
]

/**
 * `<cap>.<field>` pairs that LOOK like a clock and are content. Each needs a
 * reason, because each is a value whose movement legitimately costs a commit.
 */
const CLOCK_FIELD_EXEMPTIONS: Readonly<Record<string, string>> = {
  'doorbell.lastPressedAt':
    'the doorbell slice IS the record of the press — nothing else holds it, so the timestamp is the payload (D96 named this one of the two genuinely durable slices).',
  'battery.lastContactAt':
    'the observation itself, not a stamp on one: it is the ONLY signal separating "this battery camera is asleep" from "this battery camera is gone", and a 30-hour silence is visible in nothing else (D173). Excluding it from the compare would mean the fact that decides a fault badge is the one fact never committed. Writers quantise it to 5 minutes, so the commit rate it can cost is bounded at 12/hour/device — and only for a device that is actually being reached.',
}

interface Violation {
  readonly capName: string
  readonly message: string
}

/**
 * Top-level field names of a cap's runtime-state schema.
 *
 * Two shapes in the wild, and the guard must see both — the first version of
 * this function only handled the inline one and quietly passed every cap whose
 * schema is a named const, which is most of the sensor caps and every one of
 * the `lastChangedAt` carriers:
 *
 *     runtimeState: z.object({ ... })         // inline
 *     runtimeState: BatteryStatusSchema,      // named const in the same file
 */
function runtimeStateFieldNames(src: string): readonly string[] {
  const decl = src.match(/^\s*runtimeState\s*:\s*(.+)$/m)
  if (!decl) return []
  const expr = decl[1]!.trim()

  if (expr.startsWith('z.object(')) {
    return objectLiteralKeys(src, src.indexOf('z.object(', decl.index ?? 0))
  }
  const identMatch = expr.match(/^([A-Za-z_$][\w$]*)/)
  if (!identMatch) return []
  const constDecl = new RegExp(
    `(?:const|let)\\s+${identMatch[1]!}\\s*(?::[^=]+)?=\\s*z\\.object\\(`,
  ).exec(src)
  if (!constDecl) return []
  return objectLiteralKeys(src, constDecl.index + constDecl[0].length - 'z.object('.length)
}

/**
 * Keys of the object literal opened by the first `{` at or after `from`, at
 * nesting depth 1 only — a nested `z.object({ ts: … })` is a field OF a field,
 * and the compare treats a nested value as content in one piece.
 */
function objectLiteralKeys(src: string, from: number): readonly string[] {
  const open = src.indexOf('{', from)
  if (open < 0) return []
  const names: string[] = []
  let depth = 0
  let current = ''
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i]!
    if (ch === '{' || ch === '(' || ch === '[') {
      depth += 1
      current = ''
      continue
    }
    if (ch === '}' || ch === ')' || ch === ']') {
      depth -= 1
      current = ''
      if (depth === 0) break
      continue
    }
    if (depth !== 1) continue
    if (ch === ':') {
      const key = current.trim()
      if (/^[A-Za-z_$][\w$]*$/.test(key)) names.push(key)
      current = ''
      continue
    }
    if (ch === ',' || ch === '\n') {
      current = ''
      continue
    }
    current += ch
  }
  return names
}

function main(): void {
  const caps = parseAllCaps(CAPS_DIR).filter((c) => c.hasRuntimeState)
  const violations: Violation[] = []

  for (const cap of caps) {
    if (cap.durability === null) {
      violations.push({
        capName: cap.capName,
        message:
          `declares \`runtimeState\` but no \`durability\`.\n` +
          `      Add \`durability: 'session'\` (mirrored in RAM, never written) or\n` +
          `      \`durability: 'restored'\` (persisted, and seeded back at boot) to\n` +
          `      packages/types/src/capabilities/${cap.fileName.replace('.js', '.ts')},\n` +
          `      then run \`npm run codegen\`.`,
      })
      continue
    }
    if (cap.durability !== 'restored') continue

    const src = readCapSource(cap.fileName)
    const declared = new Set(cap.volatileStateFields)
    for (const field of runtimeStateFieldNames(src)) {
      if (!CLOCK_FIELD_NAMES.includes(field)) continue
      if (declared.has(field)) continue
      if (CLOCK_FIELD_EXEMPTIONS[`${cap.capName}.${field}`] !== undefined) continue
      violations.push({
        capName: cap.capName,
        message:
          `is \`restored\` and carries \`${field}\`, which is not in \`volatileStateFields\`.\n` +
          `      Either add it there (persisted, but not on its own worth a commit —\n` +
          `      this is where ~50 % of the cold-half write rate lives), or add\n` +
          `      '${cap.capName}.${field}' to CLOCK_FIELD_EXEMPTIONS in this guard\n` +
          `      with the reason it is content.`,
      })
    }
  }

  if (violations.length === 0) {
    // eslint-disable-next-line no-console
    console.log(`✔ runtime-state durability: ${caps.length} caps, all declared`)
    return
  }

  // eslint-disable-next-line no-console
  console.error(`\n\x1b[31m✘ runtime-state durability guard failed\x1b[0m`)
  for (const v of violations) {
    // eslint-disable-next-line no-console
    console.error(`    - ${v.capName} ${v.message}`)
  }
  // eslint-disable-next-line no-console
  console.error('')
  process.exit(1)
}

function readCapSource(fileName: string): string {
  // `parseAllCaps` rewrites `.ts` → `.js` for ESM import specifiers.
  return fs.readFileSync(path.join(CAPS_DIR, fileName.replace(/\.js$/, '.ts')), 'utf8')
}

main()
