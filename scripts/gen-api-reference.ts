#!/usr/bin/env tsx
/**
 * gen-api-reference.ts — deterministic generator for the CamStack API map.
 *
 * It writes INTO THE REPOSITORY (`docs/reference/api.md` + `api-schemas.md`) and
 * runs from `npm run docs:generate`, with `--check` wired into `docs:check`.
 *
 * It used to write to `~/.claude/skills/camstack-api-reference/references` —
 * outside the repo, on one machine — and nothing in `package.json`,
 * `.husky/pre-commit` or `.github/workflows/ci.yml` ran it. The most detailed
 * index this project has (149 capabilities, every method, every resolved Zod
 * shape) was therefore unversioned and of unknowable age: a generator nobody
 * runs is a generated doc with all of the rot and none of the guarantee.
 * `CAMSTACK_API_REF_OUT` still redirects it for the skill's own copy.
 *
 * WHAT IT DOES
 *   Walks every `packages/types/src/capabilities/*.cap.ts` CapabilityDefinition
 *   (the same discovery `scripts/generate-cap-routers.ts` uses), resolves each
 *   method's Zod input/output schema into a human-readable type expression, and
 *   emits Markdown:
 *     - api.md          — per-cap sections + a global method index
 *     - api-schemas.md  — every named Zod schema referenced, once
 *
 *   The hand-written CORE (non-cap) routers in `trpc.router.ts` are NOT codegen
 *   output and are not described here.
 *
 * ZOD INTROSPECTION
 *   Zod 4 exposes `.def` on every schema (`.def.type` + per-type fields:
 *   object→shape, array→element, union→options, enum→entries, …). We render
 *   from that. Named schemas exported from the `@camstack/types` barrel are
 *   resolved by object identity, so a referenced schema renders as its NAME
 *   (linking into shared-schemas.md) instead of inlining a giant nested tree.
 *
 * USAGE
 *   npm run docs:generate                       — writes both files
 *   npx tsx scripts/gen-api-reference.ts --check  — fails if what is on disk differs
 *   Output dir override: CAMSTACK_API_REF_OUT=/path/to/references
 *
 * This script is READ-ONLY against the repo; it writes ONLY the two generated
 * Markdown files. It imports the real cap defs — it does not parse TS text
 * (except a cheap regex for source line + provider-interface name).
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { expandCapMethods, resolveCapMount, resolveMethodAuth } from '@camstack/types'
import type {
  CapabilityDefinition,
  CapabilityMethodSchema,
} from '../packages/types/src/capabilities/capability-definition.js'

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')
const CAPS_DIR = path.join(ROOT, 'packages/types/src/capabilities')
const BARREL = path.join(CAPS_DIR, 'index.ts')
const OUT_DIR = process.env.CAMSTACK_API_REF_OUT ?? path.join(ROOT, 'docs/reference')
const CAPS_FILE = 'api.md'
const SCHEMAS_FILE = 'api-schemas.md'

// ── Zod schema (runtime) minimal typing ─────────────────────────────
interface ZDef {
  readonly type: string
  readonly shape?: Record<string, ZSchema>
  readonly element?: ZSchema
  readonly innerType?: ZSchema
  readonly options?: readonly ZSchema[]
  readonly items?: readonly ZSchema[]
  readonly rest?: ZSchema
  readonly left?: ZSchema
  readonly right?: ZSchema
  readonly keyType?: ZSchema
  readonly valueType?: ZSchema
  readonly getter?: () => ZSchema
  readonly in?: ZSchema
  readonly out?: ZSchema
  readonly values?: readonly unknown[]
  readonly entries?: Record<string, unknown>
  readonly format?: string
  readonly defaultValue?: unknown
  readonly discriminator?: string
}
interface ZSchema {
  readonly def?: ZDef
}
function isZodSchema(v: unknown): v is ZSchema {
  return (
    typeof v === 'object' &&
    v !== null &&
    'def' in v &&
    typeof (v as ZSchema).def === 'object' &&
    typeof (v as ZSchema).def?.type === 'string'
  )
}

// ── Named-schema identity registry (barrel exports) ─────────────────
// Object identity → export name. Only "ref-worthy" composite kinds get a
// name reference; named primitives inline (a ref for z.string() is noise).
const REF_WORTHY = new Set(['object', 'union', 'enum', 'array', 'tuple', 'record'])
const namedByIdentity = new Map<ZSchema, string>()

async function buildNamedRegistry(): Promise<void> {
  const barrel: Record<string, unknown> = await import(BARREL)
  for (const [name, value] of Object.entries(barrel)) {
    if (!isZodSchema(value)) continue
    if (namedByIdentity.has(value)) continue // keep first-seen (deterministic)
    namedByIdentity.set(value, name)
  }
}

// ── Rendering ────────────────────────────────────────────────────────
const MAX_DEPTH = 4
const sharedQueue: string[] = [] // schema names awaiting definition
const sharedSeen = new Set<string>() // names already queued/defined
const sharedByName = new Map<string, ZSchema>()

function enqueueShared(name: string, schema: ZSchema): void {
  if (!sharedSeen.has(name)) {
    sharedSeen.add(name)
    sharedQueue.push(name)
    sharedByName.set(name, schema)
  }
}

/** Reference a schema by name when it is a ref-worthy named export; else inline it. */
function refOrInline(schema: ZSchema, depth: number): string {
  const name = namedByIdentity.get(schema)
  if (name !== undefined && REF_WORTHY.has(schema.def?.type ?? '')) {
    enqueueShared(name, schema)
    return name
  }
  return typeExpr(schema, depth)
}

