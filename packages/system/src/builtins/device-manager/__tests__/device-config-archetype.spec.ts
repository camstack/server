import { describe, it, expect } from 'vitest'
import {
  deriveFormContribution,
  applyDerivedFormProfilePatch,
  parseDerivedFormSettingsPatch,
} from '../device-config-contribution.js'
import type {
  DayNightOptions,
  DayNightStatus,
  ImageSettingsOptions,
  ImageSettingsStatus,
  StreamParamsOptions,
  StreamParamsStatus,
} from '@camstack/types'

const options: StreamParamsOptions = {
  main: {
    resolutions: [{ width: 1920, height: 1080 }],
    codecs: ['h264', 'h265'],
    framerates: [15, 25],
    bitrates: [],
    supportsBitrateMode: false,
    supportsEncoderProfile: false,
    supportsGop: false,
  },
}
const status: StreamParamsStatus = {
  main: { width: 1920, height: 1080, codec: 'h264', framerate: 25, bitrate: 4096 },
  lastFetchedAt: Date.now(),
}

describe('deriveFormContribution — stream-params builderId', () => {
  it('produces a non-null ContributionShape from options + status', async () => {
    const out = deriveFormContribution('stream-params', options, status)
    expect(out).not.toBeNull()
    expect(out!.sections.length).toBeGreaterThan(0)
    expect(out!.sections[0]!.fields.length).toBeGreaterThan(0)
  })
  it('returns null when the camera exposes no configurable property', () => {
    expect(deriveFormContribution('stream-params', {}, null)).toBeNull()
  })
})

describe('applyDerivedFormProfilePatch — stream-params builderId', () => {
  it('splits a flat form patch into per-profile setProfile calls', async () => {
    const calls: Array<{ profile: string; patch: Record<string, unknown> }> = []
    await applyDerivedFormProfilePatch(
      'stream-params',
      { streamMain_codec: 'h265' },
      async (profile, patch) => {
        calls.push({ profile, patch })
      },
    )
    expect(calls).toEqual([{ profile: 'main', patch: { codec: 'h265' } }])
  })

  it('rejects a settings-based builderId', async () => {
    await expect(applyDerivedFormProfilePatch('day-night', {}, async () => {})).rejects.toThrow(
      /not a profile-based derived-form/,
    )
  })
})

const dayNightOptions: DayNightOptions = {
  modes: ['auto', 'night'],
  supportsSensitivity: true,
  sensitivity: { min: 0, max: 100, step: 1 },
  supportsSwitchDelay: true,
  switchDelaySec: { min: 0, max: 60, step: 1 },
}
const dayNightStatus: DayNightStatus = {
  mode: 'auto',
  sensitivity: 50,
  switchDelaySec: 5,
  lastFetchedAt: Date.now(),
}

const imageSettingsOptions: ImageSettingsOptions = {
  supportsBrightness: true,
  brightness: { min: 0, max: 100, step: 1 },
  supportsContrast: false,
  supportsSaturation: false,
  supportsSharpness: false,
  supportsMirror: true,
  supportsFlip: false,
  rotateOptions: [],
  whiteBalanceModes: ['auto', 'manual'],
  supportsWarmth: true,
  warmth: { min: 0, max: 100, step: 1 },
  exposureModes: [],
  backlightModes: [],
}
const imageSettingsStatus: ImageSettingsStatus = {
  brightness: 60,
  mirror: false,
  whiteBalance: 'manual',
  warmth: 40,
  lastFetchedAt: Date.now(),
}

describe('deriveFormContribution — day-night builderId', () => {
  it('produces a non-null ContributionShape from options + status', () => {
    const out = deriveFormContribution('day-night', dayNightOptions, dayNightStatus)
    expect(out).not.toBeNull()
    expect(out!.sections[0]!.fields.length).toBeGreaterThan(0)
  })
  it('returns null when the camera exposes no configurable property', () => {
    expect(
      deriveFormContribution(
        'day-night',
        { modes: [], supportsSensitivity: false, supportsSwitchDelay: false },
        null,
      ),
    ).toBeNull()
  })
})

describe('deriveFormContribution — image-settings builderId', () => {
  it('produces a non-null ContributionShape from options + status', () => {
    const out = deriveFormContribution('image-settings', imageSettingsOptions, imageSettingsStatus)
    expect(out).not.toBeNull()
    expect(out!.sections[0]!.fields.length).toBeGreaterThan(0)
  })
})

describe('parseDerivedFormSettingsPatch — day-night builderId', () => {
  it('parses a flat form patch into a DayNightSettingsPatch', () => {
    const out = parseDerivedFormSettingsPatch('day-night', {
      dayNight_mode: 'night',
      dayNight_sensitivity: 75,
    })
    expect(out).toEqual({ mode: 'night', sensitivity: 75 })
  })

  it('rejects a profile-based builderId', () => {
    expect(() => parseDerivedFormSettingsPatch('stream-params', {})).toThrow(
      /not a settings-based derived-form/,
    )
  })
})

describe('parseDerivedFormSettingsPatch — image-settings builderId', () => {
  it('parses a flat form patch into an ImageSettingsPatch', () => {
    const out = parseDerivedFormSettingsPatch('image-settings', {
      imageSettings_brightness: 80,
      imageSettings_mirror: true,
      imageSettings_whiteBalance: 'manual',
    })
    expect(out).toEqual({ brightness: 80, mirror: true, whiteBalance: 'manual' })
  })
})

describe('deriveFormContribution / applyDerivedFormProfilePatch / parseDerivedFormSettingsPatch — unknown builderId', () => {
  it('throws for an unregistered builderId', () => {
    expect(() => deriveFormContribution('not-a-real-builder', {}, null)).toThrow(
      /unknown derived-form builderId/,
    )
  })
})
