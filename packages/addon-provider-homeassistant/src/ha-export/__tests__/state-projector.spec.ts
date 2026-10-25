import { describe, expect, it } from 'vitest'
import type { StateValue } from '../state-projector.js'
import {
  macroOf,
  projectBatterySlice,
  projectNetworkLinkSlice,
  projectCameraFunctions,
  projectCameraStatus,
  projectCapSlice,
  projectDeviceStatus,
  projectMotion,
  projectTrackLifecycle,
  projectZoneOccupancy,
  projectDoorbellSlice,
  projectAudioWindow,
} from '../state-projector.js'
import {
  buildCameraPlan,
  buildDerivedPlan,
  CAMERA_DERIVED_CAPS,
  CAP_ENTITY_MAP,
  capEntities,
  type CapEntityDescriptor,
} from '../entity-catalog.js'
import { toComponentKey } from '../topics.js'
import type { CatalogDevice } from '../types.js'

const KEY = 'camstack-reolink-101'

function at(values: readonly StateValue[], topic: string): string | undefined {
  return values.find((v) => v.topic === topic)?.value
}

describe('macroOf', () => {
  it('maps a fine COCO class onto its macro', () => {
    expect(macroOf('car')).toBe('vehicle')
    expect(macroOf('dog')).toBe('animal')
  })

  it('passes a macro through unchanged', () => {
    expect(macroOf('person')).toBe('person')
    expect(macroOf('motion')).toBe('motion')
  })

  it('returns null for a class with no macro rather than guessing', () => {
    expect(macroOf('toothbrush')).toBeNull()
  })
})

describe('device status', () => {
  it('projects online as a string boolean', () => {
    expect(at(projectDeviceStatus(KEY, true), 'camstack/camstack-reolink-101/online')).toBe('true')
    expect(at(projectDeviceStatus(KEY, false), 'camstack/camstack-reolink-101/online')).toBe(
      'false',
    )
  })
})

describe('motion', () => {
  it('raises motion_detected and triggered together', () => {
    const values = projectMotion(KEY, { detected: true, timestamp: 1_770_000_000_000 })
    expect(at(values, 'camstack/camstack-reolink-101/motion_detected')).toBe('true')
    expect(at(values, 'camstack/camstack-reolink-101/triggered')).toBe('true')
  })

  it('stamps last_detection as an ISO timestamp HA can parse', () => {
    const values = projectMotion(KEY, { detected: true, timestamp: 1_770_000_000_000 })
    const stamp = at(values, 'camstack/camstack-reolink-101/motion_last_detection')
    expect(stamp).toBe(new Date(1_770_000_000_000).toISOString())
  })

  it('does NOT stamp a timestamp when motion clears', () => {
    const values = projectMotion(KEY, { detected: false, timestamp: 1_770_000_000_000 })
    expect(at(values, 'camstack/camstack-reolink-101/motion_detected')).toBe('false')
    expect(at(values, 'camstack/camstack-reolink-101/motion_last_detection')).toBeUndefined()
  })

  // A `null` timestamp means the caller already decided the source had no
  // plausible instant to report (a placeholder, or a seeded "known value,
  // unknown change time" stamp) — projectMotion must not publish a stamp
  // it was told is not trustworthy, even while `detected` is true.
  it('does NOT stamp a timestamp when the caller reports it as unknown', () => {
    const values = projectMotion(KEY, { detected: true, timestamp: null })
    expect(at(values, 'camstack/camstack-reolink-101/motion_detected')).toBe('true')
    expect(at(values, 'camstack/camstack-reolink-101/motion_last_detection')).toBeUndefined()
  })
})

