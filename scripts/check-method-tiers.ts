#!/usr/bin/env tsx
/**
 * GUARD: every cap method's AUTH TIER is pinned in an explicit baseline.
 *
 * Why (F2): a cap method's tier is a one-word field (`auth: 'admin' |
 * 'protected' | 'public'`) with a DEFAULT — omit it and the method is born
 * `protected` (or `admin` on an `internal: true` cap — D240 / Task 7.5c, see
 * below), and nothing in review reliably catches a tier that was never typed.
 * This guard turns a tier change into a deliberate, reviewable diff: the
 * baseline lists every method's tier, and ANY drift — a new method, a removed
 * one, a widened or narrowed tier — fails until the baseline is updated on
 * purpose.
 *
 *   npx tsx scripts/check-method-tiers.ts            # verify (CI)
 *   npx tsx scripts/check-method-tiers.ts --update   # accept current tiers
 *
 * The `--update` diff is the artefact a reviewer reads: one line per method
 * whose exposure changed. "Widened" lines (admin → protected → public) are the
 * ones that deserve a second pair of eyes, so the checker labels them.
 *
 * D240 (Task 7.5c): the DEFAULT this guard pins is `resolveMethodAuth`
 * (`cap-router-predicates.ts`) — the SAME function the runtime cap-router
 * builder and the router codegen use — not a locally re-implemented
 * `?? 'protected'`. Before D240 this file had its own copy of that fallback
 * ("mirrors the cap-router default"), which is exactly the "two places decide
 * the same thing and can disagree" shape this repo has been bitten by before:
 * a NEW `internal: true` cap's un-annotated method is actually enforced as
 * `admin` at runtime, and this guard would have silently pinned it as
 * `protected` in the baseline — correct-by-luck only because the runtime
 * floor happens to be STRICTER than the stale baseline, never the direction
 * that matters. Sharing `resolveMethodAuth` makes that impossible: the
 * baseline and the runtime are now, structurally, the same computation.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { resolveMethodAuth } from '../packages/types/src/capabilities/cap-router-predicates.js'
import type {
  CapabilityDefinition,
  CapabilityMethodSchema,
} from '../packages/types/src/capabilities/capability-definition.js'

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..')
const CAPS_DIR = path.join(ROOT, 'packages/types/src/capabilities')
const BASELINE_FILE = path.join(ROOT, 'scripts/method-tier-baseline.json')

type Tier = 'public' | 'protected' | 'admin'

/** Exposure ordering — a HIGHER number is reachable by more callers. */
const EXPOSURE: Readonly<Record<Tier, number>> = { admin: 0, protected: 1, public: 2 }

function kebabToCamel(str: string): string {
  return str.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

function isTier(value: unknown): value is Tier {
  return value === 'public' || value === 'protected' || value === 'admin'
}

async function currentTiers(): Promise<Record<string, Tier>> {
  const files = fs.readdirSync(CAPS_DIR).filter((f) => f.endsWith('.cap.ts'))
  const out: Record<string, Tier> = {}
  for (const file of files) {
    const mod: Record<string, unknown> = await import(path.join(CAPS_DIR, file))
    const exportName = Object.keys(mod).find((k) => k.endsWith('Capability'))
    if (!exportName) continue
    const capDef = mod[exportName] as CapabilityDefinition
    const routerKey = kebabToCamel(capDef.name)
    const methods: Record<string, unknown> = { ...capDef.methods }
    for (const [methodName, m] of Object.entries(methods)) {
      const schema = (m !== null && typeof m === 'object' ? m : {}) as CapabilityMethodSchema
      // Shared with the runtime builder + codegen (D240 / Task 7.5c): an
      // unset `auth` floors to `admin` on an `internal: true` cap, else
      // `protected`. NOT a locally re-implemented default — see the module
      // docblock for why that used to be able to drift from reality.
      out[`${routerKey}.${methodName}`] = resolveMethodAuth(capDef, schema)
    }
  }
  return Object.fromEntries(Object.entries(out).toSorted(([a], [b]) => a.localeCompare(b)))
}

function readBaseline(): Record<string, Tier> {
  if (!fs.existsSync(BASELINE_FILE)) return {}
  const parsed: unknown = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'))
  if (parsed === null || typeof parsed !== 'object') return {}
  const out: Record<string, Tier> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (isTier(v)) out[k] = v
  }
  return out
}

function writeBaseline(tiers: Record<string, Tier>): void {
  fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(tiers, null, 2)}\n`)
}

async function main(): Promise<void> {
  const current = await currentTiers()
  const update = process.argv.includes('--update')

  if (update) {
    writeBaseline(current)
    console.log(
      `✔ method-tier baseline updated: ${Object.keys(current).length} methods → ${path.relative(ROOT, BASELINE_FILE)}`,
    )
    return
  }

  const baseline = readBaseline()
  if (Object.keys(baseline).length === 0) {
    console.error(
      `✖ method-tier baseline missing or empty (${path.relative(ROOT, BASELINE_FILE)}).\n` +
        `  Run: npx tsx scripts/check-method-tiers.ts --update`,
    )
    process.exit(1)
  }

  const widened: string[] = []
  const narrowed: string[] = []
  const added: string[] = []
  const removed: string[] = []

  for (const [methodPath, tier] of Object.entries(current)) {
    const pinned = baseline[methodPath]
    if (pinned === undefined) {
      added.push(`${methodPath} → ${tier}`)
      continue
    }
    if (pinned === tier) continue
    const line = `${methodPath}: ${pinned} → ${tier}`
    if (EXPOSURE[tier] > EXPOSURE[pinned]) widened.push(line)
    else narrowed.push(line)
  }
  for (const methodPath of Object.keys(baseline)) {
    if (current[methodPath] === undefined) removed.push(methodPath)
  }

  if (widened.length + narrowed.length + added.length + removed.length === 0) {
    console.log(`✔ method tiers: ${Object.keys(current).length} methods, all match the baseline`)
    return
  }

  console.error('✖ method-tier drift\n')
  if (widened.length > 0) {
    console.error(`  WIDENED — now reachable by MORE callers. Review each one:`)
    for (const l of widened) console.error(`    • ${l}`)
    console.error('')
  }
  if (added.length > 0) {
    console.error(
      `  NEW methods — confirm the tier is intended (unset defaults to 'protected', ` +
        `or 'admin' on an internal cap — D240):`,
    )
    for (const l of added) console.error(`    • ${l}`)
    console.error('')
  }
  if (narrowed.length > 0) {
    console.error(`  narrowed (tightened):`)
    for (const l of narrowed) console.error(`    • ${l}`)
    console.error('')
  }
  if (removed.length > 0) {
    console.error(`  removed:`)
    for (const l of removed) console.error(`    • ${l}`)
    console.error('')
  }
  console.error(
    `  If every line above is intended, accept them with:\n` +
      `    npx tsx scripts/check-method-tiers.ts --update`,
  )
  process.exit(1)
}

void main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
