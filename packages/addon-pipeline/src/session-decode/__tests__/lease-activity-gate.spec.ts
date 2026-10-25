/**
 * `LeaseActivityGate` — demand-driven gating for the native-frame lease
 * (2026-07-16 N100 saturation fix).
 *
 * The lease store's eager capture downloaded EVERY delivered frame from the
 * GPU at NATIVE resolution (`scale_<be>=iw:ih,hwdownload`) even on cameras
 * where nothing ever requests a native crop (dev 103: 24 4K downloads/s,
 * `nativeCropHits:0` for hours) — enough sustained memory-bandwidth burn to
 * saturate an N100 host running two sessions and collapse delivered fps to 0.
 *
 * The gate makes capture demand-driven: armed at dial start (so the first
 * track of a fresh on-motion session still gets native-quality media) and
 * re-armed by every native-crop request (post-analysis snapshots + the detail
 * plane keep it hot while tracks are active); it expires after `windowMs`
 * without demand, dropping the per-frame download cost to zero on idle
 * cameras.
 */
import { describe, expect, it } from 'vitest'
import { LeaseActivityGate } from '../lease-activity-gate.js'

describe('LeaseActivityGate', () => {
  it('starts COLD — no capture before anything arms it', () => {
    let now = 1_000
    const gate = new LeaseActivityGate(15_000, () => now)
    expect(gate.active).toBe(false)
  })

  it('arm() opens the gate for exactly windowMs', () => {
    let now = 1_000
    const gate = new LeaseActivityGate(15_000, () => now)
    gate.arm()
    expect(gate.active).toBe(true)
    now += 14_999
    expect(gate.active).toBe(true)
    now += 1
    expect(gate.active).toBe(false)
  })

  it('re-arming extends the window from NOW (sliding, not cumulative)', () => {
    let now = 1_000
    const gate = new LeaseActivityGate(10_000, () => now)
    gate.arm()
    now += 9_000
    gate.arm() // demand keeps flowing — window slides
    now += 9_999
    expect(gate.active).toBe(true)
    now += 1
    expect(gate.active).toBe(false)
  })

  it('windowMs 0 disables gating — always active (legacy eager capture)', () => {
    let now = 1_000
    const gate = new LeaseActivityGate(0, () => now)
    expect(gate.active).toBe(true)
    now += 1_000_000
    expect(gate.active).toBe(true)
  })

  it('disableFor() forces the gate closed — arm() does not reopen a broken path early', () => {
    let now = 1_000
    const gate = new LeaseActivityGate(15_000, () => now)
    gate.arm()
    gate.disableFor(60_000)
    expect(gate.active).toBe(false)
    gate.arm() // crop demand keeps flowing — must NOT reopen a broken path
    expect(gate.active).toBe(false)
  })

  it('disableFor() overrides even windowMs 0 (legacy always-on mode)', () => {
    let now = 1_000
    const gate = new LeaseActivityGate(0, () => now)
    gate.disableFor(60_000)
    expect(gate.active).toBe(false)
  })

  /**
   * The 93-97% native-crop-miss regression (2026-08-08 harvest). `disable()`
   * used to be a latch held until the next DIAL, so two EIO `hwdownload`
   * failures killed the native lease for the whole session — on a continuously
   * recording camera that is hours. Live evidence: dev 108 had 24 dials
   * disabled in one day and sat at 93% `nativeCropMisses`; dev 592 logged
   * `leaseOffered` deltas of exactly 0 across 500 s while servicing ~15 crop
   * requests/s, i.e. `arm()` firing constantly against a gate that could never
   * reopen. Every detail dispatch's rung 1 missed for the rest of the dial.
   *
   * The cooldown must EXPIRE on its own so a transient GPU fault recovers
   * without a re-dial. The OOM guard the latch existed for is preserved by the
   * cooldown's length, not by permanence: at most one filtergraph rebuild per
   * cooldown instead of one per frame.
   */
  it('disableFor() EXPIRES — a transient download fault recovers without a re-dial', () => {
    let now = 1_000
    const gate = new LeaseActivityGate(15_000, () => now)
    gate.disableFor(60_000)
    now += 59_999
    gate.arm()
    expect(gate.active).toBe(false)
    now += 1
    gate.arm() // demand after the cooldown → capture resumes
    expect(gate.active).toBe(true)
  })

  it('an expired cooldown still respects the demand window (it does not force capture on)', () => {
    let now = 1_000
    const gate = new LeaseActivityGate(15_000, () => now)
    gate.disableFor(1_000)
    now += 1_000
    expect(gate.active).toBe(false) // cooldown over, but nothing has armed it
  })

  it('a later disableFor() extends the cooldown (escalating backoff)', () => {
    let now = 1_000
    const gate = new LeaseActivityGate(15_000, () => now)
    gate.disableFor(10_000)
    now += 5_000
    gate.disableFor(60_000) // second failure — longer cooldown from NOW
    now += 55_000
    gate.arm()
    expect(gate.active).toBe(false)
    now += 5_001
    gate.arm()
    expect(gate.active).toBe(true)
  })

  it('reset() clears the cooldown AND demand — a fresh dial starts cold until re-armed', () => {
    let now = 1_000
    const gate = new LeaseActivityGate(15_000, () => now)
    gate.arm()
    gate.disableFor(600_000)
    gate.reset()
    expect(gate.active).toBe(false) // demand cleared too — dial start arms explicitly
    gate.arm()
    expect(gate.active).toBe(true)
  })
})