function quoteLiteral(v: unknown): string {
  if (typeof v === 'string') return `"${v}"`
  if (v === undefined) return 'undefined'
  if (v === null) return 'null'
  return String(v)
}

function safeDefault(v: unknown): string {
  try {
    const val = typeof v === 'function' ? (v as () => unknown)() : v
    const s = JSON.stringify(val)
    return s === undefined ? String(val) : s
  } catch {
    return '…'
  }
}

/** Render an object's fields as `{ a: T; b?: T = default }`. */
function renderObjectFields(shape: Record<string, ZSchema>, depth: number): string {
  const parts: string[] = []
  for (const [key, raw] of Object.entries(shape)) {
    let s = raw
    let optional = false
    let dflt: string | null = null
    // Unwrap optional/default wrappers to move the marker onto the key.
    // Loop because `.optional().default()` nests.
    for (let i = 0; i < 4; i++) {
      const t = s.def?.type
      if (t === 'optional' && s.def?.innerType) {
        optional = true
        s = s.def.innerType
      } else if (t === 'default' && s.def?.innerType) {
        optional = true
        dflt = safeDefault(s.def.defaultValue)
        s = s.def.innerType
      } else break
    }
    const expr = refOrInline(s, depth)
    const suffix = dflt !== null ? ` = ${dflt}` : ''
    parts.push(`${key}${optional ? '?' : ''}: ${expr}${suffix}`)
  }
  return parts.length === 0 ? '{}' : `{ ${parts.join('; ')} }`
}

const lazyGuard = new Set<ZSchema>()

