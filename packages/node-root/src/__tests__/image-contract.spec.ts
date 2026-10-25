import { describe, expect, it } from 'vitest'
import { assessImageContract } from '../image-contract.js'

/**
 * The case this module exists for, with its real numbers: on 2026-08-02 the
 * hub was RUNNING `ghcr.io/camstack/camstack-server:intel-1.1.74` — a
 * 13-day-old image from a repository that had been RENAMED and received no
 * builds — while the deployment contract declared
 * `ghcr.io/camstack/camstack:intel-latest` (then 1.2.32). The template guard
 * passed every day, `runningVersion` was current via applyServerUpdate, and
 * NOTHING compared the running image to the contract. The agent had the right
 * repository but was pinned to `intel-1.2.0`.
 */
describe('assessImageContract', () => {
  it('flags the real hub case: seed a full series behind the registry latest', () => {
    const verdict = assessImageContract({
      seedVersion: '1.1.74',
      latestVersion: '1.2.32',
      runningVersion: '1.2.32',
    })
    expect(verdict.state).toBe('behind-series')
    expect(verdict.seedVersion).toBe('1.1.74')
    expect(verdict.contractVersion).toBe('1.2.32')
    expect(verdict.contractSource).toBe('registry')
    // The sentence must carry both versions — "this node runs image X; the
    // contract says Y" — and name the failure shape a pull cannot fix.
    expect(verdict.message).toContain('1.1.74')
    expect(verdict.message).toContain('1.2.32')
    expect(verdict.message.toLowerCase()).toContain('pinned tag')
  })

  it('flags the hub case even with NO registry check: the running version proves it', () => {
    // Today's exact steady-state: checkCache empty after a reboot, but the
    // data-root runs 1.2.32 — a node can never run code newer than the newest
    // release, so seed 1.1.74 < running 1.2.32 is proof enough.
    const verdict = assessImageContract({
      seedVersion: '1.1.74',
      latestVersion: null,
      runningVersion: '1.2.32',
    })
    expect(verdict.state).toBe('behind-series')
    expect(verdict.contractVersion).toBe('1.2.32')
    expect(verdict.contractSource).toBe('running')
  })

  it('flags the real agent case: right repo, pinned tag, 32 patches behind', () => {
    const verdict = assessImageContract({
      seedVersion: '1.2.0',
      latestVersion: '1.2.32',
      runningVersion: '1.2.32',
    })
    expect(verdict.state).toBe('behind-patch')
    expect(verdict.message).toContain('1.2.0')
    expect(verdict.message).toContain('1.2.32')
    // The message must say what applyServerUpdate does NOT do.
    expect(verdict.message).toContain('applyServerUpdate')
  })

  it('reports in-sync when the seed equals the current release', () => {
    const verdict = assessImageContract({
      seedVersion: '1.2.32',
      latestVersion: '1.2.32',
      runningVersion: '1.2.32',
    })
    expect(verdict.state).toBe('in-sync')
    expect(verdict.contractSource).toBe('registry')
  })

  it('prefers the registry over the running version as the contract reference', () => {
    // Running is one behind latest (update not yet applied) — the contract is
    // still what intel-latest delivers, not what this node happens to run.
    const verdict = assessImageContract({
      seedVersion: '1.2.30',
      latestVersion: '1.2.33',
      runningVersion: '1.2.31',
    })
    expect(verdict.contractVersion).toBe('1.2.33')
    expect(verdict.contractSource).toBe('registry')
    expect(verdict.state).toBe('behind-patch')
  })

  it('is unknown — NOT in-sync — when seed == running and no check has run', () => {
    // A freshly recreated container before any registry check: we genuinely
    // cannot distinguish "current image" from "ancient image never updated".
    // Claiming in-sync here would be the fake-green this module exists to kill.
    const verdict = assessImageContract({
      seedVersion: '1.1.74',
      latestVersion: null,
      runningVersion: '1.1.74',
    })
    expect(verdict.state).toBe('unknown')
    expect(verdict.contractVersion).toBeNull()
  })

  it('is unknown with no seed (dev workspace)', () => {
    const verdict = assessImageContract({
      seedVersion: null,
      latestVersion: '1.2.32',
      runningVersion: '1.2.32',
    })
    expect(verdict.state).toBe('unknown')
    expect(verdict.seedVersion).toBeNull()
  })

  it('reports ahead when the seed is newer than the best-known release', () => {
    const verdict = assessImageContract({
      seedVersion: '1.2.33',
      latestVersion: '1.2.32',
      runningVersion: '1.2.32',
    })
    expect(verdict.state).toBe('ahead')
  })

  it('classifies a major-version gap as behind-series', () => {
    const verdict = assessImageContract({
      seedVersion: '1.9.9',
      latestVersion: '2.0.0',
      runningVersion: '2.0.0',
    })
    expect(verdict.state).toBe('behind-series')
  })
})
