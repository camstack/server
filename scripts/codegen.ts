#!/usr/bin/env tsx
/**
 * Codegen orchestrator — single command to regenerate every derived
 * artifact in the repo and rebuild `@camstack/types` so consumers pick
 * up the changes.
 *
 * Why this exists:
 *   - 5 independent codegen scripts produce 5 derived files. Running
 *     them by hand in the right order is exactly how the `zones` /
 *     `audio-metrics` regression slipped in (someone added a cap, ran
 *     `generate-cap-routers.ts`, and forgot the bulk-declaration array
 *     in `capability-router-map.ts`).
 *   - `npx nx run-many -t build` does not invoke codegen — it only
 *     compiles whatever was already written to disk. Until something
 *     orchestrates these scripts, every "build green" run can ship a
 *     stale generated file.
 *
 * Pipeline:
 *
 *   ┌── (parallel: read .cap.ts only) ──────────────────────────────┐
 *   │  1) generate-cap-routers.ts          (per-cap tRPC procs)     │
 *   │  2) generate-capability-router-types (cap names + ALL_CAPS)   │
 *   │  3) generate-cap-status-types        (status type lookup)     │
 *   │  4) generate-device-proxy            (DeviceProxy facade)     │
 *   └───────────────────────────────────────────────────────────────┘
 *                                │
 *                                ▼
 *   4b) rebuild @camstack/types / @camstack/system when their dist is
 *       missing or older than their src — step 5 expands the core
 *       routers THROUGH that dist, so an unbuilt one degrades every
 *       signature to `any` and a stale one writes a wrong addon-api.ts
 *                                │
 *                                ▼
 *   5) generate-api-types.ts  (reads trpc.router.ts, which imports
 *                              the file produced by step 1 — must
 *                              run AFTER step 1 is on disk)
 *                                │
 *                                ▼
 *   6) npm run build -w packages/types  (so SDK/admin-ui/ui-library
 *                                        consumers see fresh d.ts)
 *
 * Usage:
 *   npm run codegen           — full pipeline + types build
 *   npm run codegen -- --no-build      — skip step 6 (faster iteration)
 *   npm run codegen -- --skip-api      — skip step 5 (no router shape change)
 *   npm run codegen -- --check         — regenerate, then fail if any generated
 *                                        file drifts from what is committed
 *                                        (CI drift guard; implies a full run)
 */

import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  findAddonPackageJsonFiles,
  findManifestMetadataDrift,
} from './capability-metadata-drift.ts'
import { checkGeneratedDrift } from './codegen-drift-check.ts'
import { findUnusableFrameworkDists } from './framework-dist-freshness.ts'

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')

interface Step {
  readonly id: string
  readonly label: string
  readonly cmd: readonly string[]
  /** Cwd is inferred from ROOT unless overridden. */
  readonly cwd?: string
}

