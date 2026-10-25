/**
 * Package zone-rule options (D931).
 *
 * A reconstructed 101-style scene: a person is in the zone, then leaves, and a
 * still blob remains on the zone crop. Scene difference (option A) opens a
 * candidate in PackageStillnessTracker. LLM confirm (option B) gates the
 * delivery event. Both options default off.
 */

import type { IScopedLogger, ObjectEvent, Zone, ZoneRule } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { PACKAGE_DROP_DEFAULTS } from '../../../package-settings.js'
import { PackageDropDetector, type PackageObjectEventClient } from '../../package-drop-detector.js'
import type { StationaryEntry } from '../../stationary/stationary-types.js'
import { PackageStillnessTracker } from '../package-stillness-tracker.js'
import {
  PACKAGE_LLM_CONFIRM_TIMEOUT_MS,
  PACKAGE_SCENE_DIFF_LOOK_GAP_MS,
  PACKAGE_SCENE_DIFF_SETTLE_MS,
  confirmPackageWithLlm,
  stepPackageScene,
  type PackageLlmConfirmOutcome,
  type PackageLlmGenerate,
  type PackageSceneState,
  type PackageZoneLuma,
} from '../package-scene-rule.js'

const DEVICE = 101
const W = 40
const H = 40
const T0 = 1_700_000_000_000

const ZONE: Zone = {
  id: 'uscio',
  name: 'Uscio',
  kind: 'polygon',
  polygon: [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ],
  color: '#888',
}

function rule(flags: { readonly scene?: boolean; readonly llm?: boolean }): ZoneRule {
  return {
    id: 'pacchetti',
    name: 'Pacchetti',
    zoneIds: ['uscio'],
    mode: 'include',
    enabled: true,
    ...(flags.scene === true ? { detectBySceneDifference: true } : {}),
    ...(flags.llm === true ? { confirmWithLlm: true } : {}),
  }
}

function luma(
  fill: number,
  paint?: { x: number; y: number; w: number; h: number; value: number },
): PackageZoneLuma {
  const bytes = new Uint8Array(W * H)
  bytes.fill(fill)
  if (paint) {
    for (let y = paint.y; y < paint.y + paint.h; y += 1) {
      for (let x = paint.x; x < paint.x + paint.w; x += 1) {
        bytes[y * W + x] = paint.value
      }
    }
  }
  return { width: W, height: H, luma: bytes }
}

const EMPTY = luma(40)
const WITH_BLOB = luma(40, { x: 16, y: 16, w: 8, h: 8, value: 200 })
const BRIGHTER = luma(80)

function occluderPerson(): {
  readonly className: 'person'
  readonly bbox: { x: number; y: number; w: number; h: number }
} {
  return { className: 'person', bbox: { x: 14, y: 14, w: 12, h: 12 } }
}

interface StepEnv {
  readonly scene: boolean
  readonly personInZone: boolean
  readonly crop: PackageZoneLuma | null
  readonly occluders?: readonly {
    readonly className: 'person' | 'vehicle'
    readonly bbox: { x: number; y: number; w: number; h: number }
  }[]
  readonly state: PackageSceneState | null
  readonly timestamp: number
}

function step(env: StepEnv) {
  return stepPackageScene({
    deviceId: DEVICE,
    timestamp: env.timestamp,
    detectBySceneDifference: env.scene,
    personInZone: env.personInZone,
    crop: env.crop,
    cropOrigin: { x: 0, y: 0 },
    frameWidth: W,
    frameHeight: H,
    minAreaFrac: PACKAGE_DROP_DEFAULTS.packageDropMinBboxAreaFrac,
    occluders: env.occluders ?? [],
    modelBoxes: [],
    state: env.state,
  })
}

