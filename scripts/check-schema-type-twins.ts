#!/usr/bin/env tsx
/**
 * Twin guard — a hand-written `X` that shares its name with an exported Zod
 * `XSchema` must be DERIVED from the schema (`z.infer`) or PINNED to it
 * (`satisfies` both ways). A third, free-standing declaration is a twin, and a
 * twin is a shape that drifts.
 *
 * ## The failure this catches
 *
 * The house rule is "`z.infer<>` for Zod schemas — never duplicate a shape",
 * and it has been broken quietly for a long time. `BrokerStats` was declared
 * once as an interface in `interfaces/stream-broker.ts` and once as
 * `BrokerStatsSchema` in `capabilities/schemas/streaming-shared.ts`, neither
 * generated from the other. The implementation types against the interface;
 * the cap method validates against the schema. Add a field to the interface
 * only and the code compiles, the value is populated at runtime, and the Zod
 * output parse silently strips it on the way out. Nobody sees a failure —
 * they see a field that is "always undefined on the client". Exactly the rust
 * that kept the Alexa cap surface dark for weeks.
 *
 * ## What counts as fine
 *
 * Two forms, both of which make drift impossible rather than merely unlikely:
 *
 *   - DERIVED: `export type X = z.infer<typeof XSchema>` — one shape.
 *   - PINNED:  the bidirectional `satisfies` pair
 *
 *         type XInferred = z.infer<typeof XSchema>
 *         const _a = {} as XInferred satisfies X
 *         const _b = {} as X satisfies XInferred
 *
 *     Two declarations, but neither can change without the other: the pair
 *     fails to compile on any field drift. `FrameHandle` uses this because the
 *     interface predates and outranks the wire schema.
 *
 *   - RE-TIGHTENED: `export type X = Omit<z.infer<typeof XSchema>, 'k'> & { k: T }`
 *     — derived, with a passthrough field (`z.unknown()`, a `ConfigUISchema`
 *     tree) given its real type. Accepted only when the `& { … }` names EXACTLY
 *     the omitted keys: a key there that the schema does not carry is a field
 *     the wire strips, which is the twin again.
 *
 * Prefer DERIVED. PINNED exists for the cases where an interface carries
 * something a Zod schema cannot (call signatures, `Buffer`).
 *
 * ## The ratchet
 *
 * {@link KNOWN_TWINS} pins the unpinned twins that existed when this guard was
 * written. It may only SHRINK: a name in the list that no longer twins is
 * reported so the entry gets deleted, and a twin NOT in the list fails. The
 * list is the inventory of shapes that can still silently disagree — every
 * removal is one wire contract that stopped being able to lie.
 *
 * Usage: tsx scripts/check-schema-type-twins.ts
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SCAN_DIR = path.join(ROOT, 'packages/types/src')
const SKIP_DIRS: ReadonlySet<string> = new Set(['generated', '__tests__', 'node_modules', 'dist'])

/**
 * Unpinned twins present on 2026-08-08, when the guard was added. THIS LIST
 * MAY ONLY SHRINK — fix one by collapsing it to `z.infer` (or adding the
 * `satisfies` pin) and delete its entry in the same commit.
 *
 * `BrokerStats` and `BrokerStatus` were the first two removed, which is what
 * produced this guard.
 */
const KNOWN_TWINS: ReadonlySet<string> = new Set([
  'AudioChunkInput',
  'BoundingBox',
  'CameraMetrics',
  'DecodedAudioChunk',
  'DeviceCapDisplayOverride',
  'DeviceDisplayOverride',
  'DeviceMeta',
  'DiscoveredChildDevice',
  'FrameFormat',
  'FrameInput',
  'OrchestratorMetrics',
  'RoleDisplayDefault',
  'SpatialDetection',
  'StreamSource',
  'StreamSourceEntry',
  'TestResult',
])

interface Declaration {
  readonly name: string
  readonly file: string
}

const RETIGHTENED =
  /export type (\w+)\s*=\s*Omit<\s*z\.infer<typeof (\w+)Schema>\s*,\s*([^>]+?)\s*>\s*&\s*\{([^}]*)\}/g

function omittedKeys(union: string): ReadonlySet<string> | null {
  const keys = union.split('|').map((k) => k.trim())
  const out = new Set<string>()
  for (const k of keys) {
    const m = /^'(\w+)'$/.exec(k)
    if (m?.[1] === undefined) return null
    out.add(m[1])
  }
  return out
}

function objectKeys(body: string): ReadonlySet<string> | null {
  const out = new Set<string>()
  for (const raw of body.split(/[\n;,]/)) {
    const line = raw.replace(/\/\/.*$/, '').trim()
    if (line === '') continue
    const m = /^(?:readonly\s+)?(\w+)\??\s*:/.exec(line)
    if (m?.[1] === undefined) return null
    out.add(m[1])
  }
  return out
}

