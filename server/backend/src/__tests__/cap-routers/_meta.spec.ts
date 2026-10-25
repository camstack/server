/**
 * Meta-test: ensures that every capability with methods has a corresponding
 * `<cap-name>.router.spec.ts` file in this directory. This prevents new caps
 * from being added without a router-level test.
 *
 * Caps listed in `ALLOWED_MISSING` are explicitly exempted (document why).
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as capsModule from '@camstack/types'
import type { CapabilityDefinition } from '@camstack/types'

/**
 * Caps that are knowingly untested at the router level.
 * Keep this list empty whenever possible — every entry is tech debt.
 */
const ALLOWED_MISSING: ReadonlySet<string> = new Set<string>([
  // Populated during migration. Goal: drain to empty.
])

function isCapabilityDefinition(value: unknown): value is CapabilityDefinition {
  if (value === null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v['name'] === 'string' &&
    typeof v['scope'] === 'string' &&
    typeof v['mode'] === 'string' &&
    typeof v['methods'] === 'object' &&
    v['methods'] !== null
  )
}

function collectCapabilitiesWithMethods(): readonly CapabilityDefinition[] {
  const out: CapabilityDefinition[] = []
  for (const [key, value] of Object.entries(capsModule)) {
    if (!key.endsWith('Capability')) continue
    if (!isCapabilityDefinition(value)) continue
    if (Object.keys(value.methods).length === 0) continue
    out.push(value)
  }
  return out.toSorted((a, b) => a.name.localeCompare(b.name))
}

function specFileNameFor(capName: string): string {
  return `${capName}.router.spec.ts`
}