describe('identification occurrence stamp', () => {
  const track = {
    deviceId: 101,
    trackId: 't1',
    phase: 'update' as const,
    classes: ['person'],
    bestClassName: 'person',
    bestConfidence: 0.9,
    lastSeen: 1_770_000_000_000,
    zonesVisited: [],
  }

  it('stamps person_last_label_at with the event time whenever a label rides', () => {
    const values = projectTrackLifecycle(KEY, { ...track, label: 'Alice' }, null)
    expect(at(values, 'camstack/camstack-reolink-101/person_last_label_at')).toBe(
      new Date(1_770_000_000_000).toISOString(),
    )
  })

  it('moves the stamp on a SECOND occurrence of the SAME label', () => {
    // The push client dedups per topic, so an unchanged `person_last_label`
    // never reaches Home Assistant again — the stamp is the value that always
    // moves, and it is the entity an automation binds its trigger to.
    const again = projectTrackLifecycle(
      KEY,
      { ...track, trackId: 't2', label: 'Alice', lastSeen: 1_770_000_060_000 },
      null,
    )
    expect(at(again, 'camstack/camstack-reolink-101/person_last_label_at')).toBe(
      new Date(1_770_000_060_000).toISOString(),
    )
  })

  it('orders the label value BEFORE its stamp so a stamp trigger reads the fresh label', () => {
    const values = projectTrackLifecycle(KEY, { ...track, label: 'Alice' }, null)
    const li = values.findIndex((v) => v.topic.endsWith('person_last_label'))
    const ai = values.findIndex((v) => v.topic.endsWith('person_last_label_at'))
    expect(li).toBeGreaterThanOrEqual(0)
    expect(ai).toBeGreaterThan(li)
  })

  it('stamps the vehicle occurrence for a read plate', () => {
    const values = projectTrackLifecycle(
      KEY,
      { ...track, bestClassName: 'car', classes: ['car'], plateText: 'AB123CD' },
      null,
    )
    expect(at(values, 'camstack/camstack-reolink-101/vehicle_last_label_at')).toBe(
      new Date(1_770_000_000_000).toISOString(),
    )
  })

  it('emits NO stamp when no identification rides the event', () => {
    const values = projectTrackLifecycle(KEY, track, null)
    expect(values.some((v) => v.topic.endsWith('_last_label_at'))).toBe(false)
  })
})

describe('track lifecycle', () => {
  const track = {
    deviceId: 101,
    trackId: 't1',
    phase: 'start' as const,
    classes: ['person'],
    bestClassName: 'person',
    bestConfidence: 0.9,
    lastSeen: 1_770_000_000_000,
    zonesVisited: ['z-drive'],
  }

  it('raises the macro detector, the global triggered flag and both timestamps', () => {
    const values = projectTrackLifecycle(KEY, track, null)
    expect(at(values, 'camstack/camstack-reolink-101/person_detected')).toBe('true')
    expect(at(values, 'camstack/camstack-reolink-101/triggered')).toBe('true')
    expect(at(values, 'camstack/camstack-reolink-101/person_last_detection')).toBe(
      new Date(1_770_000_000_000).toISOString(),
    )
    expect(at(values, 'camstack/camstack-reolink-101/last_detection')).toBe(
      new Date(1_770_000_000_000).toISOString(),
    )
  })

  it('lowers the detector when the track ends', () => {
    const values = projectTrackLifecycle(KEY, { ...track, phase: 'end' }, null)
    expect(at(values, 'camstack/camstack-reolink-101/person_detected')).toBe('false')
    expect(at(values, 'camstack/camstack-reolink-101/triggered')).toBe('false')
  })

  it('projects the recognised identity onto last_label', () => {
    const values = projectTrackLifecycle(KEY, { ...track, label: 'Alice' }, null)
    expect(at(values, 'camstack/camstack-reolink-101/person_last_label')).toBe('Alice')
  })

  it('projects a plate onto the vehicle label', () => {
    const values = projectTrackLifecycle(
      KEY,
      { ...track, bestClassName: 'car', classes: ['car'], plateText: 'AB123CD' },
      null,
    )
    expect(at(values, 'camstack/camstack-reolink-101/vehicle_last_label')).toBe('AB123CD')
  })

  it('emits NO label topic for a macro that has no identification', () => {
    const values = projectTrackLifecycle(
      KEY,
      { ...track, bestClassName: 'package', classes: ['package'], label: 'nonsense' },
      null,
    )
    expect(values.some((v) => v.topic.endsWith('package_last_label'))).toBe(false)
  })

  it('projects the media URL onto the image entities, global and per macro', () => {
    const values = projectTrackLifecycle(KEY, track, 'https://hub/img?sig=abc')
    expect(at(values, 'camstack/camstack-reolink-101/last_image')).toBe('https://hub/img?sig=abc')
    expect(at(values, 'camstack/camstack-reolink-101/person_last_image')).toBe(
      'https://hub/img?sig=abc',
    )
  })

  it('projects every zone the track visited', () => {
    const values = projectTrackLifecycle(KEY, track, null)
    expect(at(values, 'camstack/camstack-reolink-101/z_drive_person_detected')).toBe('true')
    expect(at(values, 'camstack/camstack-reolink-101/z_drive_person_last_detection')).toBe(
      new Date(1_770_000_000_000).toISOString(),
    )
  })

  it('drops a track whose class has no macro rather than inventing one', () => {
    const values = projectTrackLifecycle(
      KEY,
      { ...track, bestClassName: 'toothbrush', classes: ['toothbrush'] },
      null,
    )
    expect(values).toHaveLength(0)
  })
})

