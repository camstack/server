/**
 * R1 — which detection sensors a camera gets, and why a class never vanishes
 * on one read (D49).
 */
import { describe, expect, it } from 'vitest'
import {
  CLASS_REMOVAL_CONFIRM_MS,
  DetectionClassSource,
  detectionClassesOfKinds,
  type EventKindLike,
  type StoredDetectionClassMap,
} from '../detection-sensors/detection-classes.js'
import { quietLogger } from './helpers/fake-device-api.js'

const macro = (kind: string, category = 'detection'): EventKindLike => ({
  kind,
  level: 'macro',
  category,
})

describe('detectionClassesOfKinds', () => {
  it('keeps detection and package macros, never subs, motion or sensors', () => {
    expect(
      detectionClassesOfKinds([
        macro('motion', 'motion'),
        macro('person'),
        { kind: 'car', level: 'sub', category: 'detection' },
        macro('vehicle'),
        macro('package', 'package'),
        macro('door', 'sensor'),
      ]),
    ).toEqual(['person', 'vehicle', 'package'])
  })
})

describe('DetectionClassSource', () => {
  function harness(initial: StoredDetectionClassMap = {}) {
    let kinds: readonly EventKindLike[] = [macro('person'), macro('vehicle')]
    let fail = false
    let t = 0
    let stored = initial
    const src = new DetectionClassSource({
      readEventKinds: async () => {
        if (fail) throw new Error('down')
        return kinds
      },
      getStored: () => stored,
      setStored: async (next) => {
        stored = next
      },
      logger: quietLogger,
      now: () => t,
    })
    return {
      src,
      setKinds: (k: readonly EventKindLike[]) => {
        kinds = k
      },
      setFail: (v: boolean) => {
        fail = v
      },
      advance: (ms: number) => {
        t += ms
      },
      stored: () => stored,
    }
  }

  it("answers the camera's classes and remembers them", async () => {
    const h = harness()
    expect(await h.src.classesFor(1)).toEqual(['person', 'vehicle'])
    expect(h.stored()).toEqual({ 1: { classes: ['person', 'vehicle'] } })
  })

  it('a failed read answers the last known classes', async () => {
    const h = harness({ 1: { classes: ['person', 'animal'] } })
    h.setFail(true)
    expect(await h.src.classesFor(1)).toEqual(['person', 'animal'])
  })

  it('a class missing from ONE answer is kept; it goes only once missing for the confirm window', async () => {
    const h = harness({ 1: { classes: ['person', 'vehicle'] } })
    h.setKinds([macro('person')]) // e.g. the orchestrator was unreachable
    expect(await h.src.classesFor(1)).toEqual(['person', 'vehicle'])
    h.advance(CLASS_REMOVAL_CONFIRM_MS - 1)
    expect(await h.src.classesFor(1)).toEqual(['person', 'vehicle'])
    h.advance(1)
    expect(await h.src.classesFor(1)).toEqual(['person'])
  })

  it('a class that comes back cancels its pending removal', async () => {
    const h = harness({ 1: { classes: ['person', 'vehicle'] } })
    h.setKinds([macro('person')])
    await h.src.classesFor(1)
    h.setKinds([macro('person'), macro('vehicle')])
    await h.src.classesFor(1)
    h.advance(CLASS_REMOVAL_CONFIRM_MS)
    h.setKinds([macro('person')])
    expect(await h.src.classesFor(1)).toEqual(['person', 'vehicle'])
  })

  it('a new class appears at once', async () => {
    const h = harness({ 1: { classes: ['person'] } })
    h.setKinds([macro('person'), macro('animal')])
    expect(await h.src.classesFor(1)).toEqual(['person', 'animal'])
  })
})
