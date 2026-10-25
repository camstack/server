#!/usr/bin/env tsx
/**
 * Codegen: the cross-addon API type (`AppRouter` / `AddonApi`).
 *
 * REWRITTEN 2026-07-30 (roadmap: "the generated addon API is 93% untyped").
 * The previous generator asked TypeScript to expand the ENTIRE AppRouter as
 * one type alias via ts-morph; at ~1,950 inlined procedures the checker hit
 * its expansion budget and silently degraded EVERY signature to `any` — one
 * added cap method away from disabling type-checking across every addon.
 *
 * Now the two halves are generated differently:
 *
 *  - CAPABILITY routers (~96% of procedures) are DERIVED from the Zod cap
 *    definitions — the same `*.cap.ts` source the runtime routers are built
 *    from. Each procedure's input/output is a `z.infer<typeof cap.methods…>`
 *    REFERENCE, resolved lazily per use-site: no up-front expansion, no
 *    cliff, and the wire shape (loose object input + nodeId routing key)
 *    mirrors `generate-cap-routers.ts` exactly.
 *
 *  - CORE routers (the ~15 hand-written ones: auth, logs, live, …) are still
 *    expanded with ts-morph, but EACH ROUTER SEPARATELY — every alias is two
 *    orders of magnitude below the budget that broke the monolith.
 *
 * The degradation guard survives: a core-router expansion containing
 * `input: any` / `output: any` refuses to write, and now NAMES the
 * procedures that lost their type.
 *
 * PREREQUISITE: the core half is expanded with the SERVER tsconfig, which
 * resolves `@camstack/types` and `@camstack/system` through their
 * `dist/*.d.ts` — not their sources. On a fresh clone or worktree those
 * dists do not exist, the checker resolves the imports to error types, and
 * the guard trips on procedures that are perfectly well typed in source.
 * `findUnusableFrameworkDists` answers that up front (see
 * `framework-dist-freshness.ts`); `npm run codegen` rebuilds them for you.
 *
 * Usage: npx tsx scripts/generate-api-types.ts
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { Project, ts } from 'ts-morph'
import {
  isObjectInput,
  isVoidInput,
  kebabToCamel,
} from '../packages/types/src/capabilities/cap-router-predicates.js'
import { cleanupExpandedRouterType } from './api-types-specifier-cleanup.ts'
import { writeIfChanged } from './codegen-write.ts'
import { findDegradedProcedures } from './core-router-degradation.ts'
import { findUnusableFrameworkDists, rebuildCommandFor } from './framework-dist-freshness.ts'

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')
const SERVER_DIR = path.join(ROOT, 'server/backend')
const CAPS_DIR = path.join(ROOT, 'packages/types/src/capabilities')
const MOUNTS_FILE = path.join(SERVER_DIR, 'src/api/trpc/generated-cap-mounts.ts')
const ROUTER_FILE = path.join(SERVER_DIR, 'src/api/trpc/trpc.router.ts')
const OUTPUT_DIR = path.join(ROOT, 'packages/types/src/generated')
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'addon-api.ts')

function kebabToPascal(str: string): string {
  const camel = kebabToCamel(str)
  return camel.charAt(0).toUpperCase() + camel.slice(1)
}

// ── Capability discovery (mirrors generate-cap-routers.ts) ─────────────────

interface MethodInfo {
  readonly name: string
  readonly kind: 'query' | 'mutation' | 'subscription'
  readonly isVoidInput: boolean
  readonly isObjectInput: boolean
  readonly source: 'cap' | 'settings' | 'status'
}

interface CapInfo {
  readonly fileName: string
  readonly exportName: string
  readonly capName: string
  readonly camelName: string
  readonly mode: 'singleton' | 'collection'
  readonly methods: readonly MethodInfo[]
}

async function loadCapabilities(): Promise<CapInfo[]> {
  const caps: CapInfo[] = []
  const files = fs.readdirSync(CAPS_DIR).filter((f) => f.endsWith('.cap.ts'))
  const { expandCapMethods, DEVICE_SETTINGS_CONTRIBUTION_METHODS, DEVICE_STATUS_METHOD } =
    await import('../packages/types/src/index.js')
  const settingsMethodNames = new Set(Object.keys(DEVICE_SETTINGS_CONTRIBUTION_METHODS))
  const statusMethodNames = new Set(Object.keys(DEVICE_STATUS_METHOD))

  for (const file of files) {
    const filePath = path.join(CAPS_DIR, file)
    const mod: Record<string, unknown> = await import(filePath)
    for (const [exportName, value] of Object.entries(mod)) {
      if (!exportName.endsWith('Capability')) continue
      const def = value as {
        name?: string
        mode?: string
        methods?: Record<string, { input: unknown; output: unknown; opts?: { kind?: string } }>
      }
      if (typeof def?.name !== 'string' || !def.methods) continue
      // Same effective-method expansion the runtime routers use — folds the
      // device-settings contribution + status methods in when declared.
      const effective = expandCapMethods(def as never) as Record<
        string,
        { input: unknown; kind?: string }
      >
      // A method the CAP ITSELF declares always wins — `expandCapMethods` folds
      // the injected sets in FIRST (`{ ...DEVICE_STATUS_METHOD, ...def.methods }`),
      // so the cap's own schema is what runs. Classifying by NAME alone typed
      // every cap with its own `getStatus` (network-access, mesh-network,
      // mqtt-broker, broker, smtp-provider, ptz-autotrack, device-export,
      // device-provider) against the DEVICE status shape instead — the caller
      // then got `unknown` and had to cast (2026-07-30, found threading the
      // network-access tunnel into the NC artifact links).
      const ownNames = new Set(Object.keys(def.methods))
      const methods: MethodInfo[] = Object.entries(effective).map(([name, schema]) => ({
        name,
        kind: (schema.kind ?? 'query') as MethodInfo['kind'],
        isVoidInput: isVoidInput(schema.input),
        isObjectInput: isObjectInput(schema.input),
        source: ownNames.has(name)
          ? ('cap' as const)
          : settingsMethodNames.has(name)
            ? ('settings' as const)
            : statusMethodNames.has(name)
              ? ('status' as const)
              : ('cap' as const),
      }))
      caps.push({
        fileName: file.replace(/\.ts$/, ''),
        exportName,
        capName: def.name,
        camelName: kebabToCamel(def.name),
        mode: def.mode === 'collection' ? 'collection' : 'singleton',
        methods,
      })
    }
  }
  // Same dedup rule as the router codegen: prefer the file matching the cap name.
  const byName = new Map<string, CapInfo>()
  for (const cap of caps) {
    const existing = byName.get(cap.capName)
    if (!existing || cap.fileName === `${cap.capName}.cap`) byName.set(cap.capName, cap)
  }
  return [...byName.values()]
}

// ── Mounted keys (source of truth: the generated mounts file) ──────────────

function parseCapMounts(): Map<string, string> {
  // mountKey → RouterPascalName, from `  key: createCapRouter_Name(`.
  const src = fs.readFileSync(MOUNTS_FILE, 'utf8')
  const out = new Map<string, string>()
  for (const m of src.matchAll(/^\s{4}(\w+): createCapRouter_(\w+)\(/gm)) {
    out.set(m[1]!, m[2]!)
  }
  return out
}

function parseCoreEntries(): Array<{ key: string; factory: string }> {
  // The non-cap entries of buildCapabilityRouters: `key: createXxxRouter(`.
  const src = fs.readFileSync(ROUTER_FILE, 'utf8')
  const out: Array<{ key: string; factory: string }> = []
  for (const m of src.matchAll(/^\s{4}(\w+): (create\w+Router)\(/gm)) {
    if (m[2]!.startsWith('createCapRouter_')) continue
    out.push({ key: m[1]!, factory: m[2]! })
  }
  return out
}

// ── Emission helpers ───────────────────────────────────────────────────────

// Top-level type imports in the OUTPUT (not inline `import("…")` references):
// tsc's unused-import detection does not walk type arguments of import-type
// nodes, so `import type { z }` + `import("@trpc/server").X<z.infer<…>>`
// falsely flags every import as unused (repro'd 2026-07-30).
const TRPC = ''
// Declared LOCALLY in the generated file — the real interface lives server-side
// (cap-route-error-formatter.ts) and is not part of the types package surface.
const ERROR_SHAPE = 'AugmentedErrorShape'

function builtRouter(inner: string): string {
  return (
    `TRPCBuiltRouter<{ ctx: TrpcContext; meta: object; errorShape: ${ERROR_SHAPE}; transformer: true; }, ` +
    `TRPCDecorateCreateRouterOptions<{ ${inner} }>>`
  )
}

function schemaRef(cap: CapInfo, m: MethodInfo): string {
  if (m.source === 'status') return `DEVICE_STATUS_METHOD.${m.name}`
  if (m.source === 'settings') return `DEVICE_SETTINGS_CONTRIBUTION_METHODS.${m.name}`
  return `${cap.exportName}.methods.${m.name}`
}

function procedureText(cap: CapInfo, m: MethodInfo): string {
  const ref = schemaRef(cap, m)
  const outRef = `z.infer<typeof ${ref}.output>`
  if (m.kind === 'subscription') {
    // `iterableSubscription` erases the payload type on the wire.
    const inRef = `z.input<typeof ${ref}.input>`
    return `${m.name}: TRPCSubscriptionProcedure<{ input: ${inRef}; output: AsyncIterable<unknown, any, any>; meta: object; }>`
  }
  const wrapper = m.kind === 'query' ? 'TRPCQueryProcedure' : 'TRPCMutationProcedure'
  let inText: string
  if (m.isVoidInput) {
    // Router replaces a void input with the routing selectors, optional.
    inText =
      cap.mode === 'collection'
        ? '{ nodeId?: string | undefined; addonId?: string | undefined; } | undefined'
        : '{ nodeId?: string | undefined; } | undefined'
  } else if (m.isObjectInput) {
    // `.loose()` wire shape: schema fields + an open index signature that
    // carries the router-level selectors (nodeId / addonId).
    // z.input, not z.infer: fields with `.default()` are OPTIONAL for the
    // caller (the router's Zod parse fills them) — z.infer is the post-parse
    // OUTPUT type and would force every defaulted field on every caller.
    inText = `{ [x: string]: unknown; } & z.input<typeof ${ref}.input>`
  } else {
    inText = `z.input<typeof ${ref}.input>`
  }
  return `${m.name}: ${wrapper}<{ input: ${inText}; output: ${outRef}; meta: object; }>`
}

function capRouterText(cap: CapInfo): string {
  const procs = cap.methods.map((m) => procedureText(cap, m)).join('; ')
  return builtRouter(procs + ';')
}

// ── Core-router expansion (per router — far below the checker budget) ──────
//
// Specifier normalization lives in `./api-types-specifier-cleanup.ts` — pulled
// out so it (and its regression test) don't have to go through this file's
// top-level `void main()`. See that module's header comment for what it
// fixes and why.

function expandCoreRouters(
  entries: ReadonlyArray<{ key: string; factory: string }>,
): Map<string, string> {
  console.log('Loading server project (ts-morph) for core-router expansion…')
  // `baseUrl: undefined` OVERRIDES the server tsconfig's `baseUrl: "../.."` for
  // this throwaway probe project only — it has no effect on the real server
  // build (a separate, unrelated tsc invocation). Without it, TypeScript's
  // specifier printer for an `import("…")` type reference prefers a path
  // RELATIVE TO BASEURL over the package-name specifier whenever the resolved
  // .d.ts falls inside baseUrl — which `packages/types/dist/index.d.ts` always
  // does, once built. That is what produced `import("packages/types/dist")`
  // (reproduced 2026-08-26: identical source, identical dist, only `baseUrl`
  // differed) — a build-artifact path baked into a committed type file, and
  // non-deterministic because it depends on whether `dist` happens to exist
  // when codegen runs. Unsetting `baseUrl` here removes the baseUrl-relative
  // candidate entirely, so TS falls back to the package-name specifier
  // (`@camstack/types`) via ordinary node_modules resolution — the same form
  // regardless of dist state. `cleanupExpandedRouterType` still normalizes
  // the absolute-path form as a defensive backstop; see its module header.
  const project = new Project({
    tsConfigFilePath: path.join(SERVER_DIR, 'tsconfig.json'),
    skipAddingFilesFromTsConfig: false,
    compilerOptions: { skipLibCheck: true, noEmit: true, baseUrl: undefined },
  })

  // Locate each factory via trpc.router.ts's OWN imports — a project-wide
  // name scan picked the LEGACY api/capabilities.router.ts (deleted 2026-09-29) over the mounted
  // core/ one (both export createCapabilitiesRouter) and silently dropped
  // setActiveSingleton & co. from the type.
  const routerSrc = fs.readFileSync(ROUTER_FILE, 'utf8')
  const factoryFiles = new Map<string, string>()
  for (const m of routerSrc.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
    const names = m[1]!.split(',').map((n) =>
      n
        .trim()
        .split(/\s+as\s+/)[0]!
        .trim(),
    )
    for (const e of entries) {
      if (factoryFiles.has(e.factory)) continue
      if (names.includes(e.factory)) {
        const spec = m[2]!
        const resolved = spec.startsWith('.')
          ? path.resolve(path.dirname(ROUTER_FILE), spec.replace(/\.js$/, '.ts'))
          : spec
        factoryFiles.set(e.factory, resolved)
      }
    }
  }
  const missing = entries.filter((e) => !factoryFiles.has(e.factory))
  if (missing.length > 0) {
    console.error('✖ core-router factories not found:', missing.map((m) => m.factory).join(', '))
    process.exit(1)
  }

  // One probe file, one alias per core router — each expands independently.
  const probeLines = entries.map(
    (e, i) =>
      `import { ${e.factory} as f${i} } from '${factoryFiles.get(e.factory)!.replace(/\.ts$/, '.js')}'\n` +
      `export type __core_${e.key} = ReturnType<typeof f${i}>`,
  )
  const probe = project.createSourceFile(
    path.join(SERVER_DIR, 'src/api/trpc/__api_types_probe.ts'),
    probeLines.join('\n'),
    { overwrite: true },
  )

  const out = new Map<string, string>()
  for (const e of entries) {
    const alias = probe.getTypeAlias(`__core_${e.key}`)
    if (!alias) {
      console.error(`✖ probe alias missing for core router "${e.key}"`)
      process.exit(1)
    }
    const text = alias
      .getType()
      .getText(
        alias,
        ts.TypeFormatFlags.NoTruncation |
          ts.TypeFormatFlags.MultilineObjectLiterals |
          ts.TypeFormatFlags.InTypeAlias,
      )
    out.set(e.key, cleanupExpandedRouterType(text, ROOT))
    console.log(`  expanded core router "${e.key}" (${text.length} chars)`)
  }
  return out
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('Step 1: loading capability definitions…')
  const caps = await loadCapabilities()
  const capByCamel = new Map(caps.map((c) => [c.camelName, c]))

  console.log(`  ${caps.length} capability definitions`)

  console.log('Step 2: reading mounted routers…')
  const mounts = parseCapMounts()
  const coreEntries = parseCoreEntries()
  console.log(`  ${mounts.size} cap mounts, ${coreEntries.length} core routers`)

  const capEntries: Array<{ key: string; cap: CapInfo }> = []
  for (const [key, camel] of mounts) {
    const cap = capByCamel.get(camel)
    if (!cap) {
      console.error(`✖ mounted cap router "${key}" (${camel}) has no capability definition`)
      process.exit(1)
    }
    capEntries.push({ key, cap })
  }

  // The expansion resolves `@camstack/types` / `@camstack/system` through
  // their dist — an unbuilt or stale dist degrades every signature that flows
  // through it to `any`. Answer that question BEFORE spending 4s in the
  // checker and blaming the routers for it.
  const unusable = findUnusableFrameworkDists(ROOT)
  if (unusable.length > 0) {
    console.error('✖ REFUSING TO EXPAND: the core-router expansion has no usable framework dist.')
    for (const problem of unusable) {
      console.error(`  ${problem.name}: ${problem.reason} — ${problem.detail}`)
    }
    console.error(`  Fix: ${rebuildCommandFor(unusable)}`)
    console.error('  (or `npm run codegen`, which rebuilds these itself)')
    process.exit(1)
  }

  console.log('Step 3: expanding core routers (per-router, cliff-safe)…')
  const coreTexts = expandCoreRouters(coreEntries)

  // Degradation guard — only the checker-expanded half can degrade.
  {
    const degraded = findDegradedProcedures(coreTexts)
    if (degraded.length > 0) {
      console.error('✖ REFUSING TO WRITE: a core-router expansion is degraded.')
      // Naming the procedures is the whole point: the previous message
      // reported only counts, and locating "output: any → 6" took a
      // throwaway instrumented copy of this script (2026-08-15).
      for (const entry of degraded) {
        console.error(`  ${entry.router}.${entry.method} → ${entry.field}: any`)
      }
      process.exit(1)
    }
  }

  console.log('Step 4: emitting…')
  const entryTexts: string[] = []
  for (const { key, cap } of capEntries) {
    entryTexts.push(`${key}: ${capRouterText(cap)};`)
  }
  for (const { key } of coreEntries) {
    entryTexts.push(`${key}: ${coreTexts.get(key)!};`)
  }

  // Imports derived from the EMITTED body — a status/settings-only cap never
  // references its own export (all its methods resolve through the shared
  // DEVICE_* method maps), and an unused type-import fails noUnusedLocals.
  const body = entryTexts.join(' ')
  const importLines = [
    `import type { CreateTRPCClient } from '@trpc/client'`,
    `import type { TRPCBuiltRouter, TRPCDecorateCreateRouterOptions, TRPCQueryProcedure, TRPCMutationProcedure, TRPCSubscriptionProcedure } from '@trpc/server'`,
    `import type { Router as TrpcCoreRouter } from '@trpc/server/unstable-core-do-not-import'`,
    `import type { z } from 'zod'`,
    ...[...new Set(capEntries.map((e) => e.cap))]
      .filter((c) => body.includes(`typeof ${c.exportName}.`))
      .sort((a, b) => a.fileName.localeCompare(b.fileName))
      .map((c) => `import type { ${c.exportName} } from '../capabilities/${c.fileName}.js'`),
    ...(() => {
      const wanted = ['DEVICE_SETTINGS_CONTRIBUTION_METHODS', 'DEVICE_STATUS_METHOD'].filter((n) =>
        body.includes(`typeof ${n}.`),
      )
      return wanted.length > 0
        ? [`import type { ${wanted.join(', ')} } from '../capabilities/capability-definition.js'`]
        : []
    })(),
  ]

  const appRouter =
    `TrpcCoreRouter<{ ctx: TrpcContext; meta: object; errorShape: ${ERROR_SHAPE}; transformer: true; }, ` +
    `TRPCDecorateCreateRouterOptions<{\n  ${entryTexts.join('\n  ')}\n}>>`

  const capProcedures = capEntries.reduce((s, e) => s + e.cap.methods.length, 0)
  const coreProcedures = [...coreTexts.values()].reduce(
    (s, t) =>
      s +
      (t.match(/TRPCQueryProcedure/g) ?? []).length +
      (t.match(/TRPCMutationProcedure/g) ?? []).length +
      (t.match(/TRPCSubscriptionProcedure/g) ?? []).length,
    0,
  )
  console.log(`  ${capProcedures} cap procedures (Zod-derived) + ${coreProcedures} core (expanded)`)

  const output = `// AUTO-GENERATED by scripts/generate-api-types.ts — DO NOT EDIT
// Re-run after changing tRPC routers: npx tsx scripts/generate-api-types.ts
//
// CAP routers are DERIVED from the Zod capability definitions (lazy
// z.infer references — no type-expansion cliff); CORE routers are expanded
// per-router with ts-morph. See the script header for the 2026-07-30 rewrite
// rationale.
/* eslint-disable */

${importLines.join('\n')}

type TrpcContext = any

/** Structural mirror of the server's error shape (cap-route-error-formatter). */
type AugmentedErrorShape = {
  message: string
  code: number
  data: Record<string, unknown>
}

/** The full CamStack tRPC AppRouter type (server-side router definition). */
export type AppRouter = ${appRouter}

/**
 * The tRPC client type for AppRouter.
 * This is the type of \`context.api\` in addons — works both in-process and cross-process.
 * Has \`.query()\` / \`.mutate()\` / \`.subscribe()\` on each procedure.
 */
export type AddonApi = CreateTRPCClient<AppRouter>
`

  fs.mkdirSync(OUTPUT_DIR, { recursive: true })
  writeIfChanged(OUTPUT_FILE, output)
  console.log(`\nGenerated ${OUTPUT_FILE}`)
  console.log(`  ${output.split('\n').length} lines, ${(output.length / 1024).toFixed(1)} KB`)
}

void main()