const PARALLEL_CAP_STEPS: readonly Step[] = [
  {
    id: 'cap-routers',
    label: 'tRPC cap routers       → server/backend/src/api/trpc/generated-cap-routers.ts',
    cmd: ['npx', 'tsx', 'scripts/generate-cap-routers.ts'],
  },
  {
    id: 'capability-map',
    label: 'capability router map  → packages/types/src/generated/capability-router-map.ts',
    cmd: ['npx', 'tsx', 'scripts/generate-capability-router-types.ts'],
  },
  {
    id: 'cap-status-types',
    label: 'cap status types       → packages/types/src/generated/cap-status-types.ts',
    cmd: ['npx', 'tsx', 'scripts/generate-cap-status-types.ts'],
  },
  {
    id: 'device-proxy',
    label: 'DeviceProxy facade     → packages/types/src/generated/device-proxy.ts',
    cmd: ['npx', 'tsx', 'scripts/generate-device-proxy.ts'],
  },
  {
    id: 'system-proxy',
    label: 'SystemProxy facade     → packages/types/src/generated/system-proxy.ts',
    cmd: ['npx', 'tsx', 'scripts/generate-system-proxy.ts'],
  },
  {
    id: 'system-hooks',
    label: 'system-cap React hooks → packages/ui-library/src/generated/system-hooks.ts',
    cmd: ['npx', 'tsx', 'scripts/generate-system-hooks.ts'],
  },
  {
    id: 'method-access-map',
    label: 'method access map      → packages/types/src/generated/method-access-map.ts',
    cmd: ['npx', 'tsx', 'scripts/generate-method-access-map.ts'],
  },
  {
    id: 'scope-presets',
    label: 'scope presets          → packages/types/src/generated/scope-presets.ts',
    cmd: ['npx', 'tsx', 'scripts/generate-scope-presets.ts'],
  },
  {
    id: 'method-device-selectors',
    label: 'method device selectors → packages/types/src/generated/method-device-selectors.ts',
    cmd: ['npx', 'tsx', 'scripts/generate-method-device-selectors.ts'],
  },
  {
    id: 'provider-kind-map',
    label: 'provider-kind map      → packages/types/src/generated/provider-kind-map.ts',
    cmd: ['npx', 'tsx', 'scripts/generate-provider-kind-map.ts'],
  },
  {
    id: 'collection-array-methods',
    label: 'collection-array methods → packages/types/src/generated/collection-array-methods.ts',
    cmd: ['npx', 'tsx', 'scripts/generate-collection-array-methods.ts'],
  },
  {
    id: 'addon-cap-facts',
    label: 'addon cap facts         → packages/types/src/generated/addon-cap-facts.ts',
    cmd: ['npx', 'tsx', 'scripts/generate-addon-cap-facts.ts'],
  },
  {
    id: 'device-scoped-caps',
    label: 'device-scoped caps      → packages/types/src/generated/device-scoped-caps.ts',
    cmd: ['npx', 'tsx', 'scripts/generate-device-scoped-caps.ts'],
  },
  {
    id: 'cap-input-defaults',
    label: 'cap input defaults      → packages/types/src/generated/cap-input-defaults.ts',
    cmd: ['npx', 'tsx', 'scripts/generate-cap-input-defaults.ts'],
  },
  {
    id: 'extension-slots',
    label: 'extension slots         → packages/types/src/generated/extension-slots.ts',
    cmd: ['npx', 'tsx', 'scripts/generate-extension-slots.ts'],
  },
  {
    id: 'runtime-state-durability',
    label: 'runtime-state policy    → packages/types/src/generated/runtime-state-durability.ts',
    cmd: ['npx', 'tsx', 'scripts/generate-runtime-state-durability.ts'],
  },
  {
    id: 'history-catalog',
    label: 'history catalog         → packages/types/src/generated/history-catalog.ts',
    cmd: ['npx', 'tsx', 'scripts/generate-history-catalog.ts'],
  },
  {
    id: 'customize-catalog',
    label: 'customize catalog       → packages/types/src/generated/customize-catalog.ts',
    cmd: ['npx', 'tsx', 'scripts/generate-customize-catalog.ts'],
  },
  // generate-core-hooks.ts removed in Phase E (2026-05-06): the 6
  // hand-written core routers are now caps and `generate-system-hooks.ts`
  // covers them via the standard `.cap.ts` walker.
]

const CAP_MOUNTS_STEP: Step = {
  id: 'cap-mounts',
  label: 'tRPC cap auto-mount    → server/backend/src/api/trpc/generated-cap-mounts.ts',
  cmd: ['npx', 'tsx', 'scripts/generate-cap-mounts.ts'],
}

const API_TYPES_STEP: Step = {
  id: 'api-types',
  label: 'AppRouter type expand  → packages/types/src/generated/addon-api.ts',
  cmd: ['npx', 'tsx', 'scripts/generate-api-types.ts'],
}

const TYPES_BUILD_STEP: Step = {
  id: 'types-build',
  label: 'types package build    → packages/types/dist/*',
  cmd: ['npm', 'run', 'build', '-w', 'packages/types'],
}

interface StepResult {
  readonly id: string
  readonly ok: boolean
  readonly durationMs: number
  readonly stderr: string
}

