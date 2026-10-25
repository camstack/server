#!/usr/bin/env tsx
/**
 * Codegen: emit `CAP_INPUT_DEFAULTS` — for every capability method whose input
 * object declares top-level `.default(…)` fields, the plain JSON values those
 * defaults produce.
 *
 * WHY THIS EXISTS: a Zod `.default()` only runs where the schema is PARSED —
 * the tRPC router. A cap call made from an addon through `ctx.api` never
 * reaches that router, so every declared default silently arrives `undefined`.
 * That produced three separate production failures in a single afternoon
 * (2026-07-30):
 *   - `notification-output.send` → `format` undefined → the degrade engine
 *     threw `DEGRADE_ORDER[source] is not iterable` and dead-lettered every
 *     Notification-Center delivery;
 *   - the same path's `bodyMaxLen` → `i += undefined` → an EMPTY body;
 *   - `recording.renderGif` → `preRollSec`/`postRollSec` undefined →
 *     `aroundMs - undefined * 1000` = NaN → every gif attachment lost, behind a
 *     message that read like a legitimate "this camera has no footage".
 *
 * WHY A GENERATED MAP AND NOT A ZOD PARSE: importing the schema barrel into a
 * forked runner costs ~144MB RSS per runner (D28 — the same constraint that
 * produced `collection-array-methods.ts`). This carries the ANSWER as plain
 * data, computed at codegen time by running the REAL schemas, so a runner
 * imports a few KB and zero Zod.
 *
 * SCOPE: TOP-LEVEL defaults of an object input. A default nested inside a
 * sub-object is NOT collected — it would need a recursive merge at the call
 * site, and no production caller has needed one. The three failures above are
 * all top-level. A nested default remains what it always was: a value only the
 * router path materialises.
 *
 * Authoritative: values come from parsing `{}` with the real input schema, so
 * the map cannot drift from the cap definitions.
 *
 * Output: `packages/types/src/generated/cap-input-defaults.ts`
 *
 * Run manually: npx tsx scripts/generate-cap-input-defaults.ts
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expandCapMethods } from '../packages/types/src/capabilities/capability-definition.ts'
import { ALL_CAPABILITY_DEFINITIONS } from '../packages/types/src/generated/capability-router-map.ts'
import { writeIfChanged } from './codegen-write.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OUTPUT = path.join(ROOT, 'packages/types/src/generated/cap-input-defaults.ts')

/** The Zod internals this walker needs — no zod types imported. */
interface ZodDefLike {
  readonly type?: string
  readonly typeName?: string
  readonly defaultValue?: unknown
}
interface ZodFieldLike {
  readonly def?: ZodDefLike
  readonly _def?: ZodDefLike
}
interface ZodObjectLike {
  readonly shape?: Record<string, unknown>
}

function defOf(field: unknown): ZodDefLike | null {
  if (typeof field !== 'object' || field === null) return null
  const f = field as ZodFieldLike
  return f.def ?? f._def ?? null
}

/**
 * The TOP-LEVEL `.default(…)` values of an object input, read FIELD BY FIELD.
 *
 * Deliberately not `safeParse({})`: any required field makes the empty object
 * invalid, which would have silently skipped exactly the methods that matter
 * (`recording.renderGif` requires `deviceId`/`aroundMs` AND defaults four
 * fields — the very method whose missing defaults produced the NaN window).
 */
function defaultsFor(input: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > MAX_NESTING) return null
  if (typeof input !== 'object' || input === null) return null
  const shape = (input as ZodObjectLike).shape
  if (typeof shape !== 'object' || shape === null) return null
  const out: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(shape)) {
    const def = defOf(field)
    if (def === null) continue
    if ((def.type ?? def.typeName) === 'default') {
      let value: unknown
      try {
        value =
          typeof def.defaultValue === 'function'
            ? (def.defaultValue as () => unknown)()
            : def.defaultValue
      } catch {
        continue
      }
      if (value === undefined) continue
      // Only JSON-representable defaults travel — a function, Date or class
      // instance would not survive the wire anyway.
      if (!isJsonValue(value)) continue
      out[key] = value
      continue
    }
    // NESTED object: `notification-output.send` takes `{ notification }`, and
    // the `format` default that threw for a day lives INSIDE it. Descending one
    // level is what makes this map cover the failure it was written for.
    const nested = defaultsFor(field, depth + 1)
    if (nested !== null) out[key] = { [NESTED_MARKER]: nested }
  }
  return Object.keys(out).length > 0 ? out : null
}

/** How deep the walker descends into nested object inputs. */
const MAX_NESTING = 2
/** Marks a nested default group so the merge helper recurses instead of
 *  replacing the caller's sub-object wholesale. */
