/**
 * S3 — pure device-detection-settings derivation.
 *
 * Covers the two areas the S3 refactor step calls out as previously only
 * indirectly exercised via e2e specs:
 *  1. `resolveAssignedProfile` — the profile-slot fallback chain.
 *  2. `resolveDetectionSettings`'s `motionSources` default ladder — operator-
 *     set wins; else onboard-cap preferred; else battery-profile-empty; else
 *     the schema default.
 *
 * Also smoke-tests `detectionConfigEquals`, `buildDetectionConfigFromInputs`,
 * and `buildRunnerConfig` — the other pure functions extracted in this step
 * — with real derivations (no mocks).
 */

import type { CameraDetectionConfig, CamProfile, PipelineStepInputOutput } from '@camstack/types'
import { DeviceFeature } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_DETECTION_FPS_DEFAULT,
  buildDetectionConfigFromInputs,
  buildRunnerConfig,
  detectionConfigEquals,
  detectionFpsForTrigger,
  type ResolveDetectionSettingsInput,
  type ResolvedDetectionSettings,
  resolveAssignedProfile,
  resolveDetectionSettings,
} from '../device-detection-settings.js'

// ── resolveAssignedProfile — profile fallback chains ──────────────────────

describe('resolveAssignedProfile', () => {
  function assignedOf(...profiles: readonly CamProfile[]): ReadonlyMap<CamProfile, string> {
    return new Map(profiles.map((p) => [p, `stream:${p}`]))
  }

  it('returns the requested profile directly when its slot is live', () => {
    expect(resolveAssignedProfile(assignedOf('high', 'mid', 'low'), 'mid')).toBe('mid')
  })

  describe("requested profile === 'low'", () => {
    it('falls back to mid when low is missing but mid is assigned', () => {
      expect(resolveAssignedProfile(assignedOf('mid'), 'low')).toBe('mid')
    })
    it('falls back to high when low and mid are both missing', () => {
      expect(resolveAssignedProfile(assignedOf('high'), 'low')).toBe('high')
    })
    it('returns null when nothing is assigned', () => {
      expect(resolveAssignedProfile(assignedOf(), 'low')).toBeNull()
    })
  })

  describe("requested profile === 'high'", () => {
    it('falls back to mid when high is missing but mid is assigned', () => {
      expect(resolveAssignedProfile(assignedOf('mid'), 'high')).toBe('mid')
    })
    it('falls back to low when high and mid are both missing', () => {
      expect(resolveAssignedProfile(assignedOf('low'), 'high')).toBe('low')
    })
    it('returns null when nothing is assigned', () => {
      expect(resolveAssignedProfile(assignedOf(), 'high')).toBeNull()
    })
  })

  describe("requested profile === 'mid' (the else branch)", () => {
    it('falls back to high when mid is missing but high is assigned', () => {
      expect(resolveAssignedProfile(assignedOf('high'), 'mid')).toBe('high')
    })
    it('falls back to low when mid and high are both missing', () => {
      expect(resolveAssignedProfile(assignedOf('low'), 'mid')).toBe('low')
    })
    it('returns null when nothing is assigned', () => {
      expect(resolveAssignedProfile(assignedOf(), 'mid')).toBeNull()
    })
  })
})

// ── resolveDetectionSettings — the motionSources default ladder ───────────