/** Human-readable type expression for a schema. */
function typeExpr(schema: ZSchema, depth: number): string {
  const d = schema.def
  if (!d) return 'unknown'
  switch (d.type) {
    case 'object': {
      if (depth >= MAX_DEPTH) return '{…}'
      return renderObjectFields(d.shape ?? {}, depth + 1)
    }
    case 'string': {
      return d.format ? `string(${d.format})` : 'string'
    }
    case 'number':
      return 'number'
    case 'bigint':
      return 'bigint'
    case 'boolean':
      return 'boolean'
    case 'date':
      return 'Date'
    case 'null':
      return 'null'
    case 'undefined':
      return 'undefined'
    case 'void':
      return 'void'
    case 'any':
      return 'any'
    case 'unknown':
      return 'unknown'
    case 'never':
      return 'never'
    case 'literal': {
      const vals = d.values ?? []
      return vals.map(quoteLiteral).join(' | ') || 'literal'
    }
    case 'enum': {
      const vals = Object.values(d.entries ?? {})
      return vals.map(quoteLiteral).join(' | ') || 'enum'
    }
    case 'array': {
      const el = d.element ? refOrInline(d.element, depth) : 'unknown'
      const needsParens = el.includes(' | ') || el.includes(' ')
      return `${needsParens ? `(${el})` : el}[]`
    }
    case 'optional': {
      return d.innerType ? `${refOrInline(d.innerType, depth)}?` : 'unknown?'
    }
    case 'nullable': {
      return d.innerType ? `${refOrInline(d.innerType, depth)} | null` : 'unknown | null'
    }
    case 'default': {
      const inner = d.innerType ? refOrInline(d.innerType, depth) : 'unknown'
      return `${inner} = ${safeDefault(d.defaultValue)}`
    }
    case 'readonly': {
      return d.innerType ? refOrInline(d.innerType, depth) : 'unknown'
    }
    case 'union': {
      const opts = (d.options ?? []).map((o) => refOrInline(o, depth))
      return opts.join(' | ') || 'union'
    }
    case 'record': {
      const k = d.keyType ? typeExpr(d.keyType, depth) : 'string'
      const v = d.valueType ? refOrInline(d.valueType, depth) : 'unknown'
      return `Record<${k}, ${v}>`
    }
    case 'tuple': {
      const items = (d.items ?? []).map((i) => refOrInline(i, depth))
      const rest = d.rest ? `, ...${refOrInline(d.rest, depth)}[]` : ''
      return `[${items.join(', ')}${rest}]`
    }
    case 'lazy': {
      if (!d.getter) return 'lazy'
      try {
        const resolved = d.getter()
        if (lazyGuard.has(resolved)) return 'self'
        lazyGuard.add(resolved)
        const out = refOrInline(resolved, depth)
        lazyGuard.delete(resolved)
        return out
      } catch {
        return 'lazy'
      }
    }
    case 'custom':
      return '<custom>' // z.custom()/z.instanceof() — opaque (Buffer, FrameHandle, …)
    default:
      return d.type
  }
}

/** Top-level renderer for a method input/output — refs named schemas. */
function renderTop(schema: ZSchema | undefined): string {
  if (!schema) return 'void'
  return refOrInline(schema, 0)
}

/** Escape a type expression for a Markdown table cell. */
function cell(expr: string): string {
  return '`' + expr.replace(/\|/g, '\\|') + '`'
}

// ── Cap discovery ────────────────────────────────────────────────────
interface MethodRow {
  readonly name: string
  readonly kind: string
  readonly auth: string
  readonly input: string
  readonly output: string
  readonly injected: boolean
}
interface CapRow {
  readonly capName: string
  readonly camelName: string
  readonly file: string
  readonly line: number
  readonly def: CapabilityDefinition
  readonly providerIface: string | null
  readonly methods: MethodRow[]
  readonly baseMethodNames: Set<string>
}

function kebabToCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

function scanSource(file: string, exportName: string): { line: number; iface: string | null } {
  const src = fs.readFileSync(path.join(CAPS_DIR, file), 'utf-8')
  const lines = src.split('\n')
  let line = 1
  const idx = lines.findIndex((l) => l.includes(`export const ${exportName}`))
  if (idx >= 0) line = idx + 1
  const ifaceMatch = src.match(/export\s+(?:type|interface)\s+(I[A-Za-z0-9_]+Provider)\b/)
  return { line, iface: ifaceMatch ? ifaceMatch[1]! : null }
}