const NESTED_MARKER = '__nested__'

function isJsonValue(value: unknown): boolean {
  if (value === null) return true
  const t = typeof value
  if (t === 'string' || t === 'boolean') return true
  if (t === 'number') return Number.isFinite(value as number)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (t === 'object') {
    return Object.values(value as Record<string, unknown>).every(isJsonValue)
  }
  return false
}

async function main(): Promise<void> {
  const caps: Array<{ cap: string; methods: Array<{ name: string; defaults: string }> }> = []
  let totalMethods = 0

  for (const def of ALL_CAPABILITY_DEFINITIONS) {
    const methods: Array<{ name: string; defaults: string }> = []
    for (const [name, schema] of Object.entries(expandCapMethods(def))) {
      const defaults = defaultsFor((schema as { input?: unknown }).input)
      if (defaults === null) continue
      methods.push({ name, defaults: JSON.stringify(defaults) })
    }
    if (methods.length === 0) continue
    methods.sort((a, b) => a.name.localeCompare(b.name))
    totalMethods += methods.length
    caps.push({ cap: def.name, methods })
  }
  caps.sort((a, b) => a.cap.localeCompare(b.cap))

  const entries = caps
    .map(
      (c) =>
        `  ${JSON.stringify(c.cap)}: {\n` +
        c.methods.map((m) => `    ${JSON.stringify(m.name)}: ${m.defaults},`).join('\n') +
        `\n  },`,
    )
    .join('\n')

  const banner = `/**
 * AUTO-GENERATED by scripts/generate-cap-input-defaults.ts — DO NOT EDIT.
 *
 * capName → method → the TOP-LEVEL input defaults the method's Zod schema
 * would materialise. A cap call made from an addon (\`ctx.api\`) never passes
 * through the tRPC router, so those \`.default(…)\` values never run — three
 * production failures in one day came from exactly that (see the generator's
 * header). The addon link merges these in, so a declared default means the same
 * thing on both paths.
 *
 * Plain data, zero Zod: a forked runner must not import the schema barrel
 * (~144MB RSS per runner — D28).
 *
 * Coverage: ${caps.length} caps, ${totalMethods} methods with defaults.
 */
`

  const body = `export const CAP_INPUT_DEFAULTS: Readonly<
  Record<string, Readonly<Record<string, Readonly<Record<string, unknown>>>>>
> = Object.freeze({
${entries}
} as const)

/**
 * Fill the declared defaults for \`(capName, method)\` into \`input\`, WITHOUT
 * touching anything the caller set.
 *
 * Deliberately additive-only:
 *  - a caller-provided value always wins (including \`null\`; only \`undefined\`
 *    is treated as absent);
 *  - unknown keys survive untouched — the addon path carries routing fields
 *    (\`nodeId\`, \`addonId\`) inline in the args, and a Zod parse would strip
 *    them and silently break routing;
 *  - a non-object input is returned as-is.
 */
export function withCapInputDefaults(capName: string, method: string, input: unknown): unknown {
  const defaults = CAP_INPUT_DEFAULTS[capName]?.[method]
  if (defaults === undefined) return input
  return mergeDefaults(defaults, input)
}

/** Marks a nested default group (see the generator). */
const NESTED_MARKER = '__nested__'

function isNestedGroup(value: unknown): value is Record<string, Record<string, unknown>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    NESTED_MARKER in (value as Record<string, unknown>)
  )
}

function mergeDefaults(defaults: Readonly<Record<string, unknown>>, input: unknown): unknown {
  if (input === undefined || input === null) return materialise(defaults)
  if (typeof input !== 'object' || Array.isArray(input)) return input
  const given = input as Record<string, unknown>
  let out: Record<string, unknown> | null = null
  for (const [key, value] of Object.entries(defaults)) {
    if (isNestedGroup(value)) {
      const nested = value[NESTED_MARKER]
      if (nested === undefined) continue
      const merged = mergeDefaults(nested, given[key])
      if (merged === given[key]) continue
      out ??= { ...given }
      out[key] = merged
      continue
    }
    if (given[key] !== undefined) continue
    out ??= { ...given }
    out[key] = value
  }
  return out ?? input
}

/** A defaults group with no caller input at all — drop the nesting markers. */
function materialise(defaults: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(defaults)) {
    const nested = isNestedGroup(value) ? value[NESTED_MARKER] : undefined
    out[key] = nested === undefined ? value : materialise(nested)
  }
  return out
}
`

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true })
  writeIfChanged(OUTPUT, banner + body)
  // eslint-disable-next-line no-console
  console.log(
    `Wrote ${caps.length} caps / ${totalMethods} methods with input defaults → ${path.relative(ROOT, OUTPUT)}`,
  )
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})