describe('resolveDetectionSettings — motionSources default ladder', () => {
  const baseFlat: Record<string, unknown> = {
    motionSources: ['analyzer'], // schema default
    motionStreamProfile: 'high',
    detectionStreamProfile: 'mid',
    motionFps: 4,
    detectionFps: 10,
    motionCooldownMs: 30_000,
    occupancyRecheckSec: 5,
    occupancyRecheckFrames: 3,
    preRollInferenceEnabled: true,
    preRollInferenceFrames: 12,
  }

  function baseInput(
    overrides: Partial<ResolveDetectionSettingsInput>,
  ): ResolveDetectionSettingsInput {
    return {
      deviceId: 1,
      raw: {},
      flat: baseFlat,
      features: [],
      hasOnboardMotion: false,
      hasActivitySignal: false,
      pipelineEnabled: true,
      motionDetectionEnabled: true,
      ...overrides,
    }
  }

  it('branch 1: operator explicitly set motionSources to [analyzer] — honoured verbatim', () => {
    const result = resolveDetectionSettings(
      baseInput({ raw: { motionSources: ['analyzer'] }, hasOnboardMotion: true }),
    )
    // Operator value wins even though hasOnboardMotion would otherwise pick ['onboard'].
    expect(result.motionSources).toEqual(['analyzer'])
  })

  it('branch 2: operator explicitly set motionSources to [onboard] — honoured verbatim', () => {
    const result = resolveDetectionSettings(
      baseInput({
        raw: { motionSources: ['onboard'] },
        hasOnboardMotion: false,
        features: [DeviceFeature.BatteryOperated],
      }),
    )
    // Operator value wins even though the battery-profile branch would otherwise pick [].
    expect(result.motionSources).toEqual(['onboard'])
  })

  it('branch 3: no operator value + device has an onboard motion cap — defaults to [onboard]', () => {
    const result = resolveDetectionSettings(
      baseInput({ raw: {}, hasOnboardMotion: true, features: [DeviceFeature.BatteryOperated] }),
    )
    // Onboard-cap preference wins over the battery-profile branch too.
    expect(result.motionSources).toEqual(['onboard'])
  })

  it('branch 4: no operator value, no onboard cap, battery-profile device — defaults to []', () => {
    const result = resolveDetectionSettings(
      baseInput({ raw: {}, hasOnboardMotion: false, features: [DeviceFeature.BatteryOperated] }),
    )
    expect(result.motionSources).toEqual([])
  })

  it('branch 5: no operator value, no onboard cap, non-battery device — falls back to the schema default', () => {
    const result = resolveDetectionSettings(
      baseInput({ raw: {}, hasOnboardMotion: false, features: [] }),
    )
    expect(result.motionSources).toEqual(['analyzer'])
  })

  it('battery profile only fires the empty-default when the resolved profile is non-null (matches the "profile &&" guard)', () => {
    // A battery-feature device with no registered DeviceProfile (hypothetical
    // future drift) must NOT silently match the battery branch — it should
    // fall through to the schema default, exercising the `profile &&` guard.
    const result = resolveDetectionSettings(
      baseInput({ raw: {}, hasOnboardMotion: false, features: ['some-unknown-feature'] }),
    )
    expect(result.motionSources).toEqual(['analyzer'])
  })
})

/**
 * The `device-activity` source (D392): a device that reports its own activity
 * carries the source in its DEFAULTS, and stays operator-removable.
 */
describe('resolveDetectionSettings — the device-activity default', () => {
  const baseFlat: Record<string, unknown> = {
    motionSources: ['analyzer'],
    motionStreamProfile: 'high',
    detectionStreamProfile: 'mid',
    motionFps: 4,
    detectionFps: 10,
    motionCooldownMs: 30_000,
    occupancyRecheckSec: 5,
    occupancyRecheckFrames: 3,
    preRollInferenceEnabled: true,
    preRollInferenceFrames: 12,
  }

  function baseInput(
    overrides: Partial<ResolveDetectionSettingsInput>,
  ): ResolveDetectionSettingsInput {
    return {
      deviceId: 102,
      raw: {},
      flat: baseFlat,
      features: [],
      hasOnboardMotion: false,
      hasActivitySignal: false,
      pipelineEnabled: true,
      motionDetectionEnabled: true,
      ...overrides,
    }
  }

  it('a device that reports its own activity gets the source by default', () => {
    const result = resolveDetectionSettings(
      baseInput({ hasActivitySignal: true, features: [DeviceFeature.BatteryOperated] }),
    )
    expect(result.motionSources).toEqual(['device-activity'])
  })

  it('does not reach a camera that cannot report activity — the fleet is untouched', () => {
    expect(resolveDetectionSettings(baseInput({ hasActivitySignal: false })).motionSources).toEqual(
      ['analyzer'],
    )
    expect(
      resolveDetectionSettings(baseInput({ hasActivitySignal: false, hasOnboardMotion: true }))
        .motionSources,
    ).toEqual(['onboard'])
  })

  it('rides ALONGSIDE onboard motion on a device that has both', () => {
    const result = resolveDetectionSettings(
      baseInput({ hasActivitySignal: true, hasOnboardMotion: true }),
    )
    expect([...result.motionSources].sort()).toEqual(['device-activity', 'onboard'])
  })

  it('is operator-removable — an explicit list wins, including one without it', () => {
    const result = resolveDetectionSettings(
      baseInput({ hasActivitySignal: true, raw: { motionSources: ['analyzer'] } }),
    )
    expect(result.motionSources).toEqual(['analyzer'])
  })

  it('an operator who empties the list keeps it empty', () => {
    const result = resolveDetectionSettings(
      baseInput({ hasActivitySignal: true, raw: { motionSources: [] } }),
    )
    expect(result.motionSources).toEqual([])
  })
})

