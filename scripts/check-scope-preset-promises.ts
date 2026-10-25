#!/usr/bin/env tsx
/**
 * A scope preset that NAMES a capability must be able to reach it.
 *
 * ## What this guards
 *
 * `SCOPE_PRESETS` are what an operator clicks in the ScopePicker, and each one
 * carries a `description` that tells them what the grant buys: *"Everything
 * `camera-viewer` does plus … PTZ movement, intercom talk-back and on-demand
 * snapshots."* Nothing checked that sentence against the rows.
 *
 * It was false for three months. `camera-operator` has promised intercom since
 * the initial commit, and every method of the `intercom` cap was
 * `auth: 'admin'`. The two gates are not additive — `adminProcedure` throws
 * `FORBIDDEN: Admin required` BEFORE `protectedProcedure`'s scope check runs —
 * so the scope machinery generated for that cap (`METHOD_ACCESS_MAP`,
 * `DEVICE_CAP_NAMES`, `METHOD_DEVICE_SELECTORS`, all correct, all complete) was
 * unreachable by construction. The operator's viewer answered every mic tap
 * with a generic "talk failed" alert and the hub logged
 * `FORBIDDEN intercom.startSession … Admin required` (D289).
 *
 * ## The check
 *
 * For every preset that declares `promisedCaps`, each named cap must have AT
 * LEAST ONE method that a caller holding that preset's rows can actually call:
 *
 *   1. the method's effective auth (`resolveMethodAuth` — the same function the
 *      runtime router and the codegen both call) is not `'admin'`, and
 *   2. some row of the preset targets the cap — `category:<scope>` matching the
 *      cap's own scope, or `capability:<name>` — and that row's `access`
 *      includes the method's access flavour, read from the generated
 *      `METHOD_ACCESS_MAP` so this guard consults exactly what
 *      `protectedProcedure` consults.
 *
 * A cap that is named but does not exist, or exists with no methods, fails the
 * same way. `promisedCaps` is opt-in per preset: a preset that names nothing
 * specific in its prose declares nothing here.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  CapabilityDefinition,
  CapabilityMethodSchema,
} from '../packages/types/src/capabilities/capability-definition.js'
import { resolveMethodAuth } from '../packages/types/src/capabilities/cap-router-predicates.js'
import { METHOD_ACCESS_MAP } from '../packages/types/src/generated/method-access-map.js'
import { PRESETS, type PresetRow, type PresetSpec } from './scope-preset-specs.ts'

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')
const CAPS_DIR = path.join(ROOT, 'packages/types/src/capabilities')

interface LoadedCap {
  readonly def: CapabilityDefinition
  readonly methods: Readonly<Record<string, CapabilityMethodSchema>>
}

function kebabToCamel(str: string): string {
  return str.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

async function loadCaps(): Promise<Map<string, LoadedCap>> {
  const out = new Map<string, LoadedCap>()
  for (const file of fs.readdirSync(CAPS_DIR).filter((f) => f.endsWith('.cap.ts'))) {
    const mod: Record<string, unknown> = await import(path.join(CAPS_DIR, file))
    const exportName = Object.keys(mod).find((k) => k.endsWith('Capability'))
    if (exportName === undefined) continue
    const def = mod[exportName] as CapabilityDefinition
    const methods = (def.methods ?? {}) as Readonly<Record<string, CapabilityMethodSchema>>
    out.set(def.name, { def, methods })
  }
  return out
}

/** True when `row` targets `cap` at all, ignoring the access tier. */
function rowTargetsCap(row: PresetRow, def: CapabilityDefinition): boolean {
  switch (row.type) {
    case 'category':
      return row.target === (def.scope === 'device' ? 'device' : 'system')
    case 'capability':
      return row.target === def.name
    // `METHOD_ACCESS_MAP.addonId` is `null` for every core cap, so an `addon`
    // row can never resolve a promise here. Saying so is better than a silent
    // `false` that reads as "no such cap".
    case 'addon':
      return false
  }
}

interface Failure {
  readonly presetId: string
  readonly capName: string
  readonly reason: string
}

function checkPreset(preset: PresetSpec, caps: Map<string, LoadedCap>): Failure[] {
  const failures: Failure[] = []
  for (const capName of preset.promisedCaps ?? []) {
    const cap = caps.get(capName)
    if (cap === undefined) {
      failures.push({
        presetId: preset.id,
        capName,
        reason: 'no capability by that name — the description names something that does not exist',
      })
      continue
    }
    const methodNames = Object.keys(cap.methods)
    if (methodNames.length === 0) {
      failures.push({ presetId: preset.id, capName, reason: 'the capability declares no methods' })
      continue
    }
    const targetingRows = preset.rows.filter((r) => rowTargetsCap(r, cap.def))
    if (targetingRows.length === 0) {
      failures.push({
        presetId: preset.id,
        capName,
        reason: `no row targets a ${cap.def.scope ?? 'system'}-scope cap (rows: ${preset.rows
          .map((r) => `${r.type}:${r.target}`)
          .join(', ')})`,
      })
      continue
    }
    const adminOnly: string[] = []
    const wrongAccess: string[] = []
    let reachable = false
    for (const methodName of methodNames) {
      const schema = cap.methods[methodName]
      if (schema === undefined) continue
      if (resolveMethodAuth(cap.def, schema) === 'admin') {
        adminOnly.push(methodName)
        continue
      }
      const record = METHOD_ACCESS_MAP[`${kebabToCamel(capName)}.${methodName}`]
      if (record === undefined) {
        wrongAccess.push(`${methodName} (absent from METHOD_ACCESS_MAP — codegen drift)`)
        continue
      }
      if (targetingRows.some((r) => r.access.includes(record.access))) {
        reachable = true
        break
      }
      wrongAccess.push(`${methodName} (needs '${record.access}')`)
    }
    if (reachable) continue
    const detail =
      adminOnly.length === methodNames.length
        ? `EVERY method resolves to auth:'admin', which adminProcedure refuses before the scope check: ${adminOnly.join(', ')}`
        : `no method is both non-admin and within the granted access tier${
            adminOnly.length > 0 ? ` — admin-only: ${adminOnly.join(', ')}` : ''
          }${wrongAccess.length > 0 ? ` — out of tier: ${wrongAccess.join(', ')}` : ''}`
    failures.push({ presetId: preset.id, capName, reason: detail })
  }
  return failures
}

async function main(): Promise<void> {
  const caps = await loadCaps()
  const failures = PRESETS.flatMap((p) => checkPreset(p, caps))
  const promised = PRESETS.reduce((n, p) => n + (p.promisedCaps?.length ?? 0), 0)

  if (failures.length > 0) {
    console.error('✗ scope preset promises a capability its rows cannot reach\n')
    for (const f of failures) {
      console.error(`  ${f.presetId} → ${f.capName}: ${f.reason}`)
    }
    console.error(
      "\nEither lower the cap method to a scope-checked tier (`auth: 'protected'`), add a row that reaches it, or stop promising it in the description + `promisedCaps` (scripts/scope-preset-specs.ts).",
    )
    process.exit(1)
  }

  console.log(`✓ ${promised} promised cap(s) across ${PRESETS.length} scope preset(s) reachable`)
}

void main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