/**
 * Every path codegen owns — the drift-check surface for `--check`. Covers the
 * `generated/` dirs (types + ui-library) AND the two non-`generated/` cap
 * outputs under server/backend. `packages/types/src/generated/addon-api.ts`
 * (the AppRouter expansion that silently goes stale on a stale types dist) is
 * inside the first entry.
 */
const GENERATED_PATHS: readonly string[] = [
  'packages/types/src/generated',
  'packages/ui-library/src/generated',
  'server/backend/src/api/trpc/generated-cap-routers.ts',
  'server/backend/src/api/trpc/generated-cap-mounts.ts',
]

/**
 * `--check`: after regenerating, fail if any generated file differs from the
 * committed copy. Catches the "edited a cap / shipped stale types dist but
 * forgot to run codegen → generated files silently stale" trap in CI.
 * Delegates to `checkGeneratedDrift` (`git diff --exit-code`, non-zero on any
 * diff) — the drift LOGIC lives in its own module with its own test, see
 * `scripts/codegen-drift-check.ts` for why that separation exists.
 */
function runGitDiffCheck(): Promise<{ ok: boolean; diff: string }> {
  return checkGeneratedDrift(ROOT, GENERATED_PATHS)
}

function runStep(step: Step): Promise<StepResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn(step.cmd[0]!, step.cmd.slice(1), {
      cwd: step.cwd ?? ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stderr = ''
    child.stdout?.on('data', () => undefined)
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    child.on('close', (code) => {
      const durationMs = Date.now() - startedAt
      const ok = code === 0
      const status = ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m'
      const ms = `${durationMs}ms`.padStart(7)
      // eslint-disable-next-line no-console
      console.log(`  ${status} ${ms}  ${step.label}`)
      resolve({ id: step.id, ok, durationMs, stderr })
    })
  })
}

async function runParallel(steps: readonly Step[]): Promise<readonly StepResult[]> {
  return Promise.all(steps.map(runStep))
}

interface DriftResult {
  readonly ok: boolean
  readonly stderr: string
}

/**
 * Cross-check `generated-cap-routers.ts` vs `generated-cap-mounts.ts`:
 * every `createCapRouter_X` MUST be either in the auto-mount output OR
 * in the `LEGACY_SHAPE_SKIP` set. A miss = drift = exit non-zero.
 *
 * The check runs in-process by reading the two files and extracting:
 *   - Every `export function createCapRouter_(\w+)\(` from the routers file
 *   - Every `\w+: createCapRouter_(\w+)\(` line + every entry of
 *     `LEGACY_SHAPE_SKIP` from the mounts file
 *
 * Regex is sufficient — both files are codegen output with a stable shape.
 */
function runDriftGuard(): Promise<DriftResult> {
  return new Promise((resolve) => {
    const routersPath = path.join(ROOT, 'server/backend/src/api/trpc/generated-cap-routers.ts')
    const mountsPath = path.join(ROOT, 'server/backend/src/api/trpc/generated-cap-mounts.ts')

    if (!fs.existsSync(routersPath)) {
      resolve({ ok: false, stderr: `drift guard: missing ${path.relative(ROOT, routersPath)}` })
      return
    }
    if (!fs.existsSync(mountsPath)) {
      resolve({ ok: false, stderr: `drift guard: missing ${path.relative(ROOT, mountsPath)}` })
      return
    }

    const routersSrc = fs.readFileSync(routersPath, 'utf-8')
    const mountsSrc = fs.readFileSync(mountsPath, 'utf-8')

    const expected = new Set<string>()
    const routerRe = /export function createCapRouter_(\w+)\(/g
    let match: RegExpExecArray | null
    while ((match = routerRe.exec(routersSrc)) !== null) {
      expected.add(match[1]!)
    }

    const mounted = new Set<string>()
    // Mount lines like:
    //   accessories: createCapRouter_accessories(...
    const mountRe = /createCapRouter_(\w+)\(/g
    while ((match = mountRe.exec(mountsSrc)) !== null) {
      mounted.add(match[1]!)
    }

    // Skip list — lines inside the `LEGACY_SHAPE_SKIP` Set initialiser.
    const skipped = new Set<string>()
    const skipBlock = mountsSrc.match(/LEGACY_SHAPE_SKIP[\s\S]*?\]\)/)
    if (skipBlock) {
      const skipRe = /'([\w-]+)'/g
      while ((match = skipRe.exec(skipBlock[0])) !== null) {
        skipped.add(match[1]!)
      }
    }

    const missing: string[] = []
    for (const name of expected) {
      if (mounted.has(name)) continue
      if (skipped.has(name)) continue
      missing.push(name)
    }

    if (missing.length === 0) {
      resolve({ ok: true, stderr: '' })
      return
    }

    const message =
      `\n\x1b[31m✘ cap-mount drift detected:\x1b[0m\n` +
      `  ${missing.length} cap router(s) in generated-cap-routers.ts have no mount in generated-cap-mounts.ts:\n` +
      missing.map((n) => `    - createCapRouter_${n}`).join('\n') +
      `\n\n` +
      `  Resolution:\n` +
      `    1. If the cap should be auto-mounted: re-run \`npx tsx scripts/generate-cap-mounts.ts\`.\n` +
      `    2. If the cap's provider has a legacy shape: add the cap name to LEGACY_SHAPE_SKIP\n` +
      `       in scripts/generate-cap-mounts.ts and re-run.\n`
    resolve({ ok: false, stderr: message })
  })
}

