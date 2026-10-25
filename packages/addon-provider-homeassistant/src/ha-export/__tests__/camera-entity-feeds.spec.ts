import { describe, expect, it } from 'vitest'
import {
  buildCameraPlan,
  CAMERA_DERIVED_CAPS,
  capEntities,
  EXPORTED_MACROS,
} from '../entity-catalog.js'
import {
  projectAudioWindow,
  projectBatterySlice,
  projectCameraFunctions,
  projectCameraStatus,
  projectDeviceStatus,
  projectDoorbellSlice,
  projectMotion,
  projectTrackLifecycle,
  projectZoneOccupancy,
} from '../state-projector.js'
import { deviceKeyFor, stateTopic } from '../topics.js'
import type { CatalogDevice } from '../types.js'

const DEVICE_ID = 101
const KEY = deviceKeyFor(DEVICE_ID)

const ZONE = { id: 'z-door', name: 'Porta' }

/** Fine detection classes covering all six macros via `macroOf`. */
const SCENE_CLASSES: Readonly<Record<string, number>> = {
  person: 1,
  car: 1,
  dog: 1,
  package: 1,
  motion: 1,
  audio: 1,
}

const ALL_FUNCTIONS = [
  'stream-broker',
  'object-detection',
  'privacy-mask',
  'device-audio',
  'broker-audio',
  'audio-analysis',
  'recording',
  'notifications',
].map((id) => ({ id, label: id, available: true, enabled: true }))

const HEALTHY_STATUS = {
  switchedOff: [],
  degradedStages: [],
  recording: { active: true },
}

/** Everything a camera can carry, switched on: the maximal fan-out. */
const MAXIMAL: CatalogDevice = {
  id: DEVICE_ID,
  name: 'Front door',
  type: 'camera',
  manufacturer: 'Reolink',
  model: 'RLC-811A',
  features: ['rebootable'],
  boundCaps: ['motion', 'snapshot', 'ptz', 'doorbell', 'day-night', 'intercom', 'ptz-autotrack'],
  zones: [ZONE],
  switches: ALL_FUNCTIONS.map((fn) => ({ id: fn.id, label: fn.label, available: fn.available })),
  slices: ['device-status', 'motion', 'battery'],
}

/**
 * Every camera entity that declares a `state_topic` must be in the union of the
 * topics the projectors know how to publish — or be declared here, with the
 * reason. A published entity that cannot receive a value reads, from the
 * operator's chair, as a broken integration: 177 of those, once.
 *
 * The union is COMPUTED by running the projectors, not listed: a hand-kept table
 * would be a second copy, and it diverges the day someone renames a
 * topic on one side only.
 */
const COMMAND_ONLY: Readonly<Record<string, string>> = {
  ptz_preset:
    'Command only. `ptz.getPresets` lists the presets, no cap says which one is ACTIVE ' +
    'right now: publishing the last one written from here would be a parallel store that ' +
    'disagrees with the first manual movement.',
}

describe('camera entity feeds', () => {
  it('no camera entity with a state_topic is without a source', () => {
    const feedable = new Set<string>(
      [
        ...projectDeviceStatus(KEY, true),
        ...projectBatterySlice(KEY, { percentage: 50, charging: 'ac', sleeping: false }),
        ...projectMotion(KEY, { detected: true, timestamp: 1 }),
        ...projectDoorbellSlice(KEY, { lastPressedAt: 1, pressCountSinceStart: 1 }, true),
        ...projectAudioWindow(KEY, {
          detections: [{ className: 'dog', confidence: 1 }],
          dbfs: -20,
          rms: 0.01,
        }),
        ...projectCameraFunctions(KEY, ALL_FUNCTIONS),
        ...projectCameraStatus(KEY, HEALTHY_STATUS),
        ...EXPORTED_MACROS.flatMap((macro) =>
          projectTrackLifecycle(
            KEY,
            {
              deviceId: 101,
              trackId: 't',
              phase: 'start',
              classes: [macro],
              lastSeen: 1,
              label: 'x',
              zonesVisited: [ZONE.id],
            },
            'https://hub/media.jpg',
          ),
        ),
        ...projectZoneOccupancy(KEY, {
          zones: [{ zoneId: ZONE.id, totalObjects: 1, byClass: SCENE_CLASSES }],
          scene: { totalObjects: 1, byClass: SCENE_CLASSES },
        }),
        ...CAMERA_DERIVED_CAPS.flatMap((cap) =>
          capEntities(cap).map((ref) => ({ topic: stateTopic(KEY, ref.entity), value: '' })),
        ),
      ].map((v) => v.topic),
    )

    const orphans = Object.values(buildCameraPlan(MAXIMAL).cmps)
      .filter((c) => c.state_topic !== undefined && !feedable.has(c.state_topic))
      .map((c) => c.state_topic ?? '')
      .filter((topic) => COMMAND_ONLY[topic.split('/')[2] ?? ''] === undefined)

    expect(orphans).toEqual([])
  })
})
