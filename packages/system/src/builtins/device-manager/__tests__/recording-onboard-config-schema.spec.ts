/**
 * `recording-onboard` derived form.
 *
 * The two rules this file exists to hold are the ones a green suite
 * would otherwise let rot:
 *
 *   - a field this camera cannot write is still RENDERED, disabled, with
 *     its reason readable — never hidden, because a hidden control is
 *     indistinguishable from a feature that was never built;
 *   - the schedule is ONE form key, so a single-field save carries the
 *     complete window set and cannot half-apply.
 */
import { describe, expect, it } from 'vitest'
import type { ConfigField, RecordingOnboardOptions, RecordingOnboardStatus } from '@camstack/types'
import {
  RECORDING_ONBOARD_KEYS,
  buildRecordingOnboardConfigSchema,
  parseRecordingOnboardFormPatch,
} from '../recording-onboard-config-schema.js'
import {
  RECORDING_ONBOARD_BUILDER_ID,
  deriveFormContribution,
  parseDerivedFormSettingsPatch,
} from '../device-config-contribution.js'

const writable = { readable: true, writable: true }

/** A Hikvision-shaped camera: minute resolution, one trigger per range. */
function hikvisionOptions(): RecordingOnboardOptions {
  return {
    enabled: writable,
    overwriteWhenFull: writable,
    preRecordSec: writable,
    preRecordSecRange: { min: 0, max: 30, step: 1 },
    postRecordSec: writable,
    postRecordSecRange: { min: 0, max: 60, step: 1 },
    segmentMinutes: {
      readable: false,
      writable: false,
      reason: 'the firmware does not expose a file length',
    },
    schedule: {
      support: writable,
      granularityMinutes: 1,
      triggers: ['continuous', 'motion'],
      supportsOverlappingTriggers: false,
    },
  }
}

/** 1436 as measured: a card, two tracks, motion all week on the primary. */
function status(overrides: Partial<RecordingOnboardStatus> = {}): RecordingOnboardStatus {
  return {
    storage: {
      kind: 'present',
      volumes: [
        {
          id: '1',
          label: 'hdde',
          status: 'ok',
          capacityMb: 238800,
          freeMb: 11776,
          writable: true,
        },
      ],
    },
    tracks: [
      {
        id: '101',
        enabled: true,
        isVideo: true,
        codec: 'H.265',
        resolution: '3840x2160',
        overwriteWhenFull: true,
      },
      {
        id: '103',
        enabled: true,
        isVideo: true,
        codec: 'H.265',
        resolution: '3840x2160',
        overwriteWhenFull: false,
      },
    ],
    primaryTrackId: '101',
    enabled: true,
    overwriteWhenFull: true,
    preRecordSec: 10,
    postRecordSec: 10,
    segmentMinutes: null,
    windows: [{ trigger: 'motion', day: 0, startMinute: 0, endMinute: 1440 }],
    unreadableWindows: 0,
    recordingToNowhere: false,
    lastFetchedAt: 1,
    ...overrides,
  }
}

function fieldsOf(
  options: RecordingOnboardOptions,
  state: RecordingOnboardStatus | null,
): Map<string, ConfigField> {
  const schema = buildRecordingOnboardConfigSchema(options, state)
  if (!schema) throw new Error('expected a schema')
  const out = new Map<string, ConfigField>()
  for (const section of schema.sections) {
    for (const field of section.fields) out.set(field.key, field)
  }
  return out
}