/**
 * D11 guard: scan packages and server/backend/src for hand-rolled
 * `camstack.evt.*` topic constructions outside the kernel event-bus module.
 * All cross-process events must go through `ctx.eventBus`
 * (`getBrokerEventBus` / `createBrokerEventBus`). Delegates to
 * `scripts/check-event-bus-usage.ts` which contains the full scan logic.
 */
function runEventBusGuard(): Promise<DriftResult> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', 'scripts/check-event-bus-usage.ts'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true, stderr: '' })
      } else {
        resolve({ ok: false, stderr: stderr || stdout })
      }
    })
  })
}

/**
 * Stage X guard: no production file may use eval / new Function / node:vm —
 * enforce-by-construction backstop for the safe expression engine. Delegates to
 * `scripts/check-no-dynamic-eval.ts`.
 */
function runNoDynamicEvalGuard(): Promise<DriftResult> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', 'scripts/check-no-dynamic-eval.ts'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true, stderr: '' })
      } else {
        resolve({ ok: false, stderr: stderr || stdout })
      }
    })
  })
}

/**
 * Settings-store collection guard: scan every package for a KV collection that
 * is accessed through the `settings-store` cap (`.query` / `.insert` /
 * `.update` / `.delete` / `.remove` / `.list` / `.count`) but never
 * `declareCollection()`'d and not in `CANONICAL_KV_COLLECTIONS`. Such a
 * collection compiles + unit-tests clean (test doubles auto-create buckets)
 * then fail-fasts against the real SQLite backend at runtime. Delegates to
 * `scripts/check-collection-declarations.ts`.
 */
function runCollectionDeclarationGuard(): Promise<DriftResult> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', 'scripts/check-collection-declarations.ts'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('close', (code) => {
      resolve(code === 0 ? { ok: true, stderr: '' } : { ok: false, stderr: stderr || stdout })
    })
  })
}

/**
 * Guard: `generated/cap-status-types.ts` must import capability schemas as `import type` (they are
 * used only in `z.infer<...>`), never as a value import — a value import drags the whole status
 * cap-def graph into every addon runner via the barrel's `CAP_NAMES_WITH_STATUS` value export.
 * Delegates to `scripts/check-cap-status-type-imports.ts`.
 */
function runCapStatusImportGuard(): Promise<DriftResult> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', 'scripts/check-cap-status-type-imports.ts'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('close', (code) => {
      resolve(code === 0 ? { ok: true, stderr: '' } : { ok: false, stderr: stderr || stdout })
    })
  })
}

/**
 * Event-kind coverage guard: every eventful sensor/control cap must map to a
 * taxonomy kind (EVENT_KIND_BY_CAP) or be explicitly exempted. Delegates to
 * `scripts/check-event-kind-coverage.ts`.
 */