/** Person enters, leaves, blob stays. Returns the sightings of the confirming looks. */
function leaveWithBlob(crop: PackageZoneLuma, occluders?: StepEnv['occluders']) {
  let state: PackageSceneState | null = null
  const first = step({
    scene: true,
    personInZone: false,
    crop: EMPTY,
    state,
    timestamp: T0,
  })
  state = first.state
  const inside = step({
    scene: true,
    personInZone: true,
    crop: null,
    state,
    timestamp: T0 + 1_000,
  })
  state = inside.state
  const left = step({
    scene: true,
    personInZone: false,
    crop: null,
    state,
    timestamp: T0 + 2_000,
  })
  state = left.state
  const after = step({
    scene: true,
    personInZone: false,
    crop,
    occluders,
    state,
    timestamp: T0 + 2_000 + PACKAGE_SCENE_DIFF_SETTLE_MS,
  })
  state = after.state
  const looks: ReturnType<typeof step>[] = []
  let at = T0 + 2_000 + PACKAGE_SCENE_DIFF_SETTLE_MS
  for (let i = 0; i < 3; i += 1) {
    at += PACKAGE_SCENE_DIFF_LOOK_GAP_MS
    const look = step({
      scene: true,
      personInZone: false,
      crop,
      occluders,
      state,
      timestamp: at,
    })
    state = look.state
    looks.push(look)
  }
  return { after, looks, state }
}

function recordingLogger(): {
  logger: IScopedLogger
  lines: { message: string; deviceId: unknown }[]
} {
  const lines: { message: string; deviceId: unknown }[] = []
  const at = (message: string, ctx?: { tags?: Record<string, unknown> }): void => {
    lines.push({ message, deviceId: ctx?.tags?.['deviceId'] })
  }
  const logger: IScopedLogger = {
    debug: at,
    info: at,
    warn: at,
    error: at,
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, lines }
}

function makeEvents(): PackageObjectEventClient & { rows: ObjectEvent[] } {
  const rows: ObjectEvent[] = []
  let next = 1
  return {
    rows,
    insertObject: async (ev) => {
      const id = next++
      rows.push({ ...ev, id })
      return id
    },
    queryObject: async () => rows,
  }
}

describe('package scene difference', () => {
  it('opens a candidate from a still blob after a person leaves, then promotes', () => {
    const { looks } = leaveWithBlob(WITH_BLOB)
    expect(looks[0]?.sightings.length).toBe(1)
    expect(looks[0]?.rejections).toEqual([])

    const tracker = new PackageStillnessTracker({ newId: () => 'pkg-1' })
    let promoted = 0
    let at = T0 + 2_000 + PACKAGE_SCENE_DIFF_SETTLE_MS
    for (const look of looks) {
      at += PACKAGE_SCENE_DIFF_LOOK_GAP_MS
      const outcome = tracker.observe({
        deviceId: DEVICE,
        sightings: look.sightings,
        frameWidth: W,
        frameHeight: H,
        timestamp: at,
        minHits: PACKAGE_DROP_DEFAULTS.packageDropMinFrames,
        minDwellMs: 0,
        activityWindowMs: PACKAGE_DROP_DEFAULTS.packageDropActivityWindowSec * 1000,
        lastActivityAt: T0 + 1_000,
      })
      promoted += outcome.promoted.length
    }
    expect(promoted).toBe(1)
  })

  it('does not open a candidate from a global brightness change', () => {
    const { after, looks } = leaveWithBlob(BRIGHTER)
    const reasons = [...after.rejections, ...looks.flatMap((l) => l.rejections)].map(
      (r) => r.reason,
    )
    expect(reasons).toContain('global-brightness')
    expect(looks.every((l) => l.sightings.length === 0)).toBe(true)
  })

  it('does not open a candidate that overlaps a still-present person', () => {
    const { after, looks } = leaveWithBlob(WITH_BLOB, [occluderPerson()])
    const reasons = [...after.rejections, ...looks.flatMap((l) => l.rejections)].map(
      (r) => r.reason,
    )
    expect(reasons).toContain('overlaps-person')
    expect(looks.every((l) => l.sightings.length === 0)).toBe(true)
  })

  it('emits nothing when the option is off', () => {
    const off = step({
      scene: false,
      personInZone: false,
      crop: WITH_BLOB,
      state: null,
      timestamp: T0,
    })
    expect(off.sightings).toEqual([])
    expect(off.rejections).toEqual([])
  })
})