describe('zone occupancy', () => {
  it('projects a per-zone per-macro count and its detected flag', () => {
    const values = projectZoneOccupancy(KEY, {
      zones: [{ zoneId: 'z-drive', totalObjects: 3, byClass: { person: 2, car: 1 } }],
    })
    expect(at(values, 'camstack/camstack-reolink-101/z_drive_person_objects')).toBe('2')
    expect(at(values, 'camstack/camstack-reolink-101/z_drive_vehicle_objects')).toBe('1')
    expect(at(values, 'camstack/camstack-reolink-101/z_drive_animal_objects')).toBe('0')
  })

  it('reports zero rather than going silent when a zone empties', () => {
    const values = projectZoneOccupancy(KEY, {
      zones: [{ zoneId: 'z-drive', totalObjects: 0, byClass: {} }],
    })
    expect(at(values, 'camstack/camstack-reolink-101/z_drive_person_objects')).toBe('0')
  })
})

describe('network link', () => {
  it('projects the link type and a wireless signal', () => {
    const values = projectNetworkLinkSlice(KEY, { type: 'wifi', signalPercent: 75 })
    expect(at(values, 'camstack/camstack-reolink-101/link')).toBe('wifi')
    expect(at(values, 'camstack/camstack-reolink-101/signal')).toBe('75')
  })

  it('publishes no signal for a wired link — a wire has none, and 0 % would read as dead', () => {
    const values = projectNetworkLinkSlice(KEY, { type: 'ethernet', signalPercent: null })
    expect(at(values, 'camstack/camstack-reolink-101/link')).toBe('ethernet')
    expect(values.some((v) => v.topic.endsWith('/signal'))).toBe(false)
  })

  it('publishes NOTHING for an unknown link — not read yet is not a link', () => {
    expect(projectNetworkLinkSlice(KEY, { type: 'unknown', signalPercent: null })).toEqual([])
  })
})

describe('battery', () => {
  it('projects percentage, charging and sleeping', () => {
    const values = projectBatterySlice(KEY, { percentage: 42, charging: 'dc', sleeping: true })
    expect(at(values, 'camstack/camstack-reolink-101/battery')).toBe('42')
    expect(at(values, 'camstack/camstack-reolink-101/charger')).toBe('true')
    expect(at(values, 'camstack/camstack-reolink-101/sleeping')).toBe('true')
  })

  it('reads charging none as not charging', () => {
    const values = projectBatterySlice(KEY, { percentage: 42, charging: 'none', sleeping: false })
    expect(at(values, 'camstack/camstack-reolink-101/charger')).toBe('false')
  })

  it('publishes no charger state when the power source is NOT YET KNOWN', () => {
    // `bool(charging !== 'none')` would turn "nobody has said" into a charger
    // plugged in — the same fabrication a 0% level was for the gauge.
    const values = projectBatterySlice(KEY, {
      percentage: 42,
      charging: 'unknown',
      sleeping: false,
    })
    expect(at(values, 'camstack/camstack-reolink-101/charger')).toBeUndefined()
    expect(at(values, 'camstack/camstack-reolink-101/battery')).toBe('42')
  })

  it('omits the percentage when the level is NOT YET KNOWN', () => {
    // A provider that has registered the cap but has no reading yet reports
    // null. `String(null)` would put the text "null" on the gauge and a 0
    // would put a flat battery there — the bug that made this field nullable:
    // every Reolink battery camera behind an NVR announced 0% on hub start.
    const values = projectBatterySlice(KEY, {
      percentage: null,
      charging: 'none',
      sleeping: false,
    })
    expect(at(values, 'camstack/camstack-reolink-101/battery')).toBeUndefined()
  })

  it('omits the percentage for a binary low-battery indicator', () => {
    const values = projectBatterySlice(KEY, {
      percentage: 0,
      charging: 'none',
      sleeping: false,
      binary: true,
    })
    expect(at(values, 'camstack/camstack-reolink-101/battery')).toBeUndefined()
  })
})

