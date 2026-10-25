/**
 * D549 decision 20 as a table: a native Reolink record type reaches the
 * operator's OWN filter vocabulary, an unknown type stays `unknown:<raw>` and
 * stays VISIBLE, and the raw strings always travel beside the mapping.
 *
 * The vocabulary is read from the captured wire (design § 3b), not invented:
 * the app's filter is `md, pir, other, package, io, people, face, vehicle,
 * dog_cat, visitor, cry, crossline, intrude, loitering, legacy, loss, answer,
 * nonmotorveh, tamper, lmsg` plus `manual, sched, intrusion, IPCInputOutput`
 * on `recordType`.
 */
import { describe, expect, it } from 'vitest'
import { classifyNativeTypes, parseNativeTypes } from '../clips/clip-native-types.js'

describe('parseNativeTypes', () => {
  it('splits the recordType CSV the file carries', () => {
    expect(parseNativeTypes('md,people')).toEqual(['md', 'people'])
  })

  it('trims, lowercases nothing it cannot and drops empties', () => {
    // `IPCInputOutput` is mixed case on the wire; the raw string is preserved.
    expect(parseNativeTypes(' md , ,IPCInputOutput ')).toEqual(['md', 'IPCInputOutput'])
  })

  it('answers an empty list for a camera that sent no type at all', () => {
    // Measured: a hub child's files carry `recordType none`, 592 carries `sched`.
    expect(parseNativeTypes(undefined)).toEqual([])
    expect(parseNativeTypes('')).toEqual([])
  })

  it('de-duplicates without reordering', () => {
    expect(parseNativeTypes('people,md,people')).toEqual(['people', 'md'])
  })
})

describe('classifyNativeTypes', () => {
  it('maps a person, a face and a visitor onto the person macro', () => {
    expect(classifyNativeTypes(['people']).labels).toEqual(['person'])
    expect(classifyNativeTypes(['face']).labels).toEqual(['person'])
    expect(classifyNativeTypes(['visitor']).labels).toEqual(['person'])
  })

  it('carries doorbell beside person for a visitor, never instead of it', () => {
    const out = classifyNativeTypes(['visitor'])
    expect(out.labels).toEqual(['person'])
    expect(out.behaviours).toEqual(['doorbell'])
  })

  it('maps the vehicle family, keeping nonmotorveh raw as well', () => {
    expect(classifyNativeTypes(['vehicle']).labels).toEqual(['vehicle'])
    const bike = classifyNativeTypes(['nonmotorveh'])
    expect(bike.labels).toEqual(['vehicle'])
    expect(bike.nativeTypes).toEqual(['nonmotorveh'])
  })

  it('maps dog_cat onto animal, as the live box mapping already does', () => {
    expect(classifyNativeTypes(['dog_cat']).labels).toEqual(['animal'])
  })

  it('treats md and pir as the built-in MOTION kind, never as a class', () => {
    const md = classifyNativeTypes(['md'])
    expect(md.labels).toEqual([])
    expect(md.kind).toBe('motion')
    const pir = classifyNativeTypes(['pir'])
    expect(pir.labels).toEqual([])
    expect(pir.kind).toBe('motion')
  })

  it('treats cry as the built-in AUDIO kind', () => {
    const out = classifyNativeTypes(['cry'])
    expect(out.labels).toEqual([])
    expect(out.kind).toBe('audio')
  })

  it('carries a behaviour BESIDE a class and never instead of one', () => {
    const out = classifyNativeTypes(['people', 'intrude'])
    expect(out.labels).toEqual(['person'])
    expect(out.behaviours).toEqual(['intrude'])
  })

  it('never lets a behaviour alone become a class', () => {
    const out = classifyNativeTypes(['crossline'])
    expect(out.labels).toEqual([])
    expect(out.behaviours).toEqual(['crossline'])
  })

  it('gives a recording REASON no label at all', () => {
    for (const reason of [
      'sched',
      'manual',
      'io',
      'IPCInputOutput',
      'legacy',
      'loss',
      'answer',
      'tamper',
      'lmsg',
      'other',
      'none',
    ]) {
      const out = classifyNativeTypes([reason])
      expect(out.labels, reason).toEqual([])
      expect(out.behaviours, reason).toEqual([])
      expect(out.nativeTypes, reason).toEqual([reason])
    }
  })

  it('keeps an unknown type VISIBLE as unknown:<raw>', () => {
    // A newer firmware inventing a type must not vanish — `labels` is a
    // string, not an enum, on purpose.
    const out = classifyNativeTypes(['squirrel_v2'])
    expect(out.labels).toEqual(['unknown:squirrel_v2'])
    expect(out.nativeTypes).toEqual(['squirrel_v2'])
  })

  it('keeps the dominant class first and caps labels at three', () => {
    const out = classifyNativeTypes(['md', 'people', 'vehicle', 'dog_cat', 'package'])
    expect(out.labels.length).toBeLessThanOrEqual(3)
    expect(out.labels[0]).toBe('person')
  })

  it('never emits a label twice when two natives map to one class', () => {
    expect(classifyNativeTypes(['people', 'face']).labels).toEqual(['person'])
  })

  it('is `native` in kind unless a motion/audio native says otherwise', () => {
    expect(classifyNativeTypes(['people']).kind).toBe('native')
    expect(classifyNativeTypes([]).kind).toBe('native')
    // A classified object wins over the bare "something moved".
    expect(classifyNativeTypes(['md', 'people']).kind).toBe('native')
  })

  it('carries every raw type through, in wire order', () => {
    const raw = ['md', 'people', 'squirrel_v2']
    expect(classifyNativeTypes(raw).nativeTypes).toEqual(raw)
  })
})

/**
 * `other` is the camera saying "something moved, and I will not say what".
 *
 * It was a recording REASON, so a file typed `other` alone produced no class
 * and no kind — and the viewer's card, having nothing to chip, fell back to
 * `Clip.kind`'s own value and showed the word `native`, this system's internal
 * vocabulary, to the operator.
 *
 * Measured on camera 3628 on 2026-09-21: 23 clips over 36 hours, of which 14
 * `people`, 3 `dog_cat` and **6 `other` alone** — a quarter of the list
 * chipped with an identifier. Operator's call the same day: *"ok per other
 * allora é semplice Motion"*.
 *
 * `none` is deliberately NOT included: no `recordType` at all is the camera
 * saying nothing, not the camera saying it saw movement.
 */
describe('classifyNativeTypes — `other` is motion', () => {
  it('gives a bare `other` the motion kind and no class', () => {
    const c = classifyNativeTypes(['other'])
    expect(c.kind).toBe('motion')
    expect(c.labels).toEqual([])
    expect(c.nativeTypes).toEqual(['other'])
  })

  it('lets a real class outrank it, in either wire order', () => {
    for (const types of [
      ['other', 'people'],
      ['people', 'other'],
    ]) {
      const c = classifyNativeTypes(types)
      expect(c.labels, types.join(',')).toEqual(['person'])
      expect(c.kind, types.join(',')).toBe('native')
    }
  })

  it('leaves `none` a reason — a camera that said nothing did not say motion', () => {
    const c = classifyNativeTypes(['none'])
    expect(c.kind).toBe('native')
    expect(c.labels).toEqual([])
  })

  it('leaves the other reasons alone: a scheduled file is not a movement', () => {
    for (const reason of ['sched', 'manual', 'io', 'tamper']) {
      expect(classifyNativeTypes([reason]).kind, reason).toBe('native')
    }
  })
})
