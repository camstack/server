import { describe, it, expect } from 'vitest'
import { qualifyObjectTrigger } from '../object-trigger.js'

const evt = (over: Record<string, unknown> = {}): unknown => ({
  deviceId: 102,
  kind: 'object',
  eventId: 'e1',
  timestamp: 1_700_000_000_000,
  source: 'pipeline',
  className: 'person',
  confidence: 0.9,
  zones: [],
  ...over,
})

describe('qualifyObjectTrigger', () => {
  it('qualifies a pipeline detection of a macro class', () => {
    expect(qualifyObjectTrigger(evt())).toEqual({
      qualified: true,
      deviceId: 102,
      macroClass: 'person',
      atMs: 1_700_000_000_000,
    })
  })

  // Rejected for months, and for a good reason: having never gone through
  // the executor, `enabledMacroClasses` and the `minConfidence<Macro>` had
  // never run on it, so recording on top of it would have been a SECOND
  // truth — the operator's sliders describing one detection and the
  // recording following another.
  //
  // The premise was removed rather than worked around: onboard boxes now
  // go through the SAME gate at ingestion (`onboardRootDetections`), so a
  // detection that arrives here has already passed the classes and thresholds chosen
  // by the operator. Cost of the rejection, measured on 640: the operator walked
  // in front of the camera, the firmware saw them for ~100 s, 11 detections out of 11
  // rejected, no recording.
  it('qualifies an onboard detection — the operator gate has already run upstream', () => {
    expect(qualifyObjectTrigger(evt({ source: 'onboard' }))).toEqual({
      qualified: true,
      deviceId: 102,
      macroClass: 'person',
      atMs: 1_700_000_000_000,
    })
  })

  // The firmware vocabulary is wider than the macro classes one
  // (`face`, `other`): that filter belongs to this module and stays.
  it('rejects an onboard class that is not a macro class', () => {
    expect(qualifyObjectTrigger(evt({ source: 'onboard', className: 'face' }))).toMatchObject({
      qualified: false,
      reason: 'not-a-macro',
    })
  })

  it('treats an absent source as pipeline — legacy rows have none', () => {
    const legacy: Record<string, unknown> = { ...(evt() as Record<string, unknown>) }
    delete legacy['source']
    expect(qualifyObjectTrigger(legacy)).toMatchObject({ qualified: true })
  })

  it('rejects a kind that is not object (audio, package) on the same topic', () => {
    expect(qualifyObjectTrigger(evt({ kind: 'audio' }))).toEqual({
      qualified: false,
      reason: 'not-object',
      deviceId: 102,
    })
  })

  it('rejects a className that is not one of the three macros', () => {
    // E.g. `package`, or a row written before preserveOriginal was false.
    expect(qualifyObjectTrigger(evt({ className: 'package' }))).toEqual({
      qualified: false,
      reason: 'not-a-macro',
      deviceId: 102,
    })
  })

  it('normalizes whitespace and case before deciding', () => {
    expect(qualifyObjectTrigger(evt({ className: ' Person ' }))).toMatchObject({
      qualified: true,
      macroClass: 'person',
    })
  })

  it('rejects a malformed payload instead of crashing the subscription', () => {
    expect(qualifyObjectTrigger(null)).toEqual({ qualified: false, reason: 'malformed' })
    expect(qualifyObjectTrigger({ deviceId: '102' })).toEqual({
      qualified: false,
      reason: 'malformed',
    })
  })

  it('rejects a non-finite timestamp — a window opened at NaN never expires', () => {
    expect(qualifyObjectTrigger(evt({ timestamp: Number.NaN }))).toEqual({
      qualified: false,
      reason: 'malformed',
    })
  })
})

/**
 * THE DEFECT OF 2026-08-29, in test form.
 *
 * The topic is shared by three emitters and ONLY the object branch carries
 * `className`. The guard demanded `className` from every payload, so every
 * motion and audio event came out `malformed` — 394 rows out of 394, at 3.3–3.9/s —
 * saturating the only bucket that could signal a protocol break.
 *
 * Note that the `evt()` fixture above could NOT catch the defect: it always
 * carries `className`, even when it pretends to be an audio event. That is
 * exactly how a validator tested only against its author's fixture
 * survives broken.
 */
describe('the topic is discriminated on kind — motion and audio have no className', () => {
  const motion: unknown = {
    deviceId: 101,
    kind: 'motion',
    eventId: 'm1',
    timestamp: 1_700_000_000_000,
  }
  const audio: unknown = {
    deviceId: 101,
    kind: 'audio',
    eventId: 'a1',
    timestamp: 1_700_000_000_000,
  }

  it('classifies a motion event (without className) as not-object, NEVER malformed', () => {
    expect(qualifyObjectTrigger(motion)).toEqual({
      qualified: false,
      reason: 'not-object',
      deviceId: 101,
    })
  })

  it('classifies an audio event (without className) as not-object, NEVER malformed', () => {
    expect(qualifyObjectTrigger(audio)).toEqual({
      qualified: false,
      reason: 'not-object',
      deviceId: 101,
    })
  })

  it('an object event WITHOUT className remains a defect, but names the camera', () => {
    const broken: Record<string, unknown> = { ...(evt() as Record<string, unknown>) }
    delete broken['className']
    expect(qualifyObjectTrigger(broken)).toEqual({
      qualified: false,
      reason: 'malformed-object',
      deviceId: 102,
    })
  })

  it('malformed is reserved for the ENVELOPE: no deviceId, because none is known', () => {
    const v = qualifyObjectTrigger({ kind: 'object', timestamp: 1, className: 'person' })
    expect(v).toEqual({ qualified: false, reason: 'malformed' })
    expect('deviceId' in v).toBe(false)
  })
})