function runEventKindCoverageGuard(): Promise<DriftResult> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', 'scripts/check-event-kind-coverage.ts'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('close', (code) => {
      resolve(code === 0 ? { ok: true, stderr: '' } : { ok: false, stderr: stderr || stdout })
    })
  })
}

/**
 * D4 guard: inspect every `packages/<name>/package.json` manifest for
 * behavioural capability metadata (`kind` / `defaultActive`) that must live
 * ONLY on the `.cap.ts` CapabilityDefinition. Returns `{ ok: true }` when
 * clean, or `{ ok: false, stderr: <message> }` listing each offending file.
 */
function runCapabilityMetadataGuard(): Promise<DriftResult> {
  return new Promise((resolve) => {
    const files = findAddonPackageJsonFiles(ROOT)
    const drift = findManifestMetadataDrift(files)

    if (drift.length === 0) {
      resolve({ ok: true, stderr: '' })
      return
    }

    const lines = drift.map(
      (d) =>
        `    - ${path.relative(ROOT, d.file)} → addon '${d.addonId}' cap '${d.capName}': remove ${d.offendingKeys.join(', ')}`,
    )
    const message =
      `\n\x1b[31m✘ capability metadata drift detected:\x1b[0m\n` +
      `  Addon package.json manifests must declare only WHICH caps an addon provides.\n` +
      `  \`kind\` / \`defaultActive\` belong ONLY on the *.cap.ts CapabilityDefinition (D4).\n\n` +
      lines.join('\n') +
      `\n`
    resolve({ ok: false, stderr: message })
  })
}

/**
 * Union guard: every `*.cap.ts` capability definition must be a member of the
 * `AnyCapability` union and a value re-export of the capabilities barrel —
 * otherwise `CapabilityName` silently omits it and every consumer keyed on the
 * name is blind to the cap. Delegates to
 * `scripts/check-capability-union-complete.ts`.
 */
function runCapabilityUnionGuard(): Promise<DriftResult> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', 'scripts/check-capability-union-complete.ts'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('close', (code) => {
      resolve(code === 0 ? { ok: true, stderr: '' } : { ok: false, stderr: stderr || stdout })
    })
  })
}