describe('resolveDetectionSettings — activityDetectionFps', () => {
  const baseFlat: Record<string, unknown> = {
    motionSources: ['analyzer'],
    motionStreamProfile: 'high',
    detectionStreamProfile: 'mid',
    motionFps: 4,
    detectionFps: 10,
    motionCooldownMs: 30_000,
    occupancyRecheckSec: 5,
    occupancyRecheckFrames: 3,
    preRollInferenceEnabled: true,
    preRollInferenceFrames: 12,
  }
  function input(flat: Record<string, unknown>): ResolveDetectionSettingsInput {
    return {
      deviceId: 102,
      raw: {},
      flat: { ...baseFlat, ...flat },
      features: [],
      hasOnboardMotion: false,
      hasActivitySignal: true,
      pipelineEnabled: true,
      motionDetectionEnabled: true,
    }
  }

  it('falls back to the shipped default when the store has no value', () => {
    expect(resolveDetectionSettings(input({})).activityDetectionFps).toBe(
      ACTIVITY_DETECTION_FPS_DEFAULT,
    )
  })

  it('takes the operator value when the store has one', () => {
    expect(resolveDetectionSettings(input({ activityDetectionFps: 3 })).activityDetectionFps).toBe(
      3,
    )
  })
})

describe('detectionFpsForTrigger — the rate a session opens at', () => {
  const config = (over?: Partial<CameraDetectionConfig>): CameraDetectionConfig =>
    ({ detectionFps: 10, activityDetectionFps: 1, ...over }) as CameraDetectionConfig

  it('caps the rate for a session the device-activity level opened', () => {
    expect(detectionFpsForTrigger(config(), 'device-activity')).toBe(1)
  })

  it('leaves every other trigger at the camera rate', () => {
    expect(detectionFpsForTrigger(config(), 'onboard')).toBe(10)
    expect(detectionFpsForTrigger(config(), 'analyzer')).toBe(10)
    expect(detectionFpsForTrigger(config(), undefined)).toBe(10)
  })

  it('is a CAP, not a set: a camera already slower than the activity rate stays slower', () => {
    expect(detectionFpsForTrigger(config({ detectionFps: 1 }), 'device-activity')).toBe(1)
    expect(
      detectionFpsForTrigger(
        config({ detectionFps: 2, activityDetectionFps: 5 }),
        'device-activity',
      ),
    ).toBe(2)
  })
})

