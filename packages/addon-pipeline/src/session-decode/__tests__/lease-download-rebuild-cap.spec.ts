/**
 * S1 — lease-download filtergraph create cap (N100 VAAPI OOM unit).
 *
 * Disarming: if the dial create bound is raised without updating this spec, or
 * if `runLeaseDownloadCreateAttempts` stops refusing after two failures, these
 * assertions go red. Removing the cap check from the worker without deleting
 * this file leaves the measured OOM unit unbound again.
 */
import { describe, expect, it } from 'vitest'
import {
  LEASE_DOWNLOAD_FILTER_CREATES_PER_DIAL,
  LEASE_DOWNLOAD_REBUILD_CAP_REASON,
  LeaseDownloadRebuildCap,
  runLeaseDownloadCreateAttempts,
} from '../lease-download-rebuild-cap.js'

describe('LeaseDownloadRebuildCap', () => {
  it('starts at zero creates and allows the dial budget', () => {
    const cap = new LeaseDownloadRebuildCap()
    expect(cap.createsThisDial).toBe(0)
    expect(cap.canCreate()).toBe(true)
    expect(cap.maxCreatesPerDial).toBe(LEASE_DOWNLOAD_FILTER_CREATES_PER_DIAL)
  })

  it('recordCreate increments the metric and exhausts the dial budget', () => {
    const cap = new LeaseDownloadRebuildCap(2)
    cap.recordCreate()
    expect(cap.createsThisDial).toBe(1)
    expect(cap.canCreate()).toBe(true)
    cap.recordCreate()
    expect(cap.createsThisDial).toBe(2)
    expect(cap.canCreate()).toBe(false)
  })

  it('recordCreate past the cap throws the named refusal — no silent overshoot', () => {
    const cap = new LeaseDownloadRebuildCap(1)
    cap.recordCreate()
    expect(() => cap.recordCreate()).toThrow(LEASE_DOWNLOAD_REBUILD_CAP_REASON)
    expect(cap.createsThisDial).toBe(1)
  })

  it('resetForDial restores the create budget for a fresh dial', () => {
    const cap = new LeaseDownloadRebuildCap(2)
    cap.recordCreate()
    cap.recordCreate()
    expect(cap.canCreate()).toBe(false)
    cap.resetForDial()
    expect(cap.createsThisDial).toBe(0)
    expect(cap.canCreate()).toBe(true)
  })
})

describe('lease-download create attempts (disarming OOM bound)', () => {
  /**
   * Spec from `docs/design/2026-10-02-n100-vaapi-lease-download-eio.md` §S1:
   * a fake that fails `processAllSync` twice must not create a third filter
   * inside one dial (the cooldown window is the live gate's sibling; the hard
   * cap is what refuses the create even if demand re-arms).
   */
  it('two processAllSync failures must not create a third filter this dial', () => {
    let factoryCalls = 0
    const cap = new LeaseDownloadRebuildCap(LEASE_DOWNLOAD_FILTER_CREATES_PER_DIAL)
    const result = runLeaseDownloadCreateAttempts({
      cap,
      createFilter: () => {
        factoryCalls++
        return {
          processAllSync: () => {
            throw new Error('Failed to add frame to filter: EIO')
          },
          close: () => undefined,
        }
      },
      attempts: 5,
    })

    expect(factoryCalls).toBe(2)
    expect(result.filterCreates).toBe(2)
    expect(cap.createsThisDial).toBe(2)
    expect(result.refusals.length).toBeGreaterThanOrEqual(1)
    expect(result.refusals.every((r) => r === LEASE_DOWNLOAD_REBUILD_CAP_REASON)).toBe(true)
  })

  it('a healthy processAllSync reuses one create — no rebuild churn', () => {
    let factoryCalls = 0
    let processCalls = 0
    const cap = new LeaseDownloadRebuildCap(2)
    const result = runLeaseDownloadCreateAttempts({
      cap,
      createFilter: () => {
        factoryCalls++
        return {
          processAllSync: () => {
            processCalls++
          },
          close: () => undefined,
        }
      },
      attempts: 4,
    })

    expect(factoryCalls).toBe(1)
    expect(processCalls).toBe(4)
    expect(result.filterCreates).toBe(1)
    expect(result.refusals).toEqual([])
  })

  it('after a dial reset, two more creates are allowed again', () => {
    const cap = new LeaseDownloadRebuildCap(2)
    const failing = {
      createFilter: () => ({
        processAllSync: () => {
          throw new Error('EIO')
        },
        close: () => undefined,
      }),
      attempts: 3,
    }
    const first = runLeaseDownloadCreateAttempts({ cap, ...failing })
    expect(first.filterCreates).toBe(2)
    cap.resetForDial()
    const second = runLeaseDownloadCreateAttempts({ cap, ...failing })
    expect(second.filterCreates).toBe(2)
  })
})