async function loadCaps(): Promise<CapRow[]> {
  const files = fs.readdirSync(CAPS_DIR).filter((f) => f.endsWith('.cap.ts'))
  const rows: CapRow[] = []
  const seenCap = new Set<string>()

  for (const file of files.sort()) {
    const mod: Record<string, unknown> = await import(path.join(CAPS_DIR, file))
    const exportName = Object.keys(mod).find((k) => k.endsWith('Capability'))
    if (!exportName) continue
    const def = mod[exportName] as CapabilityDefinition
    if (!def?.name) continue
    // Dedup: prefer the file whose basename matches the cap name.
    const canonical = `${def.name}.cap.ts`
    if (seenCap.has(def.name)) {
      if (file !== canonical) continue
    }
    seenCap.add(def.name)

    const { line, iface } = scanSource(file, exportName)
    const baseMethodNames = new Set(Object.keys(def.methods ?? {}))
    const effective = expandCapMethods(def)
    const methods: MethodRow[] = []
    for (const [name, schema] of Object.entries(effective)) {
      const ms = schema as CapabilityMethodSchema
      const injected = !baseMethodNames.has(name)
      // For the auto-injected getStatus, the real runtime output is the cap's
      // own status.schema (codegen types it `unknown` for inference reasons).
      // Render the actual status shape — far more useful.
      let outSchema = ms.output as unknown as ZSchema | undefined
      if (name === 'getStatus' && def.status?.schema) {
        outSchema = def.status.schema as unknown as ZSchema
      }
      methods.push({
        name,
        kind: ms.kind ?? 'query',
        // Task 7.5c floor — same shared function the runtime builder and
        // the router codegen use, so this reference doc never LIES about
        // which auth tier a method actually resolves to.
        auth: resolveMethodAuth(def, ms),
        input: renderTop(ms.input as unknown as ZSchema),
        output: renderTop(outSchema),
        injected,
      })
    }
    rows.push({
      capName: def.name,
      camelName: kebabToCamel(def.name),
      file,
      line,
      def,
      providerIface: iface,
      methods,
      baseMethodNames,
    })
  }
  return rows.sort((a, b) => a.capName.localeCompare(b.capName))
}

// ── Emit capabilities.md ─────────────────────────────────────────────
function archetypes(def: CapabilityDefinition): string {
  const parts: string[] = []
  if (def.status) parts.push(`status(${def.status.kind ?? 'n/a'})`)
  if (def.runtimeState) parts.push('runtimeState')
  if (def.exposesDeviceSettings) parts.push('exposesDeviceSettings')
  if (def.settings) parts.push(`settings(${def.settings.bindings.length} binding(s))`)
  if (def.deviceConfig) parts.push(`deviceConfig(${def.deviceConfig.ui.kind})`)
  if (def.kind === 'wrapper') parts.push(`wrapper${def.defaultActive ? '(defaultActive)' : ''}`)
  if (def.internal) parts.push('internal')
  return parts.length ? parts.join(' · ') : '—'
}

function capHeaderMeta(row: CapRow): string {
  const d = row.def
  const bits: string[] = [`scope: \`${d.scope}\``, `mode: \`${d.mode}\``]
  if (d.deviceNative) bits.push('deviceNative: `true`')
  const mount = resolveCapMount(d).kind
  bits.push(`mount: \`${mount}\``)
  if (d.nodeIdMode) bits.push(`nodeIdMode: \`${d.nodeIdMode}\``)
  if (d.providerKind) bits.push(`providerKind: \`${d.providerKind}\``)
  if (d.preferredProvider) bits.push(`preferredProvider: \`${d.preferredProvider}\``)
  if (d.deviceTypes && d.deviceTypes.length)
    bits.push(`deviceTypes: \`${d.deviceTypes.join(', ')}\``)
  return bits.join(' · ')
}