describe('resolveDetectionSettings — other operator-wins → profile → fallback fields', () => {
  const baseFlat: Record<string, unknown> = {
    motionSources: ['analyzer'],
    motionStreamProfile: 'low',
    detectionStreamProfile: 'high',
    motionFps: 4,
    detectionFps: 10,
    motionCooldownMs: 30_000,
    occupancyRecheckSec: 5,
    occupancyRecheckFrames: 3,
    preRollInferenceEnabled: true,
    preRollInferenceFrames: 12,
  }
  function baseInput(
    overrides: Partial<ResolveDetectionSettingsInput>,
  ): ResolveDetectionSettingsInput {
    return {
      deviceId: 7,
      raw: {},
      flat: baseFlat,
      features: [],
      hasOnboardMotion: false,
      hasActivitySignal: false,
      pipelineEnabled: false,
      motionDetectionEnabled: false,
      ...overrides,
    }
  }

  it('detectionMode: operator value wins over the battery-profile default', () => {
    const result = resolveDetectionSettings(
      baseInput({ raw: { detectionMode: 'always-on' }, features: [DeviceFeature.BatteryOperated] }),
    )
    expect(result.detectionMode).toBe('always-on')
  })

  it('detectionMode: battery profile default (on-motion) fires when unset', () => {
    const result = resolveDetectionSettings(
      baseInput({ features: [DeviceFeature.BatteryOperated] }),
    )
    expect(result.detectionMode).toBe('on-motion')
  })

  it('detectionMode: static fallback (on-motion) when no profile matches and operator unset', () => {
    const result = resolveDetectionSettings(baseInput({ features: [] }))
    expect(result.detectionMode).toBe('on-motion')
  })

  it('audioMode: battery profile default (disabled) fires when unset', () => {
    const result = resolveDetectionSettings(
      baseInput({ features: [DeviceFeature.BatteryOperated] }),
    )
    expect(result.audioMode).toBe('disabled')
  })

  it('audioMode: static fallback (always-on) when no profile matches and operator unset', () => {
    const result = resolveDetectionSettings(baseInput({ features: [] }))
    expect(result.audioMode).toBe('always-on')
  })

  it('onboardMotionDrivesAnalyzer defaults to true when unset, honours an explicit false', () => {
    expect(resolveDetectionSettings(baseInput({})).onboardMotionDrivesAnalyzer).toBe(true)
    expect(
      resolveDetectionSettings(baseInput({ raw: { onboardMotionDrivesAnalyzer: false } }))
        .onboardMotionDrivesAnalyzer,
    ).toBe(false)
  })

  /**
   * The recheck is ON by default (2026-08-13). It used to be off because each
   * cycle re-subscribes a detection session — an RTSP re-dial — and at the old
   * 30 s interval that is 120 re-dials an hour per camera.
   *
   * What being off cost: a STATIONARY object is only counted while the
   * stationary registry holds it, and that registry rebuilds from motion after
   * a restart. So a parked car was invisible to every occupancy rule until
   * something moved in front of it — indefinitely, on a quiet driveway. The
   * recheck is the only thing that re-samples a still scene.
   *
   * The trade is paid on the INTERVAL, not the switch: the default is wide (see
   * `occupancyRecheckSecField`), which brings the cost to ~12 re-dials an hour.
   * The per-camera override still wins in both directions.
   */
  it('occupancyRecheckEnabled defaults to TRUE when unset, honours an explicit false', () => {
    expect(resolveDetectionSettings(baseInput({})).occupancyRecheckEnabled).toBe(true)
    expect(
      resolveDetectionSettings(baseInput({ raw: { occupancyRecheckEnabled: false } }))
        .occupancyRecheckEnabled,
    ).toBe(false)
  })

  it('throws when a required schema leaf is missing (malformed flat)', () => {
    const badFlat = { ...baseFlat }
    delete badFlat['occupancyRecheckSec']
    expect(() => resolveDetectionSettings(baseInput({ flat: badFlat }))).toThrow(
      /occupancyRecheckSec/,
    )
  })

  it('passes a non-enum motionStreamProfile through verbatim (no throw) — write path does not enforce the CamProfile enum, and resolveAssignedProfile tolerates it via its else-branch fallback', () => {
    const badFlat = { ...baseFlat, motionStreamProfile: 'ultra' }
    let result: ResolvedDetectionSettings | undefined
    expect(() => {
      result = resolveDetectionSettings(baseInput({ flat: badFlat }))
    }).not.toThrow()
    // Pass-through boundary: the malformed stored value flows through as-is.
    expect(result?.motionStreamProfile).toBe('ultra')

    // Downstream, resolveAssignedProfile's else branch (neither 'low' nor
    // 'high') still resolves a usable profile instead of propagating the
    // bogus value — detection settings still resolve for the device.
    const assigned = new Map<CamProfile, string>([['high', 'stream:high']])
    expect(resolveAssignedProfile(assigned, result!.motionStreamProfile)).toBe('high')
  })

  it('numberOrDefault falls back to the RunnerCameraDeviceUIFields default when null', () => {
    const nullFlat = { ...baseFlat, motionFps: null }
    const result = resolveDetectionSettings(baseInput({ flat: nullFlat }))
    expect(result.motionFps).toBe(4) // motionFpsField.default
  })
})

// ── detectionConfigEquals — smoke coverage ────────────────────────────────

