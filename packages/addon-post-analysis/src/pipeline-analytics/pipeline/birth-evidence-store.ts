/**
 * The pixels a birth arrived with, held for as long as its deferral can last —
 * in a reserve that belongs to ONE camera (D379).
 *
 * ## Why a store at all
 *
 * The runner cuts a candidate birth's crop on the frame that produced it and
 * sends it with the detection. But the gate does not always decide on that
 * frame: an undecided birth is DEFERRED and re-offered on later frames, and on
 * those the same track is an ordinary matched detection carrying no evidence of
 * its own. Without this, the crop would exist for exactly one attempt and the
 * deferral — the mechanism that makes the gate fail-deferred rather than
 * fail-open — would have nothing to work with.
 *
 * ## Why per camera, and why not one shared cap
 *
 * The path this replaces was a single node-wide LRU of 4 096 entries, measured
 * PINNED FULL in 6 814 of 6 849 samples over three hours. A shared cap has two
 * properties that are wrong for evidence: a busy camera evicts a quiet one's
 * proof, and adding a camera silently shortens every other camera's window.
 * So the bound here is a RESERVE — {@link BIRTH_EVIDENCE_SLOTS_PER_CAMERA} per
 * camera, evicted by AGE inside that camera's own quota and never across
 * cameras — and the global cost is `slots x cameras`, a number that is stated
 * rather than discovered.
 *
 * ## The numbers, and the measurements behind them
 *
 * Both come from the live hub, 2026-09-07, three hours, 20 cameras with gate
 * traffic:
 *
 *  - `BIRTH_EVIDENCE_SLOTS_PER_CAMERA = 8`. The busiest camera (`hall`, 369
 *    gate verdicts) held at most FIVE distinct birth candidates in any 4 s
 *    window; the next busiest held four. Eight is that worst case with margin.
 *  - `BIRTH_EVIDENCE_TTL_MS = 4 000`. `confirmationGateMaxDeferralMs` defaults
 *    to 2 000 ms and is measured from a birth's FIRST attempt, so 2 000 ms is
 *    the longest a candidate can be re-offered. Twice that is the whole life of
 *    a deferral plus a frame-path margin; beyond it nothing can ask again.
 *
 * At the ~15 kB an evidence JPEG measures, the reserve is ~120 kB per camera
 * and ~2.4 MB across the 20 cameras that produce births — the budget this
 * change declares, checkable through {@link totalBytes}.
 */

/**
 * Evidence slots reserved for EACH camera. See the module doc: measured worst
 * case is five concurrent birth candidates in a 4 s window.
 */
export const BIRTH_EVIDENCE_SLOTS_PER_CAMERA = 8

/**
 * How long one birth's evidence is kept. Twice `confirmationGateMaxDeferralMs`
 * (2 000 ms default) — the longest a deferred birth can still be re-offered.
 */
export const BIRTH_EVIDENCE_TTL_MS = 4_000

/** One birth's crop, and when it was cut. */
interface StoredEvidence {
  readonly crop: Buffer
  readonly atMs: number
}

export class BirthEvidenceStore {
  private readonly byDevice = new Map<string, Map<string, StoredEvidence>>()

  constructor(
    private readonly slotsPerCamera: number = BIRTH_EVIDENCE_SLOTS_PER_CAMERA,
    private readonly ttlMs: number = BIRTH_EVIDENCE_TTL_MS,
  ) {}

  /**
   * Keep this birth's crop.
   *
   * The FIRST crop for an id wins. A later frame's crop of the same track is a
   * different instant, and this store exists precisely to preserve the instant
   * the birth was measured on — overwriting it would quietly reintroduce the
   * defect the fallback asymmetry exists to distrust.
   */
  remember(deviceKey: string, trackId: string, crop: Buffer, nowMs: number): void {
    let slots = this.byDevice.get(deviceKey)
    if (!slots) {
      slots = new Map<string, StoredEvidence>()
      this.byDevice.set(deviceKey, slots)
    }
    if (slots.has(trackId)) return
    slots.set(trackId, { crop, atMs: nowMs })
    this.evict(deviceKey, slots, nowMs)
  }

  /** This birth's crop, or `null` when it was never kept or has aged out. */
  get(deviceKey: string, trackId: string, nowMs: number): Buffer | null {
    const entry = this.byDevice.get(deviceKey)?.get(trackId)
    if (!entry) return null
    if (nowMs - entry.atMs > this.ttlMs) {
      this.resolve(deviceKey, trackId)
      return null
    }
    return entry.crop
  }

  /** A verdict finally arrived — the crop is dead weight from here. */
  resolve(deviceKey: string, trackId: string): void {
    const slots = this.byDevice.get(deviceKey)
    if (!slots) return
    slots.delete(trackId)
    if (slots.size === 0) this.byDevice.delete(deviceKey)
  }

  /**
   * Forget every id the tracker is no longer carrying — the same per-frame
   * contract as `DeferredBirthRegistry.retain`. An id the tracker dropped can
   * never be decided, so holding its pixels only leaks.
   */
  retain(deviceKey: string, currentTrackIds: ReadonlySet<string>): void {
    const slots = this.byDevice.get(deviceKey)
    if (!slots) return
    for (const id of [...slots.keys()]) {
      if (!currentTrackIds.has(id)) slots.delete(id)
    }
    if (slots.size === 0) this.byDevice.delete(deviceKey)
  }

  /** Crops held for one camera (diagnostics and tests). */
  size(deviceKey: string): number {
    return this.byDevice.get(deviceKey)?.size ?? 0
  }

  /** Bytes held across every camera — the declared budget, checkable. */
  totalBytes(): number {
    let total = 0
    for (const slots of this.byDevice.values()) {
      for (const entry of slots.values()) total += entry.crop.byteLength
    }
    return total
  }

  /** Drop a camera's reserve wholesale (device removed / pipeline reset). */
  clearDevice(deviceKey: string): void {
    this.byDevice.delete(deviceKey)
  }

  /**
   * Age first, then the quota — and only ever inside THIS camera's slots.
   * `Map` keeps insertion order and a crop is inserted once, so the first key
   * is always the oldest.
   */
  private evict(deviceKey: string, slots: Map<string, StoredEvidence>, nowMs: number): void {
    for (const [id, entry] of [...slots]) {
      if (nowMs - entry.atMs > this.ttlMs) slots.delete(id)
    }
    while (slots.size > this.slotsPerCamera) {
      const oldest = slots.keys().next().value
      if (oldest === undefined) break
      slots.delete(oldest)
    }
    if (slots.size === 0) this.byDevice.delete(deviceKey)
  }
}
