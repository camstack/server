/**
 * D379 — the evidence a birth arrived with survives its DEFERRAL, in a reserve
 * that belongs to its camera alone.
 *
 * The number that matters: measured over three hours on the live hub across 20
 * cameras, the busiest (`hall`, 369 gate verdicts) held at most FIVE distinct
 * birth candidates in any 4 s window. Eight slots is that worst case with
 * margin, and it is a RESERVE — no camera can take another's.
 */
import { describe, expect, it } from 'vitest'
import {
  BIRTH_EVIDENCE_SLOTS_PER_CAMERA,
  BIRTH_EVIDENCE_TTL_MS,
  BirthEvidenceStore,
} from '../birth-evidence-store.js'

const crop = (n: number): Buffer => Buffer.from([0xff, 0xd8, n])

describe('BirthEvidenceStore', () => {
  it('hands back the crop a birth arrived with, on a later frame', () => {
    const store = new BirthEvidenceStore()
    store.remember('101', 't1', crop(1), 1_000)
    expect(store.get('101', 't1', 1_500)).toEqual(crop(1))
  })

  it('forgets a crop older than the deferral it exists to cover', () => {
    const store = new BirthEvidenceStore()
    store.remember('101', 't1', crop(1), 1_000)
    expect(store.get('101', 't1', 1_000 + BIRTH_EVIDENCE_TTL_MS + 1)).toBeNull()
  })

  it('reserves per CAMERA: a busy camera can never evict a quiet one', () => {
    // The defect this replaces was exactly this shape at node level — one
    // shared 4 096-entry LRU, pinned full 99% of the time, in which adding a
    // camera shrank every other camera's window.
    const store = new BirthEvidenceStore()
    store.remember('quiet', 'q1', crop(9), 1_000)
    for (let i = 0; i < BIRTH_EVIDENCE_SLOTS_PER_CAMERA * 4; i += 1) {
      store.remember('busy', `b${i}`, crop(i), 1_000 + i)
    }
    expect(store.get('quiet', 'q1', 1_100)).toEqual(crop(9))
  })

  it('evicts by AGE inside a camera’s own quota — the oldest candidate goes first', () => {
    const store = new BirthEvidenceStore()
    for (let i = 0; i < BIRTH_EVIDENCE_SLOTS_PER_CAMERA + 2; i += 1) {
      store.remember('101', `t${i}`, crop(i), 1_000 + i)
    }
    expect(store.get('101', 't0', 1_100)).toBeNull()
    expect(store.get('101', 't1', 1_100)).toBeNull()
    expect(store.get('101', `t${BIRTH_EVIDENCE_SLOTS_PER_CAMERA + 1}`, 1_100)).not.toBeNull()
    expect(store.size('101')).toBe(BIRTH_EVIDENCE_SLOTS_PER_CAMERA)
  })

  it('holds at most the reserve per camera, so the global cost is slots x cameras', () => {
    const store = new BirthEvidenceStore()
    for (const device of ['101', '102', '108']) {
      for (let i = 0; i < 40; i += 1) store.remember(device, `t${i}`, crop(i), 1_000 + i)
    }
    expect(store.size('101')).toBe(BIRTH_EVIDENCE_SLOTS_PER_CAMERA)
    expect(store.size('102')).toBe(BIRTH_EVIDENCE_SLOTS_PER_CAMERA)
    expect(store.size('108')).toBe(BIRTH_EVIDENCE_SLOTS_PER_CAMERA)
  })

  it('drops a resolved birth immediately — a decided id is dead weight', () => {
    const store = new BirthEvidenceStore()
    store.remember('101', 't1', crop(1), 1_000)
    store.resolve('101', 't1')
    expect(store.get('101', 't1', 1_010)).toBeNull()
  })

  it('forgets every id the tracker is no longer carrying', () => {
    const store = new BirthEvidenceStore()
    store.remember('101', 't1', crop(1), 1_000)
    store.remember('101', 't2', crop(2), 1_000)
    store.retain('101', new Set(['t2']))
    expect(store.get('101', 't1', 1_010)).toBeNull()
    expect(store.get('101', 't2', 1_010)).not.toBeNull()
  })

  it('drops a camera wholesale', () => {
    const store = new BirthEvidenceStore()
    store.remember('101', 't1', crop(1), 1_000)
    store.clearDevice('101')
    expect(store.get('101', 't1', 1_010)).toBeNull()
    expect(store.size('101')).toBe(0)
  })

  it('keeps the FIRST crop for an id — a re-offer must not overwrite the birth instant', () => {
    // The whole point is the instant the birth was measured on. A later frame's
    // crop of the same track is a different instant, which is the very thing
    // the fallback asymmetry exists to distrust.
    const store = new BirthEvidenceStore()
    store.remember('101', 't1', crop(1), 1_000)
    store.remember('101', 't1', crop(2), 1_200)
    expect(store.get('101', 't1', 1_300)).toEqual(crop(1))
  })

  it('reports the bytes it holds, so the declared budget can be checked', () => {
    const store = new BirthEvidenceStore()
    store.remember('101', 't1', Buffer.alloc(1024), 1_000)
    store.remember('102', 't1', Buffer.alloc(2048), 1_000)
    expect(store.totalBytes()).toBe(3072)
  })
})
