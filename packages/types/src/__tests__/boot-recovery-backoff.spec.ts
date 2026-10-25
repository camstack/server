/**
 * A retry armed at boot must not presume the hub was healthy when it failed.
 *
 * Measured on the boot of 2026-08-15 (docs/design/boot-to-usable-camera.md, E):
 * fifteen Hikvision devices logged `Initial probe did not complete — scheduling
 * retry chain {firstRetryMs=300000}`. Those probes did not fail because the
 * cameras were unreachable; they failed because the hub was starved by a
 * serialised boot. The condition was gone within seconds and every one of those
 * cameras stayed wrong about itself — no accessories, no probed features — for
 * a full FIVE MINUTES.
 *
 * The schedule therefore starts in seconds. The long tail stays: a battery cam
 * that is genuinely asleep is a different failure and hours of coverage is the
 * right answer for it.
 */
import { describe, expect, it } from 'vitest'
import { BOOT_RECOVERY_BACKOFF_MS } from '../util/boot-recovery-backoff.js'

describe('BOOT_RECOVERY_BACKOFF_MS', () => {
  it('retries first in SECONDS — the starved-boot case recovers before an operator notices', () => {
    expect(BOOT_RECOVERY_BACKOFF_MS[0]).toBeLessThanOrEqual(30_000)
  })

  it('gives the transient case two cheap attempts before it costs minutes', () => {
    const cheap = BOOT_RECOVERY_BACKOFF_MS.filter((ms) => ms < 60_000 * 2)
    expect(cheap.length).toBeGreaterThanOrEqual(2)
  })

  it('is a backoff, not a poll — every step is strictly longer than the last', () => {
    for (let i = 1; i < BOOT_RECOVERY_BACKOFF_MS.length; i++) {
      expect(BOOT_RECOVERY_BACKOFF_MS[i]!).toBeGreaterThan(BOOT_RECOVERY_BACKOFF_MS[i - 1]!)
    }
  })

  it('is bounded — the chain ends rather than polling a dead device forever', () => {
    expect(BOOT_RECOVERY_BACKOFF_MS.length).toBeGreaterThan(0)
    expect(BOOT_RECOVERY_BACKOFF_MS.length).toBeLessThanOrEqual(12)
  })

  it('still spans hours, so a sleeping battery cam is not abandoned in minutes', () => {
    const total = BOOT_RECOVERY_BACKOFF_MS.reduce((a, b) => a + b, 0)
    expect(total).toBeGreaterThanOrEqual(2 * 60 * 60_000)
  })
})
