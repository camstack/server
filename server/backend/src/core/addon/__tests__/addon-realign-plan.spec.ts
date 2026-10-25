/**
 * Which installed addon is STALE against the closure, and which is a deploy the
 * operator meant.
 *
 * `/data/addons` is the only place an addon is ever loaded from — the copy
 * inside `@camstack/server`'s closure is never imported by anything. So a
 * server update carries new addon versions that have no channel into the place
 * that runs them, and nothing closes the gap: `planFirstBootAddons` computes the
 * drift every boot and prints it at INFO, with a `PlanMode` whose `'enforce'`
 * arm was never built.
 *
 * Measured on the hub, 2026-09-17 — the left column is what RUNS:
 *
 * | addon                 | /data/addons | closure |
 * | --------------------- | ------------ | ------- |
 * | addon-auth            | 1.2.96       | 1.2.115 |
 * | addon-notifiers       | 1.2.93       | 1.2.112 |
 * | addon-decoder-nodeav  | 1.2.89       | 1.2.108 |
 *
 * The hard part is not finding them. It is not overwriting a deploy that was
 * deliberate — and the version number cannot tell them apart: all six stale
 * copies carry `source: upload`, because each WAS a deliberate deploy, once.
 */
import { describe, expect, it } from 'vitest'

import { planAddonRealignment, type RealignCandidate } from '../addon-realign-plan.js'

const CLOSURE_LANDED = Date.parse('2026-09-17T10:56:40Z')

function candidate(over: Partial<RealignCandidate> = {}): RealignCandidate {
  return {
    pkg: '@camstack/addon-auth',
    installedVersion: '1.2.96',
    installedUpdatedAtMs: Date.parse('2026-09-09T07:55:13Z'),
    closureVersion: '1.2.115',
    closureLandedAtMs: CLOSURE_LANDED,
    ...over,
  }
}

function decide(over: Partial<RealignCandidate> = {}) {
  return planAddonRealignment([candidate(over)])[0]
}

describe('planAddonRealignment', () => {
  it('realigns a copy older than the closure and installed before it landed', () => {
    const d = decide()
    expect(d?.action).toBe('realign')
    expect(d?.reason).toMatch(/1\.2\.96.*1\.2\.115/)
  })

  /**
   * The case the whole gate exists for. A deploy made AFTER this closure landed
   * is better informed than the closure, whatever its number says — a workspace
   * build often carries a LOWER version than the published one.
   */
  it('keeps a copy deployed after the closure landed, even on an older version', () => {
    const d = decide({ installedUpdatedAtMs: CLOSURE_LANDED + 60_000 })
    expect(d?.action).toBe('keep')
    expect(d?.reason).toMatch(/after/i)
  })

  /**
   * STRICTLY newer, never equal. A `camstack deploy` from the workspace carries
   * the same version number as the published package with different bytes;
   * overwriting it from the closure would silently undo the deploy.
   */
  it('keeps a copy at the same version as the closure', () => {
    const d = decide({ installedVersion: '1.2.115' })
    expect(d?.action).toBe('keep')
  })

  /** A rollback puts an OLDER closure under a newer installed copy. Nothing to do. */
  it('keeps a copy newer than the closure', () => {
    const d = decide({ installedVersion: '1.2.200' })
    expect(d?.action).toBe('keep')
  })

  it('keeps an addon this closure does not carry at all', () => {
    const d = decide({ closureVersion: null })
    expect(d?.action).toBe('keep')
    expect(d?.reason).toMatch(/not carried/i)
  })

  /**
   * An install we cannot date cannot be shown to be stale, and overwriting on
   * an absent measurement is how a deliberate deploy gets destroyed. Absence is
   * reported, never folded into "old" (D393).
   */
  it('keeps — loudly — a copy whose install date is unknown', () => {
    const d = decide({ installedUpdatedAtMs: null })
    expect(d?.action).toBe('keep')
    expect(d?.reason).toMatch(/unknown|cannot/i)
  })

  it('keeps when the closure’s own landing time is unknown', () => {
    const d = decide({ closureLandedAtMs: null })
    expect(d?.action).toBe('keep')
  })

  it('decides each addon on its own', () => {
    const plan = planAddonRealignment([
      candidate(),
      candidate({ pkg: '@camstack/addon-pipeline', installedUpdatedAtMs: CLOSURE_LANDED + 1 }),
    ])
    expect(plan.map((d) => d.action)).toEqual(['realign', 'keep'])
  })
})