describe('the form is built for every camera, whatever it can do', () => {
  it('always produces both sections, even before the camera has been read', () => {
    const schema = buildRecordingOnboardConfigSchema(hikvisionOptions(), null)
    expect(schema?.sections.map((s) => s.id)).toEqual([
      'recording-onboard-storage',
      'recording-onboard-recording',
    ])
  })

  it('says "not read yet" rather than "no storage" for a camera never reached', () => {
    const banner = fieldsOf(hikvisionOptions(), null).get(RECORDING_ONBOARD_KEYS.storageBanner)
    expect(banner).toMatchObject({ type: 'info', variant: 'info' })
    expect(JSON.stringify(banner)).toContain('Not read from the camera yet')
  })

  it('renders EVERY field on a camera that can write almost none of them', () => {
    const crippled: RecordingOnboardOptions = {
      ...hikvisionOptions(),
      enabled: { readable: true, writable: false, reason: 'no verified setter' },
      overwriteWhenFull: { readable: true, writable: false, reason: 'no verified setter' },
      preRecordSec: { readable: true, writable: false, reason: 'no verified setter' },
      postRecordSec: { readable: true, writable: false, reason: 'no verified setter' },
      schedule: {
        support: { readable: true, writable: false, reason: 'no verified setter' },
        granularityMinutes: 60,
        triggers: ['motion'],
        supportsOverlappingTriggers: true,
      },
    }
    const fields = fieldsOf(crippled, status())
    for (const key of [
      RECORDING_ONBOARD_KEYS.enabled,
      RECORDING_ONBOARD_KEYS.overwriteWhenFull,
      RECORDING_ONBOARD_KEYS.preRecordSec,
      RECORDING_ONBOARD_KEYS.postRecordSec,
      RECORDING_ONBOARD_KEYS.segmentMinutes,
      RECORDING_ONBOARD_KEYS.windows,
    ]) {
      const field = fields.get(key)
      expect(field, `${key} must still be rendered`).toBeDefined()
      expect(field).toMatchObject({ disabled: true })
      expect(JSON.stringify(field), `${key} must say WHY it is disabled`).toContain(
        'Read-only on this camera:',
      )
    }
    // The reason is the camera's own, not a generic one: `segmentMinutes`
    // was already unwritable in the base options and keeps ITS sentence.
    expect(JSON.stringify(fields.get(RECORDING_ONBOARD_KEYS.enabled))).toContain(
      'no verified setter',
    )
    expect(JSON.stringify(fields.get(RECORDING_ONBOARD_KEYS.segmentMinutes))).toContain(
      'the firmware does not expose a file length',
    )
  })

  it('leaves a writable field enabled and seeds it from the camera', () => {
    const fields = fieldsOf(hikvisionOptions(), status())
    expect(fields.get(RECORDING_ONBOARD_KEYS.preRecordSec)).toMatchObject({
      disabled: false,
      default: 10,
    })
  })

  it('does not seed an unanswered value as a number the operator could save back', () => {
    const fields = fieldsOf(hikvisionOptions(), status({ preRecordSec: null }))
    expect(fields.get(RECORDING_ONBOARD_KEYS.preRecordSec)).toMatchObject({ default: 0 })
    // …and the control that has no reading is the one the camera cannot
    // write either, so it is disabled rather than inviting that save.
    expect(fields.get(RECORDING_ONBOARD_KEYS.segmentMinutes)).toMatchObject({ disabled: true })
  })
})

describe('the storage half tells the truth about the card', () => {
  it('raises a DANGER banner for a camera recording to a card that is not there', () => {
    const fields = fieldsOf(
      hikvisionOptions(),
      status({
        storage: {
          kind: 'absent',
          reason: 'The camera reports no storage device (empty hddList).',
        },
        recordingToNowhere: true,
      }),
    )
    const banner = fields.get(RECORDING_ONBOARD_KEYS.storageBanner)
    expect(banner).toMatchObject({ variant: 'danger' })
    expect(JSON.stringify(banner)).toContain('no usable storage')
  })

  it('never renders an unreadable card as an empty one', () => {
    const fields = fieldsOf(
      hikvisionOptions(),
      status({ storage: { kind: 'unknown', reason: 'connect ETIMEDOUT' } }),
    )
    expect(JSON.stringify(fields.get(RECORDING_ONBOARD_KEYS.storageBanner))).toContain(
      'unknown — not empty',
    )
  })

  it('lists both tracks and marks which one the write path targets', () => {
    const tracks = fieldsOf(hikvisionOptions(), status()).get(RECORDING_ONBOARD_KEYS.tracks)
    expect(tracks).toMatchObject({ type: 'object-array' })
    expect(JSON.stringify(tracks)).toContain('"id":"103"')
    expect(JSON.stringify(tracks)).toContain('"primary":"yes"')
  })

  it('never offers the frame rate these cameras declare, because it is wrong', () => {
    const tracks = fieldsOf(hikvisionOptions(), status()).get(RECORDING_ONBOARD_KEYS.tracks)
    expect(JSON.stringify(tracks)).not.toContain('framerate')
  })
})

describe('the schedule is one field, so one save carries all of it', () => {
  it('renders the camera windows as rows of a single editable array', () => {
    const field = fieldsOf(hikvisionOptions(), status()).get(RECORDING_ONBOARD_KEYS.windows)
    expect(field).toMatchObject({ type: 'editable-array' })
    expect(JSON.stringify(field)).toContain('"trigger":"motion"')
  })

  it('offers only the triggers this camera can record on', () => {
    const field = fieldsOf(hikvisionOptions(), status()).get(RECORDING_ONBOARD_KEYS.windows)
    const json = JSON.stringify(field)
    expect(json).toContain('"value":"motion"')
    expect(json).not.toContain('"value":"loitering"')
  })

  it("offers times at the camera's own step when that step is coarse", () => {
    const reolinkish: RecordingOnboardOptions = {
      ...hikvisionOptions(),
      schedule: {
        support: writable,
        granularityMinutes: 60,
        triggers: ['motion'],
        supportsOverlappingTriggers: true,
      },
    }
    const json = JSON.stringify(fieldsOf(reolinkish, status()).get(RECORDING_ONBOARD_KEYS.windows))
    expect(json).toContain('"label":"01:00"')
    expect(json).not.toContain('"label":"01:15"')
    expect(json).toContain('"label":"24:00"')
  })

  it('parses a complete window set back out of one key', () => {
    const parsed = parseRecordingOnboardFormPatch({
      [RECORDING_ONBOARD_KEYS.windows]: [
        { trigger: 'motion', day: '0', startMinute: '0', endMinute: '1440' },
        { trigger: 'continuous', day: '6', startMinute: '360', endMinute: '1080' },
      ],
    })
    expect(parsed).toEqual({
      windows: [
        { trigger: 'motion', day: 0, startMinute: 0, endMinute: 1440 },
        { trigger: 'continuous', day: 6, startMinute: 360, endMinute: 1080 },
      ],
    })
  })

  it('drops a row that is not a window instead of inventing one', () => {
    const parsed = parseRecordingOnboardFormPatch({
      [RECORDING_ONBOARD_KEYS.windows]: [
        { trigger: 'nonsense', day: '0', startMinute: '0', endMinute: '60' },
        { trigger: 'motion', day: '0', startMinute: '0', endMinute: '60' },
      ],
    })
    expect(parsed.windows).toEqual([{ trigger: 'motion', day: 0, startMinute: 0, endMinute: 60 }])
  })

  it('carries only the keys the patch actually had', () => {
    expect(parseRecordingOnboardFormPatch({ [RECORDING_ONBOARD_KEYS.preRecordSec]: '7' })).toEqual({
      preRecordSec: 7,
    })
  })
})