describe('detectionConfigEquals', () => {
  function makeConfig(overrides: Partial<CameraDetectionConfig> = {}): CameraDetectionConfig {
    return {
      enabled: true,
      pipelineEnabled: true,
      motionSources: ['analyzer', 'onboard'],
      motionStreamId: 'rtsp:main',
      detectionStreamId: 'rtsp:sub',
      motionFps: 4,
      detectionFps: 10,
      motionCooldownMs: 30_000,
      detectionMode: 'on-motion',
      audioMode: 'always-on',
      onboardMotionDrivesAnalyzer: true,
      occupancyRecheckEnabled: false,
      occupancyRecheckSec: 5,
      occupancyRecheckFrames: 3,
      preRollInferenceEnabled: true,
      preRollInferenceFrames: 12,
      ...overrides,
    }
  }

  it('treats identical configs as equal', () => {
    expect(detectionConfigEquals(makeConfig(), makeConfig())).toBe(true)
  })

  it('treats motionSources as an unordered set', () => {
    const a = makeConfig({ motionSources: ['analyzer', 'onboard'] })
    const b = makeConfig({ motionSources: ['onboard', 'analyzer'] })
    expect(detectionConfigEquals(a, b)).toBe(true)
  })

  it('detects a primitive field difference', () => {
    expect(detectionConfigEquals(makeConfig(), makeConfig({ motionFps: 8 }))).toBe(false)
  })

  it('detects a motionSources length difference', () => {
    expect(detectionConfigEquals(makeConfig(), makeConfig({ motionSources: ['analyzer'] }))).toBe(
      false,
    )
  })
})

// ── resolveDetectionSettings — the audio rung the operator picked ─────────
//
// `audioStreamPick` is the operator's per-camera answer to "which stream is my
// audio on". It has to SURVIVE the read: the field it replaces
// (`audioStreamId`) was typed, written `undefined` unconditionally, and read by
// nobody — so the operator had no way to say it and audio silently rode the
// motion rung, which on this fleet is a transcode (D537).

describe('resolveDetectionSettings — audioStreamPick', () => {
  const flat: Record<string, unknown> = {
    motionSources: ['analyzer'],
    motionStreamProfile: 'low',
    detectionStreamProfile: 'high',
    motionFps: 4,
    detectionFps: 10,
    motionCooldownMs: 30_000,
    occupancyRecheckSec: 5,
    occupancyRecheckFrames: 3,
    preRollInferenceEnabled: true,
    preRollInferenceFrames: 12,
  }

  function resolve(raw: Record<string, unknown>): ResolvedDetectionSettings {
    return resolveDetectionSettings({
      deviceId: 1,
      raw,
      flat,
      features: [],
      hasOnboardMotion: false,
      hasActivitySignal: false,
      pipelineEnabled: true,
      motionDetectionEnabled: true,
    })
  }

  it('carries the operator’s stored rung through to the config the consumers read', () => {
    expect(resolve({ audioStreamPick: 'mid' }).audioStreamPick).toBe('mid')
    expect(resolve({ audioStreamPick: 'high' }).audioStreamPick).toBe('high')
  })

  it('reads an absent value as auto — an untouched camera is unchanged', () => {
    expect(resolve({}).audioStreamPick).toBe('auto')
  })

  it('reads an unrecognised stored value as auto rather than failing the whole read', () => {
    expect(resolve({ audioStreamPick: 'derived:mid-to-low' }).audioStreamPick).toBe('auto')
  })

  it('lands on the CameraDetectionConfig the audio subscription and the watchdog both read', () => {
    const config = buildDetectionConfigFromInputs(
      resolve({ audioStreamPick: 'mid' }),
      new Map([
        ['low', 'derived:mid-to-low'],
        ['high', 'native:main'],
      ]),
    )
    expect(config?.audioStreamPick).toBe('mid')
  })
})

// ── buildDetectionConfigFromInputs — smoke coverage ───────────────────────