describe('camera functions', () => {
  it('projects one value per available function and none for the rest', () => {
    const values = projectCameraFunctions(KEY, [
      { id: 'recording', label: 'Recording', available: true, enabled: true },
      { id: 'notifications', label: 'Notifications', available: true, enabled: false },
      { id: 'privacy-mask', label: 'Privacy', available: false, enabled: true },
    ])
    expect(at(values, 'camstack/camstack-reolink-101/recording')).toBe('true')
    expect(at(values, 'camstack/camstack-reolink-101/notifications')).toBe('false')
    expect(values.some((v) => v.topic.endsWith('/privacy_mask'))).toBe(false)
  })
})

describe('audio_detected', () => {
  it('a window with a classification raises audio_detected', () => {
    const v = projectAudioWindow(KEY, {
      detections: [{ className: 'dog', confidence: 0.9 }],
      dbfs: -21,
    })
    expect(at(v, 'camstack/camstack-reolink-101/audio_detected')).toBe('true')
    expect(at(v, 'camstack/camstack-reolink-101/audio_last_sound')).toBe('dog')
  })

  it('a silent window lowers it, and does NOT erase the last sound', () => {
    // "what noise was that?" is asked after the noise has ended.
    const v = projectAudioWindow(KEY, { detections: [], dbfs: -70 })
    expect(at(v, 'camstack/camstack-reolink-101/audio_detected')).toBe('false')
    expect(at(v, 'camstack/camstack-reolink-101/audio_last_sound')).toBeUndefined()
  })
})

describe('camera status', () => {
  const S = (topic: string, v: readonly StateValue[]) =>
    at(v, `camstack/camstack-reolink-101/${topic}`)

  it('all good is ok', () => {
    const v = projectCameraStatus(KEY, {
      switchedOff: [],
      degradedStages: [],
      recording: { active: true },
    })
    expect(S('status', v)).toBe('ok')
    expect(S('recording_active', v)).toBe('true')
  })

  it('a function switched off by a person is switched_off, not degraded', () => {
    const v = projectCameraStatus(KEY, {
      switchedOff: ['object-detection'],
      degradedStages: [],
      recording: { active: true },
    })
    expect(S('status', v)).toBe('switched_off')
  })

  it('a stage that has not answered is degraded', () => {
    const v = projectCameraStatus(KEY, {
      switchedOff: [],
      degradedStages: ['detection'],
      recording: null,
    })
    expect(S('status', v)).toBe('degraded')
  })

  it('if the SWITCHES stage has not answered the answer is unknown, never ok', () => {
    // An empty `switchedOff` list is a POSITIVE statement only when
    // `degraded` does not name `switches`. Saying `ok` here is the D62 fault inside
    // the field that exists to prevent it.
    const v = projectCameraStatus(KEY, {
      switchedOff: [],
      degradedStages: ['switches'],
      recording: null,
    })
    expect(S('status', v)).toBe('unknown')
  })

  it('no recording block and no degraded stage: recording_active is false, a true fact', () => {
    const v = projectCameraStatus(KEY, { switchedOff: [], degradedStages: [], recording: null })
    expect(S('recording_active', v)).toBe('false')
  })

  it('no recording block and the recording stage is degraded: no value, never false', () => {
    const v = projectCameraStatus(KEY, {
      switchedOff: [],
      degradedStages: ['recording'],
      recording: null,
    })
    expect(S('recording_active', v)).toBeUndefined()
  })
})

describe('projectDoorbellSlice', () => {
  it('rings, counts, and stamps the press', () => {
    expect(
      projectDoorbellSlice(
        'camstack-cam1',
        { lastPressedAt: 1786288056692, pressCountSinceStart: 3 },
        true,
      ),
    ).toEqual([
      { topic: 'camstack/camstack-cam1/doorbell_pressed', value: 'true' },
      { topic: 'camstack/camstack-cam1/doorbell_press_count', value: '3' },
      {
        topic: 'camstack/camstack-cam1/doorbell_last_pressed',
        value: '2026-08-09T15:07:36.692Z',
      },
    ])
  })

  /**
   * The OFF edge re-publishes the SAME timestamp: it is the release of the
   * pulse, not a new press. A projection that dropped the timestamp here would
   * blank a working sensor every five seconds.
   */
  it('releases the pulse without disturbing the timestamp', () => {
    const out = projectDoorbellSlice(
      'camstack-cam1',
      { lastPressedAt: 1786288056692, pressCountSinceStart: 3 },
      false,
    )
    expect(out[0]).toEqual({ topic: 'camstack/camstack-cam1/doorbell_pressed', value: 'false' })
    expect(out).toHaveLength(3)
  })

  /**
   * `0` would render as 1 January 1970 on the operator's dashboard. An absent
   * value renders as `unknown`, which is what "never rung" actually is.
   */
  it('publishes NO timestamp when the doorbell has never been pressed', () => {
    const out = projectDoorbellSlice(
      'camstack-cam1',
      { lastPressedAt: null, pressCountSinceStart: 0 },
      false,
    )
    expect(out.map((v) => v.topic)).not.toContain('camstack/camstack-cam1/doorbell_last_pressed')
    expect(out).toHaveLength(2)
  })
})

