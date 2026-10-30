/**
 * Shared `.cap.ts` parser used by both the device-proxy and system-proxy
 * codegen scripts. Reads a single capability file from disk and returns
 * structured info: cap name, scope, methods (with kind + device-bound
 * detection), runtime-state presence, and the camelCase property name.
 *
 * The parsing is purely textual (no TypeScript AST) — capability files
 * follow a small, predictable shape (`as const satisfies CapabilityDefinition`),
 * so a balanced-brace walker over the `methods: { ... }` block is enough
 * and avoids pulling ts-morph into the codegen step.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

export interface CapMethodInfo {
  readonly name: string
  readonly kind: 'query' | 'mutation' | 'subscription'
  /**
   * True when the method's input schema includes `deviceId: z.number()`.
   * Device-scoped caps are always device-bound by definition; system caps
   * mix device-bound (per-device slices of cluster-wide singletons) and
   * system-bound (cluster-wide commands) methods.
   */
  readonly deviceBound: boolean
  /**
   * True when the method was declared with `optionalMethod()` — a COLLECTION
   * cap's source may legitimately not serve it, so the generated router must
   * check before it calls rather than assuming every provider has it.
   */
  readonly providerOptional: boolean
}

export interface CapInfo {
  readonly fileName: string // e.g. 'snapshot.cap.js' (rewritten for ESM imports)
  readonly exportName: string // e.g. 'snapshotCapability'
  readonly capName: string // kebab-case, e.g. 'snapshot-provider'
  readonly propertyName: string // camelCase, e.g. 'snapshotProvider'
  readonly scope: 'device' | 'system'
  readonly methods: readonly CapMethodInfo[]
  /** True when the cap declares `runtimeState: <ZodObject>`. */
  readonly hasRuntimeState: boolean
  /**
   * `durability: 'session' | 'restored'` as declared, or `null` when the cap
   * declares none. Only meaningful alongside `hasRuntimeState`; a
   * `runtimeState` cap with `null` here is what
   * `scripts/check-runtime-state-durability.ts` refuses.
   */
  readonly durability: 'session' | 'restored' | null
  /**
   * `volatileStateFields: [...]` as declared — the slice's clock fields,
   * persisted but excluded from the compare that decides whether a write is
   * worth a commit. Empty when the cap declares none.
   */
  readonly volatileStateFields: readonly string[]
  /** True when the cap declares `status: { ... }`. */
  readonly hasStatus: boolean
  /**
   * True when the cap declares `internal: true` — server-internal cap
   * consumed in-process only, never mounted on the public AppRouter.
   * Generators that emit consumer-facing surface (system-proxy,
   * system-hooks) skip these caps so dead accessors don't ship to the
   * SDK.
   */
  readonly internal: boolean
  /**
   * Optional semantic role used by the admin UI's unified Integrations
   * page to group caps by external-system kind. `null` when the cap
   * doesn't declare `providerKind`.
   */
  readonly providerKind: string | null
}

