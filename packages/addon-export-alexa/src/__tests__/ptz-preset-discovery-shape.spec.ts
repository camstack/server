/**
 * The `ptz.preset` ModeController must be a capability Alexa accepts, or the
 * Event Gateway rejects the whole AddOrUpdateReport and Discover drops the
 * camera — every endpoint of it, live view included:
 *
 *   - Amazon: "You must include a minimum of two mode objects" — a camera with
 *     one preset got "Failed to parse discovery payload. Payload does not
 *     match required Schema";
 *   - two presets with the same name produce two identical mode values and
 *     friendly names — "Invalid capability received." (cameras whose presets
 *     read `Stanza`, `Stanza` or `CamStack Home` ×3).
 *
 * Names are de-duplicated (first wins, case-insensitively — the SetMode
 * handler resolves a value to the FIRST preset of that name), and with fewer
 * than two distinct names the capability is not declared at all.
 */
import { describe, expect, it } from 'vitest'
import { buildParentCameraEndpoint } from '../endpoints/builder.js'

function cameraWithPresets(ptzPresetNames: readonly string[]) {
  return buildParentCameraEndpoint({
    deviceId: 108,
    stableId: 's',
    friendlyName: 'Camera',
    isDoorbell: false,
    hasIntercom: false,
    hasMotion: true,
    ptzPresetNames,
    hasPtz: true,
  })
}

function presetModes(ptzPresetNames: readonly string[]): string[] | undefined {
  const cap = cameraWithPresets(ptzPresetNames).capabilities.find(
    (c) => c.interface === 'Alexa.ModeController' && c.instance === 'ptz.preset',
  )
  const modes = (cap?.configuration as { supportedModes?: Array<{ value: string }> } | undefined)
    ?.supportedModes
  return modes?.map((m) => m.value)
}

describe('ptz.preset ModeController shape', () => {
  it('declares no preset capability for a single preset (Amazon requires two modes)', () => {
    expect(presetModes(['Preset1'])).toBeUndefined()
  })

  it('drops duplicate preset names, first wins', () => {
    expect(presetModes(['Stanza', 'Stanza', 'Carol'])).toEqual([
      'ptz.preset.Stanza',
      'ptz.preset.Carol',
    ])
  })

  it('treats names that differ only in case as duplicates', () => {
    expect(presetModes(['Home', 'home', 'Door'])).toEqual(['ptz.preset.Home', 'ptz.preset.Door'])
  })

  it('declares nothing when duplicates leave fewer than two names', () => {
    expect(presetModes(['CamStack Home', 'CamStack Home'])).toBeUndefined()
  })

  it('every declared ModeController has at least two unique modes', () => {
    for (const names of [['a', 'b'], ['a', 'a', 'b', 'b', 'c'], ['x']]) {
      const caps = cameraWithPresets(names).capabilities.filter(
        (c) => c.interface === 'Alexa.ModeController',
      )
      for (const cap of caps) {
        const values = (
          cap.configuration as { supportedModes: Array<{ value: string }> }
        ).supportedModes.map((m) => m.value)
        expect(values.length).toBeGreaterThanOrEqual(2)
        expect(new Set(values.map((v) => v.toLowerCase())).size).toBe(values.length)
      }
    }
  })

  it('keeps an unproblematic preset list unchanged', () => {
    expect(presetModes(['stanza', 'letto', 'dave'])).toEqual([
      'ptz.preset.stanza',
      'ptz.preset.letto',
      'ptz.preset.dave',
    ])
  })
})