describe('projectAudioWindow', () => {
  /**
   * The array order is the analyzer's business. Depending on it would make the
   * exported label change under an unrelated refactor, so the strongest wins.
   */
  it('publishes the HIGHEST-confidence sound, not the first', () => {
    const out = projectAudioWindow('camstack-cam1', {
      detections: [
        { className: 'speech', confidence: 0.4 },
        { className: 'dog', confidence: 0.9 },
        { className: 'music', confidence: 0.7 },
      ],
      dbfs: -32.44,
    })
    expect(out).toContainEqual({ topic: 'camstack/camstack-cam1/audio_last_sound', value: 'dog' })
  })

  /** Silence is a READING. A flat line is the point of a level entity. */
  it('publishes the level on a window with no detections', () => {
    const out = projectAudioWindow('camstack-cam1', { detections: [], dbfs: -70.1 })
    expect(out).toEqual([
      { topic: 'camstack/camstack-cam1/audio_volume', value: '-70.1' },
      { topic: 'camstack/camstack-cam1/audio_detected', value: 'false' },
    ])
  })

  /**
   * An empty string is a VALID state in HA, so publishing one would blank the
   * last thing heard — and "what was that noise" is asked after it stopped.
   */
  it('publishes NO label rather than an empty one', () => {
    const out = projectAudioWindow('camstack-cam1', { detections: [] })
    expect(out.map((v) => v.topic)).not.toContain('camstack/camstack-cam1/audio_last_sound')
  })
})

describe('scene occupancy', () => {
  /**
   * The scene total is not the sum of the macro counters: the frame holds
   * classes that map to no exported macro.
   */
  it('publishes the frame-wide total and its macro breakdown', () => {
    const out = projectZoneOccupancy('camstack-cam1', {
      zones: [],
      scene: { totalObjects: 5, byClass: { person: 2, car: 1, kite: 2 } },
    })
    expect(out).toContainEqual({ topic: 'camstack/camstack-cam1/objects', value: '5' })
    expect(out).toContainEqual({ topic: 'camstack/camstack-cam1/person_objects', value: '2' })
    expect(out).toContainEqual({ topic: 'camstack/camstack-cam1/vehicle_objects', value: '1' })
  })

  /**
   * A snapshot that did not carry a frame scope must leave the scene entities
   * ALONE. Publishing zero would read as "the scene emptied" on a payload that
   * simply did not say.
   */
  it('publishes nothing for the scene when the payload carried none', () => {
    const out = projectZoneOccupancy('camstack-cam1', {
      zones: [{ zoneId: 'z1', totalObjects: 1, byClass: { person: 1 } }],
    })
    expect(out.map((v) => v.topic)).not.toContain('camstack/camstack-cam1/objects')
    expect(out).toContainEqual({ topic: 'camstack/camstack-cam1/z1_objects', value: '1' })
  })
})

// ── The derived half ────────────────────────────────────────────────────