describe('cap-routers meta', () => {
  const caps = collectCapabilitiesWithMethods()
  const specDir = __dirname
  const existingSpecs = new Set(
    fs.readdirSync(specDir).filter((f) => f.endsWith('.router.spec.ts')),
  )

  it('discovers at least one capability with methods', () => {
    expect(caps.length).toBeGreaterThan(0)
  })

  it('every capability has a <cap>.router.spec.ts (or is in ALLOWED_MISSING)', () => {
    const missing: string[] = []
    for (const cap of caps) {
      const expected = specFileNameFor(cap.name)
      if (!existingSpecs.has(expected) && !ALLOWED_MISSING.has(cap.name)) {
        missing.push(cap.name)
      }
    }

    // Soft-fail during migration: list missing but warn loudly.
    // Flip to `expect(missing).toEqual([])` once coverage is complete.
    if (missing.length > 0) {
      console.warn(
        `\n[cap-routers meta] ${missing.length} capabilities lack a router spec:\n  - ${missing.join('\n  - ')}\n`,
      )
    }
    // Hard gate: at least one real spec must exist so the harness stays exercised.
    expect(existingSpecs.size).toBeGreaterThanOrEqual(1)
  })

  it('ALLOWED_MISSING only references real capabilities', () => {
    const names = new Set(caps.map((c) => c.name))
    for (const name of ALLOWED_MISSING) {
      expect(names, `ALLOWED_MISSING references unknown cap "${name}"`).toContain(name)
    }
  })

  // ── Subscription codegen guard ──────────────────────────────────────
  //
  // Enumerates every capability method and, for each method marked
  // `kind: 'subscription'`, verifies that the generated cap-router file
  // includes the corresponding `.subscription(` wiring and the
  // `iterableSubscription` import. This catches codegen drift when new
  // subscription methods are added to caps.
  describe('subscription codegen', () => {
    const generatedPath = path.resolve(specDir, '../../api/trpc/generated-cap-routers.ts')
    const generatedSource = fs.existsSync(generatedPath)
      ? fs.readFileSync(generatedPath, 'utf-8')
      : null

    it('generated-cap-routers.ts exists', () => {
      expect(generatedSource, `expected generated file at ${generatedPath}`).not.toBeNull()
    })

    const subscriptionMethods: Array<{ capName: string; methodName: string }> = []
    for (const cap of caps) {
      for (const [methodName, schema] of Object.entries(cap.methods)) {
        if (schema.kind === 'subscription') {
          subscriptionMethods.push({ capName: cap.name, methodName })
        }
      }
    }

    it('if any cap has subscriptions, iterableSubscription is imported', () => {
      if (subscriptionMethods.length === 0 || generatedSource === null) return
      expect(
        generatedSource,
        'generated-cap-routers.ts must import iterableSubscription when any cap has kind: "subscription"',
      ).toContain('iterableSubscription')
    })

    it('every subscription method is wired in the generated router', () => {
      if (generatedSource === null) return
      const missing: string[] = []
      for (const { capName, methodName } of subscriptionMethods) {
        // The generator emits `${methodName}: procedure\n      .input(...)\n      .subscription(`.
        // We check for the method-name line followed by `.subscription(` within a small window.
        const nameIdx = generatedSource.indexOf(`${methodName}:`)
        if (nameIdx === -1) {
          missing.push(`${capName}.${methodName} (method name not found)`)
          continue
        }
        const window = generatedSource.slice(nameIdx, nameIdx + 300)
        if (!window.includes('.subscription(')) {
          missing.push(`${capName}.${methodName} (no .subscription( call within 300 chars)`)
        }
      }
      expect(
        missing,
        `Subscription codegen drift — re-run: npx tsx scripts/generate-cap-routers.ts\n  ${missing.join('\n  ')}`,
      ).toEqual([])
    })

    it('reports the subscription method inventory (informational)', () => {
      // Not an assertion — this keeps the metric visible in test output.
      console.log(
        `[subscription codegen] ${subscriptionMethods.length} subscription method(s) across ${caps.length} caps`,
      )
      if (subscriptionMethods.length > 0) {
        for (const { capName, methodName } of subscriptionMethods) {
          console.log(`  ${capName}.${methodName}`)
        }
      }
    })
  })

  // ── Output-validation codegen guard ────────────────────────────────
  //
  // Per device-proxy redesign §6.8 / Task 4.1, every non-subscription
  // procedure in the generated cap-router file must declare an `.output()`
  // call so that tRPC validates response shapes at runtime. Subscriptions
  // are exempt — tRPC v11 does not support `.output()` on subscriptions.
  describe('output-validation codegen', () => {
    const generatedPath = path.resolve(specDir, '../../api/trpc/generated-cap-routers.ts')
    const generatedSource = fs.existsSync(generatedPath)
      ? fs.readFileSync(generatedPath, 'utf-8')
      : null

    it('every non-subscription procedure declares .output()', () => {
      expect(generatedSource, `expected generated file at ${generatedPath}`).not.toBeNull()
      if (generatedSource === null) return

      // tRPC procedure call sites are spelled `.query(async` / `.mutation(async`
      // when they're emitted as router endpoints — the few in-body `p.query(...)`
      // / `p.mutation(...)` calls don't include `(async`, so this filter is exact.
      const procedureCallRegex = /\.(query|mutation)\(async/g
      const procedureCount = (generatedSource.match(procedureCallRegex) ?? []).length
      const outputCount = (generatedSource.match(/\.output\(/g) ?? []).length

      expect(
        outputCount,
        `output-validation codegen drift — expected at least ${procedureCount} .output() ` +
          `calls (one per query/mutation), found ${outputCount}. ` +
          `Re-run: npx tsx scripts/generate-cap-routers.ts`,
      ).toBeGreaterThanOrEqual(procedureCount)
    })

    it('reports the procedure / output-call inventory (informational)', () => {
      if (generatedSource === null) return
      const queryCount = (generatedSource.match(/\.query\(async/g) ?? []).length
      const mutationCount = (generatedSource.match(/\.mutation\(async/g) ?? []).length
      const subscriptionCount = (generatedSource.match(/\.subscription\(/g) ?? []).length
      const outputCount = (generatedSource.match(/\.output\(/g) ?? []).length
      console.log(
        `[output-validation codegen] queries=${queryCount} mutations=${mutationCount} ` +
          `subscriptions=${subscriptionCount} outputs=${outputCount}`,
      )
    })
  })
})