describe('package llm confirm', () => {
  const verdictYes = '{"package":true,"confidence":0.91,"reason":"carton on the mat"}'
  const verdictNo = '{"package":false,"confidence":0.2,"reason":"only the pumpkins"}'

  function generate(text: string | null, hang = false): PackageLlmGenerate {
    return async () => {
      if (hang) return new Promise(() => {})
      if (text === null) return { ok: false, code: 'unavailable', message: 'down' }
      return { ok: true, text }
    }
  }

  it('parses a yes verdict', async () => {
    const outcome = await confirmPackageWithLlm({
      generateVision: generate(verdictYes),
      beforeJpeg: new Uint8Array([1]),
      afterJpeg: new Uint8Array([2]),
    })
    expect(outcome.kind).toBe('yes')
    if (outcome.kind !== 'yes') return
    expect(outcome.verdict.package).toBe(true)
    expect(outcome.verdict.confidence).toBe(0.91)
  })

  it('bounds a hung call as timeout and does not retry', async () => {
    let calls = 0
    const outcome = await confirmPackageWithLlm({
      generateVision: async () => {
        calls += 1
        return new Promise(() => {})
      },
      afterJpeg: new Uint8Array([2]),
      timeoutMs: 5,
    })
    expect(outcome).toEqual({ kind: 'uncertain', reason: 'timeout' })
    expect(calls).toBe(1)
    expect(PACKAGE_LLM_CONFIRM_TIMEOUT_MS).toBeGreaterThan(0)
  })

  async function deliver(
    confirm: (input: { readonly deviceId: number }) => Promise<PackageLlmConfirmOutcome>,
  ) {
    const events = makeEvents()
    const { logger, lines } = recordingLogger()
    const detector = new PackageDropDetector({
      events,
      emit: { delivered: () => {}, pickedUp: () => {} },
      logger,
      resolveZones: async () => [ZONE],
      resolvePackageRules: async () => [rule({ llm: true })],
      resolveSettings: async () => PACKAGE_DROP_DEFAULTS,
      resolveZoneMembershipMinOverlap: async () => 0,
      confirmPackage: confirm,
    })
    const { looks } = leaveWithBlob(WITH_BLOB)
    const tracker = new PackageStillnessTracker({ newId: () => 'pkg-llm' })
    let entry: StationaryEntry | null = null
    let stamp = T0 + 2_000 + PACKAGE_SCENE_DIFF_SETTLE_MS
    for (const look of looks) {
      stamp += PACKAGE_SCENE_DIFF_LOOK_GAP_MS
      const outcome = tracker.observe({
        deviceId: DEVICE,
        sightings: look.sightings,
        frameWidth: W,
        frameHeight: H,
        timestamp: stamp,
        minHits: 3,
        minDwellMs: 0,
        activityWindowMs: 300_000,
        lastActivityAt: T0 + 1_000,
      })
      const promoted = outcome.promoted[0]
      if (promoted !== undefined) entry = promoted
    }
    if (entry === null) throw new Error('expected a promoted parcel')
    await detector.onStationaryChange({
      phase: 'appeared',
      entry,
      timestamp: stamp,
    })
    return { events, lines }
  }

  it('emits the event with the verdict when the model says yes', async () => {
    const { events } = await deliver(async () => {
      const outcome = await confirmPackageWithLlm({
        generateVision: generate(verdictYes),
        beforeJpeg: new Uint8Array([1]),
        afterJpeg: new Uint8Array([2]),
      })
      return outcome
    })
    expect(events.rows).toHaveLength(1)
    expect(events.rows[0]?.packagePossible).toBeUndefined()
    expect(events.rows[0]?.packageLlmVerdict).toEqual({
      package: true,
      confidence: 0.91,
      reason: 'carton on the mat',
    })
  })

  it('drops a no verdict and logs the reason with the device', async () => {
    const { events, lines } = await deliver(async () =>
      confirmPackageWithLlm({
        generateVision: generate(verdictNo),
        afterJpeg: new Uint8Array([2]),
      }),
    )
    expect(events.rows).toHaveLength(0)
    const line = lines.find((l) => l.message.includes('llm said no'))
    expect(line?.deviceId).toBe(DEVICE)
  })

  it('emits a possible package when the llm times out', async () => {
    const { events } = await deliver(async () => ({ kind: 'uncertain', reason: 'timeout' }))
    expect(events.rows).toHaveLength(1)
    expect(events.rows[0]?.packagePossible).toBe(true)
    expect(events.rows[0]?.packageLlmVerdict).toBeUndefined()
  })
})
