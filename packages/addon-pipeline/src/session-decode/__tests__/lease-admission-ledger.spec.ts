/**
 * Lease ADMISSION — "keep only what reached inference".
 *
 * The premise the `inferred` mode rests on is that a native-crop request can
 * only ever name a `frameId` that rode an INFERENCE RESULT, because that is the
 * only carrier a `FrameHandle` has out of the runner. That premise is a claim
 * about the whole cluster's call graph, so the ledger is built to MEASURE it
 * rather than assume it: `unmarkedCrops` counts every crop request naming a
 * frame the runner never marked, in BOTH modes, and it is that number — not the
 * reading of the code — that decides whether `inferred` is safe as a default.
 */
import { describe, expect, it } from 'vitest'
import { LeaseAdmissionLedger } from '../lease-admission-ledger.js'

describe('LeaseAdmissionLedger — mode "all"', () => {
  it('admits every offered frame, marked or not', () => {
    const ledger = new LeaseAdmissionLedger({ mode: 'all' })
    ledger.mark(2)
    expect(ledger.admit(1)).toBe(true)
    expect(ledger.admit(2)).toBe(true)
    expect(ledger.admit(3)).toBe(true)
    expect(ledger.offered).toBe(3)
    expect(ledger.admitted).toBe(3)
  })

  it('still tracks marks, so the unmarked-crop counter measures the premise BEFORE the filter is switched on', () => {
    const ledger = new LeaseAdmissionLedger({ mode: 'all' })
    ledger.mark(1)
    ledger.admit(1)
    ledger.admit(2)
    expect(ledger.noteCropRequest(1)).toBe(false)
    expect(ledger.noteCropRequest(2)).toBe(true)
    expect(ledger.unmarkedCrops).toBe(1)
  })
})

describe('LeaseAdmissionLedger — mode "inferred"', () => {
  it('keeps a marked frame and drops an unmarked one', () => {
    const ledger = new LeaseAdmissionLedger({ mode: 'inferred' })
    ledger.mark(2)
    expect(ledger.admit(1)).toBe(false)
    expect(ledger.admit(2)).toBe(true)
    expect(ledger.admit(3)).toBe(false)
    expect(ledger.offered).toBe(3)
    expect(ledger.admitted).toBe(1)
  })

  it('a mark is one-shot per frame id and does not leak to its neighbours', () => {
    const ledger = new LeaseAdmissionLedger({ mode: 'inferred' })
    ledger.mark(10)
    expect(ledger.admit(9)).toBe(false)
    expect(ledger.admit(10)).toBe(true)
    expect(ledger.admit(11)).toBe(false)
  })
})

describe('LeaseAdmissionLedger — a release before the supersede withdraws the mark', () => {
  it('an unmarked frame is no longer admitted, and its neighbours are untouched', () => {
    const ledger = new LeaseAdmissionLedger({ mode: 'inferred' })
    ledger.mark(1)
    ledger.mark(2)
    ledger.unmark(1)
    expect(ledger.admit(1)).toBe(false)
    expect(ledger.admit(2)).toBe(true)
  })
})

describe('LeaseAdmissionLedger — marks are counted, not just consulted', () => {
  // The failure this catches: the mark signal stops arriving (a protocol guard
  // rejects it, a caller stops sending it) and `unmarkedCrops` stays 0 because
  // an EMPTY window answers nothing — which reads exactly like a clean premise.
  it('counts every mark received, so "0 unmarked crops" can be told apart from "0 marks"', () => {
    const ledger = new LeaseAdmissionLedger({ mode: 'all' })
    expect(ledger.marks).toBe(0)
    ledger.mark(1)
    ledger.mark(2)
    ledger.mark(2)
    expect(ledger.marks).toBe(3)
    expect(ledger.markedSize).toBe(2)
  })

  it('a ledger that never received a mark reports no unmarked crops — which is why the mark count matters', () => {
    const ledger = new LeaseAdmissionLedger({ mode: 'all' })
    ledger.admit(1)
    expect(ledger.noteCropRequest(1)).toBe(false)
    expect(ledger.unmarkedCrops).toBe(0)
    expect(ledger.marks).toBe(0)
  })
})

describe('LeaseAdmissionLedger — the marked window is bounded', () => {
  it('forgets the oldest marks past its capacity instead of growing without bound', () => {
    const ledger = new LeaseAdmissionLedger({ mode: 'inferred', capacity: 3 })
    for (const id of [1, 2, 3, 4, 5]) ledger.mark(id)
    expect(ledger.markedSize).toBe(3)
    // 1 and 2 fell out of the window; 3,4,5 survive.
    expect(ledger.admit(3)).toBe(true)
    expect(ledger.admit(5)).toBe(true)
  })

  it('does NOT count a crop for a frame older than the tracked window as unmarked — that is unknowable, not evidence', () => {
    const ledger = new LeaseAdmissionLedger({ mode: 'inferred', capacity: 2 })
    ledger.mark(1)
    ledger.mark(50)
    ledger.mark(51)
    // 1 has aged out of the window: the ledger cannot say whether it was ever
    // marked, so it must not claim it was not.
    expect(ledger.noteCropRequest(1)).toBe(false)
    expect(ledger.unmarkedCrops).toBe(0)
    // 60 is inside the window (newer than the oldest mark) and was never marked.
    expect(ledger.noteCropRequest(60)).toBe(true)
    expect(ledger.unmarkedCrops).toBe(1)
  })

  it('never reports an unmarked crop before the first mark — an empty window answers nothing', () => {
    const ledger = new LeaseAdmissionLedger({ mode: 'inferred' })
    expect(ledger.noteCropRequest(7)).toBe(false)
    expect(ledger.unmarkedCrops).toBe(0)
  })
})