describe('registration in the builderId registry', () => {
  it('is reachable through deriveFormContribution, not only directly', () => {
    const derived = deriveFormContribution(
      RECORDING_ONBOARD_BUILDER_ID,
      hikvisionOptions(),
      status(),
    )
    expect(derived?.sections.map((s) => s.id)).toEqual([
      'recording-onboard-storage',
      'recording-onboard-recording',
    ])
  })

  it('is a settings-based reducer, so the save path parses rather than fans out', () => {
    expect(
      parseDerivedFormSettingsPatch(RECORDING_ONBOARD_BUILDER_ID, {
        [RECORDING_ONBOARD_KEYS.enabled]: true,
      }),
    ).toEqual({ enabled: true })
  })
})

describe('an allowed SET renders a select, and beats the range', () => {
  /** 1436 (I91DN) as measured: pre-record is a set with a no-limit member. */
  function withAllowed(): RecordingOnboardOptions {
    return {
      ...hikvisionOptions(),
      preRecordSecAllowed: {
        values: [0, 5, 10, 15, 20, 25, 30, 2147483647],
        sentinel: { value: 2147483647, meaning: 'no-limit' },
      },
      postRecordSecAllowed: { values: [5, 10, 30, 60, 120, 300, 600] },
    }
  }

  it('renders a select even though a RANGE is also present', () => {
    // Both are declared on purpose here: the cap says the set wins, and
    // before this the builder read only the range — the set was
    // declared by two providers and rendered by nobody.
    const field = fieldsOf(withAllowed(), status()).get(RECORDING_ONBOARD_KEYS.preRecordSec)
    expect(field?.type).toBe('select')
    expect(field && 'options' in field ? field.options?.map((o) => o.value) : []).toEqual([
      '0',
      '5',
      '10',
      '15',
      '20',
      '25',
      '30',
      '2147483647',
    ])
  })

  it('names the sentinel instead of printing two billion seconds', () => {
    const field = fieldsOf(withAllowed(), status()).get(RECORDING_ONBOARD_KEYS.preRecordSec)
    const labels = field && 'options' in field ? (field.options ?? []) : []
    expect(labels.find((o) => o.value === '2147483647')?.label).toBe('No limit')
    expect(labels.find((o) => o.value === '0')?.label).toBe('Off')
  })

  it('reads whole minutes back the way the vendor UI offers them', () => {
    const field = fieldsOf(withAllowed(), status()).get(RECORDING_ONBOARD_KEYS.postRecordSec)
    const labels = field && 'options' in field ? (field.options ?? []) : []
    expect(labels.map((o) => o.label)).toEqual([
      '5 s',
      '10 s',
      '30 s',
      '1 min',
      '2 min',
      '5 min',
      '10 min',
    ])
  })

  it('keeps a stored value the camera holds outside its own offer', () => {
    // A firmware that stores something outside the set it advertises is
    // exactly what these sets were measured against. Dropping to the
    // first member would misreport the camera, and a save of an
    // untouched form would then rewrite it.
    const field = fieldsOf(withAllowed(), status({ preRecordSec: 8 })).get(
      RECORDING_ONBOARD_KEYS.preRecordSec,
    )
    expect(field && 'default' in field ? field.default : null).toBe('8')
    const labels = field && 'options' in field ? (field.options ?? []) : []
    expect(labels.map((o) => o.value)).toContain('8')
  })

  it('still parses the select back into a number patch', () => {
    const patch = parseRecordingOnboardFormPatch({
      [RECORDING_ONBOARD_KEYS.preRecordSec]: '15',
    })
    expect(patch.preRecordSec).toBe(15)
  })

  it('falls back to the number input when the camera stated no set', () => {
    const field = fieldsOf(hikvisionOptions(), status()).get(RECORDING_ONBOARD_KEYS.preRecordSec)
    expect(field?.type).toBe('number')
  })
})