/** A base device carrying exactly one mapped capability. */
function derivedDevice(capName: string): CatalogDevice {
  return {
    id: 700,
    name: 'Front door',
    type: 'sensor',
    features: [],
    boundCaps: [capName],
    zones: [],
    switches: [],
    slices: [capName],
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** A zod object's field names, read through the `shape` getter. */
function shapeKeys(schema: unknown): readonly string[] | null {
  if (!isRecord(schema)) return null
  const shape = schema.shape
  if (!isRecord(shape)) return null
  const keys = Object.keys(shape)
  return keys.length > 0 ? keys : null
}

/** A camera carrying exactly one camera-scoped mapped capability. */
function cameraWith(capName: string): CatalogDevice {
  return {
    id: 101,
    name: 'Front door',
    type: 'camera',
    features: [],
    boundCaps: [capName],
    zones: [],
    switches: [],
    slices: [capName],
  }
}

/** A value of the shape the descriptor's platform can carry. */
function sampleValue(descriptor: CapEntityDescriptor): unknown {
  /**
   * A derived descriptor reads a STRING and compares it. Feeding it the
   * value it compares against exercises the derivation rather than
   * bypassing it — and the same string still renders for the sibling
   * `sensor` entity that carries the enum verbatim.
   */
  if (descriptor.derive !== undefined) return descriptor.derive.value
  switch (descriptor.platform) {
    case 'binary_sensor':
    case 'switch':
      return true
    case 'number':
      return 42
    case 'sensor':
      return descriptor.deviceClass === 'timestamp' ? 1_770_000_000_000 : 7
    case 'select':
    case 'alarm_control_panel':
    case 'image':
    case 'camera':
      return 'armed_away'
    case 'button':
      return null
  }
}

/**
 * A slice carrying every field the capability's entities read.
 *
 * A derived descriptor wins the field it shares with a raw one: a string
 * renders for both, whereas the raw sample (a number) would make the
 * derivation unrenderable and hide the very thing being tested.
 */
function sliceFor(capName: string): Readonly<Record<string, unknown>> {
  const slice: Record<string, unknown> = {}
  for (const ref of capEntities(capName)) {
    if (ref.descriptor.platform === 'button') continue
    if (ref.descriptor.derive === undefined && ref.descriptor.field in slice) continue
    slice[ref.descriptor.field] = sampleValue(ref.descriptor)
  }
  return slice
}

describe('the derived half — the topic the catalog built IS the topic we publish', () => {
  /**
   * THE GUARD. The catalog names a derived entity after its capability and
   * the projector has to publish to that name; they were two expressions in
   * two files and only `battery` and `online` agreed, so a non-camera motion,
   * contact, smoke or doorbell device got an entity that could never receive
   * a value. This walks every entry and fails the moment either side drifts.
   */
  it('projects EVERY entity of every CAP_ENTITY_MAP entry onto the component the catalog built', () => {
    for (const [capName, mapping] of Object.entries(CAP_ENTITY_MAP)) {
      /**
       * A camera-scoped capability is built by the CAMERA half —
       * `buildDerivedPlan` never runs for one — and it has to line up
       * just as exactly, because the descriptor and the projector are
       * shared and only the builder differs.
       */
      const plan = CAMERA_DERIVED_CAPS.includes(capName)
        ? buildCameraPlan(cameraWith(capName))
        : buildDerivedPlan(derivedDevice(capName))

      const expectedTopics: string[] = []
      for (const ref of capEntities(capName)) {
        const component = plan.cmps[toComponentKey(ref.descriptor.platform, ref.entity)]
        expect(
          component,
          `${capName}: the catalog builds no component for '${ref.entity}'`,
        ).toBeDefined()
        if (component === undefined) continue
        if (ref.descriptor.platform === 'button') {
          // Write-only: no state topic, so nothing to publish and nothing
          // to disagree about.
          expect(component.state_topic, ref.entity).toBeUndefined()
          continue
        }
        expect(component.state_topic, ref.entity).toBeDefined()
        if (component.state_topic !== undefined) expectedTopics.push(component.state_topic)
      }

      const projection = projectCapSlice(plan.deviceKey, capName, sliceFor(capName))

      if (mapping.platform === 'button' && mapping.extras === undefined) {
        expect(projection.kind, capName).toBe('no-entity')
        continue
      }

      expect(projection.kind, `${capName}: ${JSON.stringify(projection)}`).toBe('values')
      if (projection.kind !== 'values') continue
      expect(
        projection.values.map((value) => value.topic),
        capName,
      ).toEqual(expectedTopics)
    }
  })

  /**
   * THE OTHER HALF OF THE SAME GUARD, and the one the field census
   * measured: eleven descriptors named a field the capability's status
   * schema does not declare, so eleven entities were published and could
   * never receive a value. `check-export-coverage` asks this in CI
   * against the zod schema; this asks it here, of every entity including
   * the secondary ones the guard's `{ field }` reader does not see.
   */
  it('reads only fields the capability actually declares', async () => {
    const module: unknown = await import('@camstack/types')
    const fieldsByCap = new Map<string, readonly string[]>()
    if (!isRecord(module)) throw new Error('@camstack/types did not load as a module')
    for (const value of Object.values(module)) {
      if (!isRecord(value)) continue
      const { name, scope } = value
      if (typeof name !== 'string' || scope !== 'device') continue
      const status = isRecord(value.status) ? value.status.schema : undefined
      const fields = shapeKeys(status) ?? shapeKeys(value.runtimeState)
      if (fields !== null) fieldsByCap.set(name, fields)
    }

    for (const capName of Object.keys(CAP_ENTITY_MAP)) {
      const declared = fieldsByCap.get(capName)
      // A cap with no status and no runtime state carries a command, not
      // a value — `button` is the only one, and it has no state topic.
      if (declared === undefined) continue
      for (const ref of capEntities(capName)) {
        expect(
          declared,
          `${capName}.${ref.entity} reads '${ref.descriptor.field}', which the cap does not declare`,
        ).toContain(ref.descriptor.field)
      }
    }
  })

  it('renders a boolean slice as the payload the component matches', () => {
    const projection = projectCapSlice('camstack-zig1', 'motion', { detected: false })
    expect(projection).toEqual({
      kind: 'values',
      entity: 'motion',
      values: [{ topic: 'camstack/camstack-zig1/motion', value: 'false' }],
    })
  })

  it('renders a ms-epoch timestamp field as ISO, which is what HA parses', () => {
    const projection = projectCapSlice('camstack-zig1', 'doorbell', {
      lastPressedAt: 1_770_000_000_000,
      pressCountSinceStart: 3,
    })
    expect(projection).toEqual({
      kind: 'values',
      entity: 'doorbell',
      values: [
        {
          topic: 'camstack/camstack-zig1/doorbell',
          value: new Date(1_770_000_000_000).toISOString(),
        },
      ],
    })
  })

  it('publishes nothing — not zero, not empty — for a field that is null', () => {
    const projection = projectCapSlice('camstack-zig1', 'doorbell', {
      lastPressedAt: null,
      pressCountSinceStart: 0,
    })
    expect(projection).toEqual({ kind: 'values', entity: 'doorbell', values: [] })
  })

  /**
   * `contact` WAS the live example — the descriptor read `open` while
   * `ContactStatusSchema` declares `entryOpen`, so the entity existed in
   * an operator's Home Assistant and could never receive a value. That
   * row is fixed, and eleven others with it, so the case is now
   * reproduced with a slice that genuinely lacks the field: a provider
   * that answers a partial slice must still be REPORTED, not silently
   * dropped, because that is how the eleven went unnoticed.
   */
  it('names the capability and the field when the slice does not carry it', () => {
    const projection = projectCapSlice('camstack-zig1', 'contact', { lastChangedAt: 1 })
    expect(projection).toEqual({
      kind: 'missing-field',
      capName: 'contact',
      field: 'entryOpen',
      sliceFields: ['lastChangedAt'],
    })
  })

  /**
   * An EXTRA whose field the slice does not carry must not silence the
   * primary. `day-night` declares `sensitivity` and `switchDelaySec` as
   * OPTIONAL — a vendor without a photocell never reports them — and the
   * projector answered `missing-field` for the whole cap, so "Camera
   * sala da pranzo" never received a `mode` value in Home Assistant while
   * the log warned about a sibling nobody was waiting for (2026-09-05).
   * The missing extras are still NAMED, once, for the caller to log.
   */
  it('publishes the primary and names the missing extras when only an extra is absent', () => {
    const projection = projectCapSlice('camstack-587', 'day-night', {
      mode: 'auto',
      lastFetchedAt: 1,
    })
    expect(projection).toEqual({
      kind: 'values',
      entity: 'day_night',
      values: [{ topic: 'camstack/camstack-587/day_night', value: 'auto' }],
      missingFields: ['sensitivity', 'switchDelaySec'],
    })
  })

  /** The fix itself: the field the cap declares is the field we read. */
  it('reads the field ContactStatusSchema actually declares', () => {
    expect(
      projectCapSlice('camstack-zig1', 'contact', { entryOpen: true, lastChangedAt: 1 }),
    ).toEqual({
      kind: 'values',
      entity: 'contact',
      values: [{ topic: 'camstack/camstack-zig1/contact', value: 'true' }],
    })
  })

  /**
   * A lock is a switch AND a sensor from one field: the boolean is what
   * an operator automates on, the string is what tells them the door is
   * JAMMED. A boolean alone reports a jammed door as unlocked.
   */
  it('derives the lock boolean without losing `jammed`', () => {
    const jammed = projectCapSlice('camstack-zig1', 'lock-control', {
      state: 'jammed',
      lastChangedAt: 1,
    })
    expect(jammed).toEqual({
      kind: 'values',
      entity: 'lock_control',
      values: [
        { topic: 'camstack/camstack-zig1/lock_control', value: 'false' },
        { topic: 'camstack/camstack-zig1/lock_control_state', value: 'jammed' },
      ],
    })
  })

  /** `not_home` is off; every other value is a zone the operator named. */
  it('derives presence from the zone string and publishes the zone too', () => {
    const away = projectCapSlice('camstack-zig1', 'presence', {
      state: 'not_home',
      location: null,
      gps: null,
      batteryPercent: null,
      lastChangedAt: 1,
    })
    expect(away).toEqual({
      kind: 'values',
      entity: 'presence',
      values: [
        { topic: 'camstack/camstack-zig1/presence', value: 'false' },
        { topic: 'camstack/camstack-zig1/presence_zone', value: 'not_home' },
      ],
    })

    const atWork = projectCapSlice('camstack-zig1', 'presence', {
      state: 'Ufficio',
      location: null,
      gps: null,
      batteryPercent: null,
      lastChangedAt: 1,
    })
    expect(atWork.kind === 'values' ? atWork.values : []).toEqual([
      { topic: 'camstack/camstack-zig1/presence', value: 'true' },
      { topic: 'camstack/camstack-zig1/presence_zone', value: 'Ufficio' },
    ])
  })

  /**
   * A null on ONE entity must not silence its siblings: a cover that has
   * not reported a tilt position still has a state and a position.
   */
  it('publishes the siblings of a field that is null', () => {
    const projection = projectCapSlice('camstack-zig1', 'cover', {
      state: 'open',
      position: 40,
      tiltPosition: null,
      lastChangedAt: 1,
    })
    expect(projection).toEqual({
      kind: 'values',
      entity: 'cover',
      values: [
        { topic: 'camstack/camstack-zig1/cover', value: 'open' },
        { topic: 'camstack/camstack-zig1/cover_position', value: '40' },
      ],
    })
  })

  it('refuses to render a value the platform cannot carry', () => {
    const projection = projectCapSlice('camstack-zig1', 'motion', { detected: 'yes' })
    expect(projection).toEqual({
      kind: 'unrenderable',
      capName: 'motion',
      field: 'detected',
      valueType: 'string',
    })
  })

  it('produces nothing for a capability the catalog does not map', () => {
    expect(projectCapSlice('camstack-zig1', 'stream-catalog', { profiles: [] })).toEqual({
      kind: 'no-entity',
      capName: 'stream-catalog',
    })
  })
})

describe('both audio levels', () => {
  /**
   * They answer different questions: dBFS is logarithmic and negative-going,
   * the one to threshold on; RMS is linear amplitude, what a loudness graph
   * wants. Rounding RMS the way dBFS is rounded would collapse every quiet
   * window to `0`.
   */
  it('publishes dBFS and RMS at the precision each one has', () => {
    const out = projectAudioWindow('camstack-cam1', {
      detections: [],
      dbfs: -21.343415,
      rms: 0.008567,
    })
    expect(out).toContainEqual({ topic: 'camstack/camstack-cam1/audio_volume', value: '-21.3' })
    expect(out).toContainEqual({ topic: 'camstack/camstack-cam1/audio_level_rms', value: '0.0086' })
  })
})

/**
 * D683 Task 18 fix round 1 (review L2): the `end` of a piece L2 fused into
 * another track is not the subject leaving. Disarm: drop the early return in
 * `projectTrackLifecycle` — "a fused piece's end publishes nothing" fails.
 */
describe('a fused piece ending (D683)', () => {
  const end = {
    deviceId: 101,
    trackId: 'B',
    phase: 'end' as const,
    classes: ['person'],
    bestClassName: 'person',
    lastSeen: 1_770_000_000_000,
    zonesVisited: ['Uscio'],
  }

  it("a fused piece's end publishes nothing — no detected=false while the survivor is in view", () => {
    expect(projectTrackLifecycle(KEY, { ...end, fusedIntoTrackId: 'A' }, null)).toEqual([])
  })

  it('a real end still clears the booleans', () => {
    const values = projectTrackLifecycle(KEY, end, null)
    expect(at(values, 'camstack/camstack-reolink-101/person_detected')).toBe('false')
    expect(at(values, 'camstack/camstack-reolink-101/triggered')).toBe('false')
  })
})