function emitCapabilities(rows: CapRow[]): string {
  const out: string[] = []
  out.push('# CamStack Capability API Reference')
  out.push('')
  out.push('> AUTO-GENERATED by `scripts/gen-api-reference.ts`. DO NOT EDIT BY HAND.')
  out.push('> Re-run: `npm run docs:generate`. CI fails on drift (`npm run docs:check`).')
  out.push('>')
  out.push(
    '> Every capability is codegen-mounted as a tRPC router. **tRPC path convention:** cap ' +
      '`kebab-name` → router `camelName`, method verbatim → `camelName.method` ' +
      '(e.g. `pipeline-orchestrator` → `pipelineOrchestrator.getGlobalStatus`). ' +
      'Device-scoped methods take `deviceId` in the input; cross-node calls may add an ' +
      'optional `nodeId` (routing). Named input/output shapes are defined once in ' +
      '[`api-schemas.md`](./api-schemas.md).',
  )
  out.push('>')
  out.push(
    '> Methods marked `(auto)` are framework-injected: `getStatus` when the cap declares ' +
      '`status`, and the three `getDeviceSettingsContribution` / `getDeviceLiveContribution` / ' +
      '`applyDeviceSettingsPatch` when it declares `exposesDeviceSettings: true`.',
  )
  out.push('')
  const totalMethods = rows.reduce((n, r) => n + r.methods.length, 0)
  out.push(`**${rows.length} capabilities · ${totalMethods} methods.**`)
  out.push('')

  // ── Global method index ──
  out.push('## Method index')
  out.push('')
  out.push('| tRPC path | kind | auth | capability |')
  out.push('|---|---|---|---|')
  for (const r of rows) {
    for (const m of r.methods) {
      out.push(
        `| \`${r.camelName}.${m.name}\` | ${m.kind} | ${m.auth} | ${r.capName}${m.injected ? ' (auto)' : ''} |`,
      )
    }
  }
  out.push('')

  // ── Per-cap sections ──
  out.push('---')
  out.push('')
  out.push('## Capabilities')
  out.push('')
  for (const r of rows) {
    out.push(`### \`${r.capName}\` → \`${r.camelName}.*\``)
    out.push('')
    out.push(`- **Source:** \`packages/types/src/capabilities/${r.file}:${r.line}\``)
    out.push(`- **Meta:** ${capHeaderMeta(r)}`)
    out.push(`- **Archetypes:** ${archetypes(r.def)}`)
    if (r.providerIface) out.push(`- **Provider interface:** \`${r.providerIface}\``)
    if (r.def.runtimeState) {
      const rs = refOrInline(r.def.runtimeState as unknown as ZSchema, 0)
      out.push(`- **runtimeState:** ${cell(rs)}`)
    }
    if (r.def.events && Object.keys(r.def.events).length) {
      const evs = Object.entries(r.def.events).map(([n, e]) => {
        const data = renderTop((e as { data?: ZSchema }).data)
        return `\`${n}\` → ${cell(data)}`
      })
      out.push(`- **Events:** ${evs.join(' · ')}`)
    }
    out.push('')
    if (r.methods.length === 0) {
      out.push('_No methods._')
      out.push('')
      continue
    }
    out.push('| Method | tRPC path | Kind | Auth | Input | Output |')
    out.push('|---|---|---|---|---|---|')
    for (const m of r.methods) {
      const nm = m.injected ? `${m.name} _(auto)_` : m.name
      out.push(
        `| ${nm} | \`${r.camelName}.${m.name}\` | ${m.kind} | ${m.auth} | ${cell(m.input)} | ${cell(m.output)} |`,
      )
    }
    out.push('')
  }
  return out.join('\n')
}