describe('buildDetectionConfigFromInputs', () => {
  function makeResolved(
    overrides: Partial<ResolvedDetectionSettings> = {},
  ): ResolvedDetectionSettings {
    return {
      motionDetectionEnabled: true,
      pipelineEnabled: true,
      motionSources: ['onboard'],
      detectionSources: ['pipeline'],
      audioStreamPick: 'auto',
      motionStreamProfile: 'low',
      detectionStreamProfile: 'high',
      motionFps: 4,
      detectionFps: 10,
      activityDetectionFps: 1,
      motionCooldownMs: 30_000,
      audioMotionWindowMs: 90_000,
      maxSessionHoldMs: 120_000,
      detectionMode: 'on-motion',
      audioMode: 'always-on',
      onboardMotionDrivesAnalyzer: true,
      occupancyRecheckEnabled: false,
      occupancyRecheckSec: 5,
      occupancyRecheckFrames: 3,
      preRollInferenceEnabled: true,
      preRollInferenceFrames: 12,
      ...overrides,
    }
  }

  it('resolves the assigned cam-stream ids for the motion/detection profiles', () => {
    const assigned = new Map<CamProfile, string>([
      ['low', 'rtsp:sub'],
      ['high', 'rtsp:main'],
    ])
    const result = buildDetectionConfigFromInputs(makeResolved(), assigned)
    expect(result).not.toBeNull()
    expect(result?.motionStreamId).toBe('rtsp:sub')
    expect(result?.detectionStreamId).toBe('rtsp:main')
    expect(result?.enabled).toBe(true)
  })

  it('falls back through resolveAssignedProfile when the exact profile is unassigned', () => {
    // requested low, but only mid is assigned -> resolveAssignedProfile('low') -> 'mid'
    const assigned = new Map<CamProfile, string>([
      ['mid', 'rtsp:mid'],
      ['high', 'rtsp:main'],
    ])
    const result = buildDetectionConfigFromInputs(makeResolved(), assigned)
    expect(result?.motionStreamId).toBe('rtsp:mid')
  })

  it('returns null when neither the requested nor any fallback profile is assigned', () => {
    const assigned = new Map<CamProfile, string>()
    expect(buildDetectionConfigFromInputs(makeResolved(), assigned)).toBeNull()
  })
})

// ── buildRunnerConfig — smoke coverage ────────────────────────────────────

describe('buildRunnerConfig', () => {
  function makeConfig(overrides: Partial<CameraDetectionConfig> = {}): CameraDetectionConfig {
    return {
      enabled: true,
      pipelineEnabled: true,
      motionSources: ['onboard'],
      motionStreamId: 'rtsp:main',
      detectionStreamId: 'rtsp:sub',
      motionFps: 4,
      detectionFps: 10,
      motionCooldownMs: 30_000,
      detectionMode: 'always-on',
      audioMode: 'always-on',
      onboardMotionDrivesAnalyzer: true,
      occupancyRecheckEnabled: false,
      occupancyRecheckSec: 5,
      occupancyRecheckFrames: 3,
      preRollInferenceEnabled: true,
      preRollInferenceFrames: 12,
      ...overrides,
    }
  }

  it('copies every shared field straight off the CameraDetectionConfig with no overrides', () => {
    const config = makeConfig()
    const runnerConfig = buildRunnerConfig({ deviceId: 42, config, zones: [] })
    expect(runnerConfig).toEqual({
      deviceId: 42,
      motionCooldownMs: config.motionCooldownMs,
      motionFps: config.motionFps,
      detectionFps: config.detectionFps,
      motionStreamId: config.motionStreamId,
      detectionStreamId: config.detectionStreamId,
      motionSources: config.motionSources,
      pipelineEnabled: config.pipelineEnabled,
      steps: [],
      audio: null,
      zones: [],
      detectionMode: config.detectionMode,
      audioMode: config.audioMode,
      onboardMotionDrivesAnalyzer: config.onboardMotionDrivesAnalyzer,
      occupancyRecheckEnabled: config.occupancyRecheckEnabled,
      occupancyRecheckSec: config.occupancyRecheckSec,
      occupancyRecheckFrames: config.occupancyRecheckFrames,
      preRollInferenceEnabled: config.preRollInferenceEnabled,
      preRollInferenceFrames: config.preRollInferenceFrames,
    })
  })

  it('applies overrides for the fields that diverge per dispatch site (steps/audio)', () => {
    const config = makeConfig()
    const steps: readonly PipelineStepInputOutput[] = [{ addonId: 'addon-a', enabled: true }]
    const runnerConfig = buildRunnerConfig(
      { deviceId: 1, config, zones: [] },
      { steps, audio: { modelId: 'yamnet', enabled: true } },
    )
    expect(runnerConfig.steps).toBe(steps)
    expect(runnerConfig.audio).toEqual({ modelId: 'yamnet', enabled: true })
  })

  it("mirrors ensureMotionWatch's shape when given its overrides (motionSources/detectionMode/audioMode forced)", () => {
    const config = makeConfig({ detectionMode: 'on-motion', motionSources: ['onboard'] })
    const runnerConfig = buildRunnerConfig(
      { deviceId: 5, config, zones: [] },
      {
        motionSources: ['analyzer'],
        pipelineEnabled: false,
        detectionMode: 'disabled',
        audioMode: 'disabled',
      },
    )
    expect(runnerConfig.motionSources).toEqual(['analyzer'])
    expect(runnerConfig.pipelineEnabled).toBe(false)
    expect(runnerConfig.detectionMode).toBe('disabled')
    expect(runnerConfig.audioMode).toBe('disabled')
    // Base fields still flow through untouched.
    expect(runnerConfig.motionCooldownMs).toBe(config.motionCooldownMs)
  })
})