/**
 * Names declared in `source` as a RE-TIGHTENED derivation of their own schema:
 * `Omit<z.infer<typeof XSchema>, K> & { …exactly K… }`. Every other field comes
 * from the schema, and the override can only re-type a field the schema has.
 */
export function retightenedDerivations(source: string): ReadonlySet<string> {
  const out = new Set<string>()
  for (const m of source.matchAll(RETIGHTENED)) {
    const [, name, schemaBase, union, body] = m
    if (name === undefined || name !== schemaBase || union === undefined || body === undefined)
      continue
    const omitted = omittedKeys(union)
    const overridden = objectKeys(body)
    if (omitted === null || overridden === null || omitted.size === 0) continue
    if (omitted.size !== overridden.size) continue
    if ([...omitted].every((k) => overridden.has(k))) out.add(name)
  }
  return out
}

function sourceFiles(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      sourceFiles(full, out)
      continue
    }
    if (entry.name.endsWith('.ts')) out.push(full)
  }
}

function main(): void {
  const files: string[] = []
  sourceFiles(SCAN_DIR, files)
  if (files.length === 0) {
    console.error('\x1b[31m✘ no sources found — check SCAN_DIR\x1b[0m')
    process.exit(1)
  }

  /** base name (`BrokerStats`) → file declaring `BrokerStatsSchema`. */
  const schemas = new Map<string, string>()
  /** base name → the hand-written `interface X` / `type X = <not z.infer>`. */
  const handWritten = new Map<string, Declaration>()
  /** base names declared as `type X = z.infer<…>` — derived, never a twin. */
  const derived = new Set<string>()
  /** whole corpus, for the `satisfies`-pin lookup. */
  const corpus: string[] = []

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf-8')
    corpus.push(source)
    for (const m of source.matchAll(/export const (\w+)Schema\s*[:=]/g)) {
      const base = m[1]
      if (base !== undefined && !schemas.has(base)) schemas.set(base, file)
    }
    for (const m of source.matchAll(/export type (\w+)\s*=\s*z\.infer/g)) {
      if (m[1] !== undefined) derived.add(m[1])
    }
    for (const name of retightenedDerivations(source)) derived.add(name)
    for (const m of source.matchAll(/export interface (\w+)[\s<]/g)) {
      const name = m[1]
      if (name !== undefined && !handWritten.has(name)) handWritten.set(name, { name, file })
    }
    for (const m of source.matchAll(/export type (\w+)\s*=\s*(?!z\.infer)/g)) {
      const name = m[1]
      if (name !== undefined && !handWritten.has(name)) handWritten.set(name, { name, file })
    }
  }

  /**
   * The bidirectional pin: BOTH `as <Inferred> satisfies X` and
   * `as X satisfies <Inferred>` must exist somewhere. Matching on `X` in each
   * position is what makes it bidirectional — a single one-way `satisfies`
   * catches a missing field in only one direction.
   */
  function isPinned(name: string): boolean {
    const forward = new RegExp(`satisfies\\s+${name}\\b`)
    const backward = new RegExp(`as\\s+${name}\\s+satisfies\\b`)
    return corpus.some((s) => forward.test(s)) && corpus.some((s) => backward.test(s))
  }

  const twins: Declaration[] = []
  for (const [base] of schemas) {
    if (derived.has(base)) continue
    const decl = handWritten.get(base)
    if (decl === undefined) continue
    if (isPinned(base)) continue
    twins.push(decl)
  }

  const newTwins = twins.filter((t) => !KNOWN_TWINS.has(t.name))
  const fixed = [...KNOWN_TWINS].filter((n) => !twins.some((t) => t.name === n))

  if (newTwins.length > 0) {
    console.error(`\x1b[31m✘ ${newTwins.length} new schema/type twin(s)\x1b[0m:`)
    for (const t of newTwins) {
      console.error(
        `    \`${t.name}\` in ${path.relative(ROOT, t.file)} duplicates \`${t.name}Schema\` in ` +
          `${path.relative(ROOT, schemas.get(t.name) ?? '?')}. ` +
          `Make it \`export type ${t.name} = z.infer<typeof ${t.name}Schema>\`, or pin the two ` +
          `with the bidirectional \`satisfies\` pair (see FrameHandle in ` +
          `packages/types/src/capabilities/schemas/streaming-shared.ts). ` +
          `A second shape does not fail — it strips fields on the wire.`,
      )
    }
    process.exit(1)
  }

  if (fixed.length > 0) {
    console.error(
      `\x1b[31m✘ KNOWN_TWINS lists ${fixed.length} name(s) that are no longer twins\x1b[0m: ` +
        `${fixed.join(', ')}. Delete them from KNOWN_TWINS in scripts/check-schema-type-twins.ts — ` +
        `the list is a ratchet and must reflect what is actually left.`,
    )
    process.exit(1)
  }

  console.log(
    `  ✔ no new schema/type twins (${twins.length} pinned in KNOWN_TWINS, ratcheting down)`,
  )
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main()