// ── Emit shared-schemas.md ───────────────────────────────────────────
function definitionOf(schema: ZSchema): string[] {
  const d = schema.def
  if (!d) return ['`unknown`']
  const lines: string[] = []
  if (d.type === 'object') {
    const shape = d.shape ?? {}
    if (Object.keys(shape).length === 0) return ['_(empty object)_']
    for (const [key, raw] of Object.entries(shape)) {
      let s = raw
      let optional = false
      let dflt: string | null = null
      for (let i = 0; i < 4; i++) {
        const t = s.def?.type
        if (t === 'optional' && s.def?.innerType) {
          optional = true
          s = s.def.innerType
        } else if (t === 'default' && s.def?.innerType) {
          optional = true
          dflt = safeDefault(s.def.defaultValue)
          s = s.def.innerType
        } else break
      }
      const expr = refOrInline(s, 1)
      const suffix = dflt !== null ? ` = ${dflt}` : ''
      lines.push(`- \`${key}${optional ? '?' : ''}\`: ${cell(expr + suffix)}`)
    }
    return lines
  }
  if (d.type === 'enum') {
    const vals = Object.values(d.entries ?? {}).map(quoteLiteral)
    return [`Enum: ${cell(vals.join(' | '))}`]
  }
  if (d.type === 'union') {
    const opts = (d.options ?? []).map((o) => refOrInline(o, 1))
    return opts.map((o) => `- ${cell(o)}`)
  }
  if (d.type === 'array') {
    const el = d.element ? refOrInline(d.element, 1) : 'unknown'
    return [`Array of ${cell(el)}`]
  }
  return [cell(typeExpr(schema, 0))]
}

function emitSharedSchemas(): string {
  const out: string[] = []
  out.push('# CamStack Shared Zod Schemas')
  out.push('')
  out.push('> AUTO-GENERATED by `scripts/gen-api-reference.ts`. DO NOT EDIT BY HAND.')
  out.push('>')
  out.push(
    '> Named schemas referenced from [`api.md`](./api.md), each defined once. Names are the ' +
      'barrel export names from `@camstack/types` ' +
      '(`packages/types/src/capabilities/index.ts`).',
  )
  out.push('')
  // Drain the queue (definitions can enqueue further schemas → iterate to fixpoint).
  const emitted = new Set<string>()
  const sections: { name: string; body: string[] }[] = []
  while (sharedQueue.length > 0) {
    const name = sharedQueue.shift()!
    if (emitted.has(name)) continue
    emitted.add(name)
    const schema = sharedByName.get(name)
    if (!schema) continue
    sections.push({ name, body: definitionOf(schema) })
  }
  sections.sort((a, b) => a.name.localeCompare(b.name))
  out.push(`**${sections.length} shared schemas.**`)
  out.push('')
  for (const s of sections) {
    out.push(`### \`${s.name}\``)
    out.push('')
    for (const l of s.body) out.push(l)
    out.push('')
  }
  return out.join('\n')
}

async function main(): Promise<void> {
  await buildNamedRegistry()
  const rows = await loadCaps()
  // Render capabilities FIRST (populates the shared-schema queue), then shared.
  const capsMd = emitCapabilities(rows)
  const sharedMd = emitSharedSchemas()

  const written: readonly { file: string; content: string }[] = [
    { file: path.join(OUT_DIR, CAPS_FILE), content: `${capsMd.trimEnd()}\n` },
    { file: path.join(OUT_DIR, SCHEMAS_FILE), content: `${sharedMd.trimEnd()}\n` },
  ]

  if (process.argv.includes('--check')) {
    const drifted = written.filter(({ file, content }) => {
      const actual = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : ''
      return actual !== content
    })
    if (drifted.length > 0) {
      // eslint-disable-next-line no-console
      console.error(
        '\x1b[31m✘ generated API reference is stale\x1b[0m — run `npm run docs:generate`:',
      )
      for (const { file } of drifted) {
        // eslint-disable-next-line no-console
        console.error(`    ${path.relative(ROOT, file)}`)
      }
      process.exit(1)
    }
    // eslint-disable-next-line no-console
    console.log('  ✔ generated API reference is in sync')
    return
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  for (const { file, content } of written) fs.writeFileSync(file, content)

  const totalMethods = rows.reduce((n, r) => n + r.methods.length, 0)
  // eslint-disable-next-line no-console
  console.log(
    `  ✔ ${path.relative(ROOT, path.join(OUT_DIR, CAPS_FILE))} ` +
      `(${rows.length} caps, ${totalMethods} methods) + ${SCHEMAS_FILE}`,
  )
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('gen-api-reference failed:', err)
  process.exit(1)
})