// ── detectionSources — the root-detector pick ─────────────────────────────
//
// `motionSources` has a default LADDER: a camera with firmware motion gets
// `['onboard']` without anybody asking, because the device fact ("this camera
// raises motion") is the same as the right answer. `detectionSources` has no
// such ladder and must not grow one: a firmware that CAN detect is not a
// firmware the operator wants detecting, and a default that acts without a
// choice is exactly what putting this knob in the system was meant to end.
describe('resolveDetectionSettings — detectionSources', () => {
  function sourcesFor(raw: Record<string, unknown>): readonly string[] {
    return resolveDetectionSettings({
      deviceId: 1,
      raw,
      flat: {
        motionSources: ['analyzer'],
        motionStreamProfile: 'high',
        detectionStreamProfile: 'mid',
        motionFps: 4,
        detectionFps: 10,
        motionCooldownMs: 30_000,
        occupancyRecheckSec: 5,
        occupancyRecheckFrames: 3,
        preRollInferenceEnabled: true,
        preRollInferenceFrames: 12,
      },
      features: [],
      hasOnboardMotion: false,
      hasActivitySignal: false,
      pipelineEnabled: true,
      motionDetectionEnabled: true,
    }).detectionSources
  }

  it('defaults to the ML root step when the operator picked nothing', () => {
    expect(sourcesFor({})).toEqual(['pipeline'])
  })

  // The camera HAS firmware motion and IS battery-operated — every fact that
  // makes `motionSources` default to something other than the analyzer. None
  // of them makes the camera its own detector.
  it('no device fact promotes the camera to root detector on its own', () => {
    expect(
      resolveDetectionSettings({
        deviceId: 1,
        raw: {},
        flat: {
          motionSources: ['analyzer'],
          motionStreamProfile: 'high',
          detectionStreamProfile: 'mid',
          motionFps: 4,
          detectionFps: 10,
          motionCooldownMs: 30_000,
          occupancyRecheckSec: 5,
          occupancyRecheckFrames: 3,
          preRollInferenceEnabled: true,
          preRollInferenceFrames: 12,
        },
        features: [DeviceFeature.BatteryOperated],
        hasOnboardMotion: true,
        hasActivitySignal: true,
        pipelineEnabled: true,
        motionDetectionEnabled: true,
      }).detectionSources,
    ).toEqual(['pipeline'])
  })

  it('honours an explicit pick of the camera alone', () => {
    expect(sourcesFor({ detectionSources: ['onboard'] })).toEqual(['onboard'])
  })

  // Two roots on one camera is no longer a thing a camera can be (D507): both
  // planes feed the same per-device stationary registry, both can promote the
  // same parked object, and the two detectors disagree about the same box by
  // construction. A stored two-root value is NORMALISED to its first element
  // rather than refused — refusing it would fail the attach and take the
  // camera dark, which is the one direction that costs an operator a camera.
  it('normalises a legacy BOTH pick to its first root', () => {
    expect(sourcesFor({ detectionSources: ['pipeline', 'onboard'] })).toEqual(['pipeline'])
    expect(sourcesFor({ detectionSources: ['onboard', 'pipeline'] })).toEqual(['onboard'])
  })

  it('an explicitly EMPTY pick survives — a camera with no root detector is a legal choice', () => {
    expect(sourcesFor({ detectionSources: [] })).toEqual([])
  })
})