function fail(results: readonly StepResult[]): never {
  const failed = results.filter((r) => !r.ok)
  // eslint-disable-next-line no-console
  console.error(`\n\x1b[31m${failed.length} step(s) failed:\x1b[0m`)
  for (const r of failed) {
    // eslint-disable-next-line no-console
    console.error(`\n── ${r.id} ─────────────────────────────────`)
    // eslint-disable-next-line no-console
    console.error(r.stderr.trim() || '(no stderr captured)')
  }
  process.exit(1)
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2))
  // `--check` implies a full, faithful regeneration — a stale types dist or a
  // skipped API expansion would produce a false "no drift" pass, so it wins
  // over the skip flags.
  const checkDrift = args.has('--check')
  const skipApi = args.has('--skip-api') && !checkDrift
  const skipBuild = args.has('--no-build') && !checkDrift
  const totalStart = Date.now()

  // eslint-disable-next-line no-console
  console.log('\n\x1b[1mCamstack codegen — parallel cap-readers\x1b[0m')
  const parallelResults = await runParallel(PARALLEL_CAP_STEPS)
  if (parallelResults.some((r) => !r.ok)) fail(parallelResults)

  // Cap auto-mount step: must run AFTER generate-cap-routers.ts so it
  // can read the latest list of `createCapRouter_X` exports to cross-
  // reference against the cap-def walk.
  // eslint-disable-next-line no-console
  console.log('\n\x1b[1mCamstack codegen — tRPC auto-mount\x1b[0m')
  const mountResult = await runStep(CAP_MOUNTS_STEP)
  if (!mountResult.ok) fail([mountResult])

  // Drift guard: every `createCapRouter_X` in `generated-cap-routers.ts`
  // MUST be either in the auto-mount output OR in `LEGACY_SHAPE_SKIP`.
  // Catches the "added a cap, forgot to mount it" regression at codegen
  // time so a `routerNotFound` doesn't ship to clients.
  // eslint-disable-next-line no-console
  console.log('\n\x1b[1mCamstack codegen — auto-mount drift guard\x1b[0m')
  const driftResult = await runDriftGuard()
  if (!driftResult.ok) {
    // eslint-disable-next-line no-console
    console.error(driftResult.stderr)
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.log('  \x1b[32m✔\x1b[0m drift guard passed')

  // D4 guard: addon manifests must declare only WHICH caps an addon
  // provides — `kind`/`defaultActive` live exclusively on the cap def.
  // eslint-disable-next-line no-console
  console.log('\n\x1b[1mCamstack codegen — capability metadata guard\x1b[0m')
  const capMetaResult = await runCapabilityMetadataGuard()
  if (!capMetaResult.ok) {
    // eslint-disable-next-line no-console
    console.error(capMetaResult.stderr)
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.log('  \x1b[32m✔\x1b[0m capability metadata guard passed')

  // Union guard: a cap defined but left out of `AnyCapability` compiles
  // green and generates a router — only `CapabilityName` loses it, and a
  // hole in a union has no arity anyone counts.
  // eslint-disable-next-line no-console
  console.log('\n\x1b[1mCamstack codegen — capability union guard\x1b[0m')
  const capUnionResult = await runCapabilityUnionGuard()
  if (!capUnionResult.ok) {
    // eslint-disable-next-line no-console
    console.error(capUnionResult.stderr)
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.log('  \x1b[32m✔\x1b[0m capability union guard passed')

  // Event-kind coverage guard: every eventful sensor/control cap must map to
  // a taxonomy kind or be explicitly exempted (complete = an invariant).
  // eslint-disable-next-line no-console
  console.log('\n\x1b[1mCamstack codegen — event-kind coverage guard\x1b[0m')
  const eventKindCoverageResult = await runEventKindCoverageGuard()
  if (!eventKindCoverageResult.ok) {
    // eslint-disable-next-line no-console
    console.error(eventKindCoverageResult.stderr)
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.log('  \x1b[32m✔\x1b[0m event-kind coverage guard passed')

  // D11 guard: no hand-rolled `camstack.evt.*` topic constructions outside
  // the kernel event-bus module — all cross-process events go through
  // ctx.eventBus (getBrokerEventBus / createBrokerEventBus).
  // eslint-disable-next-line no-console
  console.log('\n\x1b[1mCamstack codegen — event-bus usage guard\x1b[0m')
  const eventBusResult = await runEventBusGuard()
  if (!eventBusResult.ok) {
    // eslint-disable-next-line no-console
    console.error(eventBusResult.stderr)
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.log('  \x1b[32m✔\x1b[0m event-bus usage guard passed')

  // Stage X guard: ban eval / new Function / node:vm repo-wide (the safe
  // expression engine replaces every need for dynamic code execution).
  // eslint-disable-next-line no-console
  console.log('\n\x1b[1mCamstack codegen — no-dynamic-eval guard\x1b[0m')
  const noEvalResult = await runNoDynamicEvalGuard()
  if (!noEvalResult.ok) {
    // eslint-disable-next-line no-console
    console.error(noEvalResult.stderr)
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.log('  \x1b[32m✔\x1b[0m no-dynamic-eval guard passed')

  // Settings-store collection guard: every collection accessed via the
  // settings-store cap must be declareCollection()'d (or be canonical) — the
  // SQLite backend fail-fasts on undeclared collections at runtime.
  // eslint-disable-next-line no-console
  console.log('\n\x1b[1mCamstack codegen — settings-store collection guard\x1b[0m')
  const collectionGuardResult = await runCollectionDeclarationGuard()
  if (!collectionGuardResult.ok) {
    // eslint-disable-next-line no-console
    console.error(collectionGuardResult.stderr)
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.log('  \x1b[32m✔\x1b[0m settings-store collection guard passed')

  const capStatusImportResult = await runCapStatusImportGuard()
  if (!capStatusImportResult.ok) {
    // eslint-disable-next-line no-console
    console.error(capStatusImportResult.stderr)
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.log('  \x1b[32m✔\x1b[0m cap-status-types import guard passed')

  if (!skipApi) {
    // The AppRouter expansion reads the core routers through the SERVER
    // tsconfig, which resolves `@camstack/types` / `@camstack/system` through
    // their `dist/*.d.ts`. Missing dist → every signature through it expands
    // to `any` and the degradation guard refuses to write; stale dist → it
    // writes a confidently WRONG addon-api.ts. Both are silent about the
    // cause, so rebuild what is unusable here, right before the expansion —
    // AFTER the cap generators above have written into `types/src/generated`,
    // which is precisely what makes the dist stale mid-run.
    const unusable = findUnusableFrameworkDists(ROOT)
    if (unusable.length > 0) {
      // eslint-disable-next-line no-console
      console.log('\n\x1b[1mCamstack codegen — framework dist (AppRouter prerequisite)\x1b[0m')
      for (const problem of unusable) {
        const buildResult = await runStep({
          id: `framework-dist:${problem.dir}`,
          label: `${problem.name} (${problem.reason})  → ${problem.dir}/dist/*`,
          cmd: ['npm', 'run', 'build', '-w', problem.dir],
        })
        if (!buildResult.ok) fail([buildResult])
      }
    }

    // eslint-disable-next-line no-console
    console.log('\n\x1b[1mCamstack codegen — AppRouter type expansion\x1b[0m')
    const apiResult = await runStep(API_TYPES_STEP)
    if (!apiResult.ok) fail([apiResult])
  } else {
    // eslint-disable-next-line no-console
    console.log(
      '\n\x1b[2m(skip) AppRouter type expansion — pass without --skip-api to regenerate\x1b[0m',
    )
  }

  if (!skipBuild) {
    // eslint-disable-next-line no-console
    console.log('\n\x1b[1mCamstack codegen — types package build\x1b[0m')
    const buildResult = await runStep(TYPES_BUILD_STEP)
    if (!buildResult.ok) fail([buildResult])
  } else {
    // eslint-disable-next-line no-console
    console.log('\n\x1b[2m(skip) types package build — pass without --no-build to compile\x1b[0m')
  }

  // Auto-format the generated outputs that live OUTSIDE a `generated/` dir
  // (the cap routers/mounts under server/backend/src/api/trpc/). Their raw
  // emit is unformatted, and because they are NOT biome-excluded a later
  // `biome format .` would reformat them — committing the raw emit creates a
  // recurring format drift. Formatting here makes codegen output match the
  // repo's biome style so the two never disagree. (The `generated/` dir
  // outputs are biome-excluded by config and intentionally left raw.)
  // eslint-disable-next-line no-console
  console.log('\n\x1b[1mCamstack codegen — format generated outputs\x1b[0m')
  const formatResult = await runStep({
    id: 'format-generated',
    label: 'biome format           → generated-cap-routers.ts + generated-cap-mounts.ts',
    cmd: [
      'npx',
      'biome',
      'format',
      '--write',
      'server/backend/src/api/trpc/generated-cap-routers.ts',
      'server/backend/src/api/trpc/generated-cap-mounts.ts',
    ],
  })
  if (!formatResult.ok) fail([formatResult])

  if (checkDrift) {
    // eslint-disable-next-line no-console
    console.log('\n\x1b[1mCamstack codegen — drift check (--check)\x1b[0m')
    const drift = await runGitDiffCheck()
    if (!drift.ok) {
      // eslint-disable-next-line no-console
      console.error(
        '\n\x1b[31m✘ codegen drift detected\x1b[0m — generated files are out of date.\n' +
          'A cap definition changed (or the types dist was stale) without a matching\n' +
          '`npm run codegen`. Run it locally and commit the result. Offending diff:\n',
      )
      // eslint-disable-next-line no-console
      console.error(drift.diff)
      process.exit(1)
    }
    // eslint-disable-next-line no-console
    console.log('  \x1b[32m✔\x1b[0m no codegen drift')
  }

  const totalMs = Date.now() - totalStart
  // eslint-disable-next-line no-console
  console.log(`\n\x1b[32m✔ codegen complete\x1b[0m \x1b[2m(${totalMs}ms total)\x1b[0m\n`)
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('\n\x1b[31mcodegen orchestrator crashed:\x1b[0m', err)
  process.exit(1)
})