export function kebabToCamel(s: string): string {
  return s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

/**
 * The FIRST top-level argument of a `method(...)` call body — its INPUT
 * schema. Device-bound detection reads only this: a `deviceId: z.number()` in
 * the OUTPUT schema (a per-camera row in what the method returns) is data about
 * a device, not a routing key, and testing the whole call marked such a method
 * device-bound (`pipelineOrchestrator.rebalance` had to hoist its skip schema
 * out of the method to dodge it). Splits at the first comma outside every
 * `()`, `{}` and `[]`; expects the comment-blanked text.
 */
function inputArgument(callBody: string): string {
  let depth = 0
  for (let i = 0; i < callBody.length; i++) {
    const ch = callBody[i]
    if (ch === '(' || ch === '{' || ch === '[') depth++
    else if (ch === ')' || ch === '}' || ch === ']') depth--
    else if (ch === ',' && depth === 0) return callBody.slice(0, i)
  }
  return callBody
}

/**
 * Parse a single `.cap.ts` file. Returns `null` for files that don't
 * declare a capability (e.g. helpers or schema-only modules without
 * `scope:` and `name:` keys).
 *
 * `capsDir` is the absolute path to `packages/types/src/capabilities`.
 */
export function parseCapFile(capsDir: string, file: string): CapInfo | null {
  const src = fs.readFileSync(path.join(capsDir, file), 'utf8')
  if (!/scope:\s*['"](device|system)['"]/.test(src)) return null
  // The CAPABILITY export, by its naming convention first: a cap file may
  // export other object constants before it (an extension-slot descriptor,
  // D648, is declared above the cap that lists it in `extensionSlots`), and
  // "the first `export const x = {`" then names the descriptor.
  const exportMatch =
    src.match(/export\s+const\s+(\w+Capability)\s*=\s*\{/) ??
    src.match(/export\s+const\s+(\w+)\s*=\s*\{/)
  if (!exportMatch) return null
  // `name:` and `scope:` are read from the capability's OWN block, never the
  // first occurrence in the file — a constant declared above the cap (a slot
  // descriptor, a schema literal) may carry a `name: '…'` of its own.
  const capBlock = src.slice(exportMatch.index ?? 0)
  const scopeMatch = capBlock.match(/scope:\s*['"](device|system)['"]/)
  const nameMatch = capBlock.match(/name:\s*['"]([^'"]+)['"]/)
  if (!scopeMatch || !nameMatch) return null
  const scope = scopeMatch[1] === 'device' ? 'device' : 'system'

  const methods: CapMethodInfo[] = []
  // Searched in a comment-BLANKED copy, never the raw source. `indexOf` takes
  // the first literal `methods:` anywhere in the file — and a docblock that
  // says "FIVE methods: listSources, …" is anywhere. When that happens the
  // brace walk starts inside prose, the body comes out empty, and the cap
  // generates `const xInterface = {}` with an empty device proxy. **It fails
  // SILENTLY**: no codegen guard notices, and only `tsc` catches it, and only
  // where the generated type happens to be consumed. Measured 2026-09-24 on
  // `recording.cap.ts` and `recording-archive.cap.ts`, both of which parsed as
  // ZERO methods because their headers described what they carry — the author
  // worked around it by rewording the prose, which is a workaround the next
  // author will not know about.
  //
  // Blanking preserves length and newlines, so every offset below — the brace
  // walk, the slice, the line numbers — still indexes the real source.
  // Verified: codegen output is byte-identical across all 159 caps with and
  // without this change, so it fixes a landmine rather than moving anything.
  const scanned = src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '))
  // The block is `methods: {` — a schema FIELD named `methods` (e.g.
  // `signIn.methods: z.array(...)` in broker.cap.ts) is not it, and matching
  // the bare key made the walk start there and the cap parse as zero methods.
  const methodsMatch = /\bmethods\s*:\s*\{/.exec(scanned)
  const methodsIdx = methodsMatch ? methodsMatch.index : -1
  if (methodsIdx !== -1) {
    const braceIdx = src.indexOf('{', methodsIdx)
    if (braceIdx !== -1) {
      let depth = 1
      let i = braceIdx + 1
      while (i < src.length && depth > 0) {
        if (src[i] === '{') depth++
        else if (src[i] === '}') depth--
        i++
      }
      const body = src.slice(braceIdx + 1, i - 1)
      const scannedBody = scanned.slice(braceIdx + 1, i - 1)
      // Match `method(` and both wrapper factories — `systemMethod(` (served
      // only by the system provider) and `optionalMethod(` (a collection
      // SOURCE may not serve it). All three define a cap method the
      // router/proxy must surface: which PROVIDERS must implement it is a
      // type-level question, and has nothing to do with whether the method
      // exists on the wire. Missing `optionalMethod` here silently dropped
      // `videoclips.readClipBytes` out of every generated artifact — the
      // router, the proxies, the access map — while the cap file plainly
      // declared it. Longest alternative first, or `method` swallows the tail
      // of the other two.
      const methodRegex = /^\s+(\w+)\s*:\s*(optionalMethod|systemMethod|method)\(/gm
      let m: RegExpExecArray | null
      while ((m = methodRegex.exec(body)) !== null) {
        const name = m[1]!
        const openParenIdx = body.indexOf('(', m.index + name.length)
        let pDepth = 1
        let j = openParenIdx + 1
        while (j < body.length && pDepth > 0) {
          if (body[j] === '(') pDepth++
          else if (body[j] === ')') pDepth--
          j++
        }
        const callBody = body.slice(openParenIdx + 1, j - 1)
        let kind: 'query' | 'mutation' | 'subscription' = 'query'
        const kindMatch = callBody.match(/kind:\s*['"](query|mutation|subscription)['"]/)
        if (kindMatch) kind = kindMatch[1] as typeof kind
        const deviceBound = /\bdeviceId\s*:\s*z\.number\(/.test(
          inputArgument(scannedBody.slice(openParenIdx + 1, j - 1)),
        )
        methods.push({ name, kind, deviceBound, providerOptional: m[2] === 'optionalMethod' })
      }
    }
  }

  const hasRuntimeState = /^\s*runtimeState\s*:/m.test(src)
  const durabilityMatch = src.match(/^\s*durability\s*:\s*['"](session|restored)['"]/m)
  const durability = durabilityMatch ? (durabilityMatch[1] as 'session' | 'restored') : null
  const volatileMatch = src.match(/^\s*volatileStateFields\s*:\s*\[([^\]]*)\]/m)
  const volatileStateFields = volatileMatch
    ? [...volatileMatch[1]!.matchAll(/['"]([^'"]+)['"]/g)].map((m2) => m2[1]!)
    : []
  const hasStatus = /^\s*status\s*:\s*\{/m.test(src)
  const exposesDeviceSettings = /^\s*exposesDeviceSettings\s*:\s*true/m.test(src)
  const internal = /^\s*internal\s*:\s*true/m.test(src)
  const providerKindMatch = src.match(/^\s*providerKind\s*:\s*['"]([^'"]+)['"]/m)
  const providerKind = providerKindMatch ? providerKindMatch[1]! : null

  // Auto-inject `getStatus` when the cap declares `status: { ... }` but
  // no explicit `getStatus` method. Always device-bound by contract —
  // `DEVICE_STATUS_METHOD` ships the `deviceId` schema.
  let finalMethods: CapMethodInfo[] =
    hasStatus && !methods.some((mi) => mi.name === 'getStatus')
      ? [
          ...methods,
          { name: 'getStatus', kind: 'query' as const, deviceBound: true, providerOptional: false },
        ]
      : [...methods]

  // Auto-inject the three device-settings contribution methods when
  // `exposesDeviceSettings: true`. These mirror the methods folded in
  // by `expandCapMethods()` at runtime and the codegen'd cap router —
  // every consumer that walks methods needs to see them. All three
  // take `{ deviceId: number }` so they're device-bound by contract.
  if (exposesDeviceSettings) {
    const injected: CapMethodInfo[] = [
      {
        name: 'getDeviceSettingsContribution',
        kind: 'query',
        deviceBound: true,
        providerOptional: false,
      },
      {
        name: 'getDeviceLiveContribution',
        kind: 'query',
        deviceBound: true,
        providerOptional: false,
      },
      {
        name: 'applyDeviceSettingsPatch',
        kind: 'mutation',
        deviceBound: true,
        providerOptional: false,
      },
    ]
    for (const m of injected) {
      if (!finalMethods.some((existing) => existing.name === m.name)) finalMethods.push(m)
    }
  }

  return {
    fileName: file.replace('.ts', '.js'),
    exportName: exportMatch[1]!,
    capName: nameMatch[1]!,
    propertyName: kebabToCamel(nameMatch[1]!),
    scope,
    methods: finalMethods,
    hasRuntimeState,
    durability,
    volatileStateFields,
    hasStatus,
    internal,
    providerKind,
  }
}

/**
 * Read every `.cap.ts` file in `capsDir` and return the parsed infos.
 * Files that don't declare a capability are skipped silently.
 */
export function parseAllCaps(capsDir: string): readonly CapInfo[] {
  const files = fs.readdirSync(capsDir).filter((f) => f.endsWith('.cap.ts'))
  const out: CapInfo[] = []
  for (const f of files) {
    const info = parseCapFile(capsDir, f)
    if (info) out.push(info)
  }
  return out
}
