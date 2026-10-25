/**
 * `declareAlarmPanel` is ARMED at boot, never awaited.
 *
 * `initialize()` is on the critical path of the whole capability graph: the
 * runner appends an addon's manifest entry only AFTER `initialize()` returns,
 * so an await that outlives a boot takes every capability the addon declares
 * offline cluster-wide (docs/architecture/addon-lifecycle.md).
 *
 * The panel's first port call is `integrations.getByAddonId` — a hub-CORE
 * namespace served by `$core-caps`, which `main.ts` registers only AFTER
 * `app.init()` returns, i.e. after the entire addon boot. During a child's boot
 * the call is therefore not slow, it is structurally unanswerable, and it burns
 * the full UDS timeout: measured 61 s of DETERMINISTIC boot delay, at every
 * single boot of this addon. D167 names exactly this: `initialize()` never
 * awaits a hub-core cap.
 *
 * Nothing was gained by waiting. The retry ladder
 * (`startAlarmPanelConvergence`) is the path that actually lands the panel on a
 * cold hub — measured on the live boot of 2026-08-19: declared at t0+204 s with
 * `attempts=1`, i.e. on the ladder's FIRST tick, having already paid 61 s for a
 * boot attempt that could not succeed.
 */
import { describe, expect, it } from 'vitest'
import { bootAnalytics } from './boot-analytics.js'
import { makeHangingIntegrations } from './test-helpers.js'

/** Generous, but finite: the point is that boot does not wait for a 60 s UDS
 *  timeout, so anything in this neighbourhood proves it. */
const BOOT_BUDGET_MS = 5_000

describe('alarm panel declaration at boot', () => {
  it('initialize() RESOLVES while the integrations namespace never answers', async () => {
    const started = Date.now()
    const booted = await bootAnalytics(101, async () => null, {
      integrations: makeHangingIntegrations(),
    })
    const elapsed = Date.now() - started

    // The whole point: the manifest is publishable, so every capability this
    // addon declares is registered instead of absent.
    expect(booted.addon).toBeDefined()
    expect(elapsed).toBeLessThan(BOOT_BUDGET_MS)

    await booted.addon.shutdown()
  }, 20_000)

  it('boot never reports a declareAlarmPanel step — the step is not on the boot path', async () => {
    const booted = await bootAnalytics(101, async () => null, {
      integrations: makeHangingIntegrations(),
    })

    const steps = booted.logs
      .filter((line) => line.message === 'pipeline-analytics boot step')
      .map((line) => (line.extras as { meta?: { step?: string } } | undefined)?.meta?.step)

    // `declareCollections` still is — it is the addon's OWN store and it must
    // land before the first insert. The panel is not.
    expect(steps).toContain('declareCollections')
    expect(steps).not.toContain('declareAlarmPanel')

    await booted.addon.shutdown()
  }, 20_000)
})
