/**
 * Display palette (D939): every preset passes the rule, a close pair is
 * named, and an unreadable stored blob is not the bundled preset.
 */
import { describe, expect, it } from 'vitest'
import { EVENT_TAXONOMY, colorForKind } from '../event-taxonomy.js'
import {
  DISPLAY_PRESETS,
  PaletteRejectedError,
  bundledCamstack,
  paintHex,
  paletteFromInput,
  paletteFromStored,
  storedFromReady,
  validatePalette,
} from '../display-palette.js'
import { paletteLegend } from '../palette-legend.js'
import { PALETTE_ENTRY_IDS } from '../palette-entries.js'
import { PALETTE_MIN_DELTA_E_MARK, deltaE00 } from '../palette-cie.js'

describe('display palette presets', () => {
  it('accepts CamStack, high contrast and the colour-blind preset', () => {
    expect(DISPLAY_PRESETS.map((row) => row.id)).toEqual(['camstack', 'high-contrast', 'okabe-ito'])
    for (const row of DISPLAY_PRESETS) {
      const verdict = validatePalette(row.swatches, row.fallbacks)
      expect(verdict.ok, row.id).toBe(true)
    }
  })

  it('keeps the CamStack anchors the viewer already shipped', () => {
    const ready = bundledCamstack()
    expect(ready.swatches.person).toEqual({ form: 'solid', hex: '#11a64c' })
    expect(ready.swatches.vehicle).toEqual({ form: 'solid', hex: '#3b82f6' })
    expect(ready.swatches.animal).toEqual({ form: 'solid', hex: '#ea6a09' })
    expect(ready.swatches.motion).toEqual({ form: 'solid', hex: '#d946ef' })
    expect(ready.swatches.recording).toEqual({ form: 'solid', hex: '#ef4444' })
    expect(ready.swatches.live).toEqual({ form: 'solid', hex: '#8d7a00' })
    expect(ready.swatches.cat).toEqual({ form: 'solid', hex: '#7268f2' })
    expect(ready.swatches.car).toEqual({ form: 'solid', hex: '#9684cf' })
    expect(ready.swatches.audio).toMatchObject({
      form: 'gradient',
      hex: '#059eb8',
      alphas: [0.3, 0.42, 0.55, 0.7, 0.85, 1],
    })
  })

  it('paints an audio leaf with the audio colour, and an unknown kind from the fallbacks', () => {
    const ready = bundledCamstack()
    expect(paintHex(ready.swatches, ready.fallbacks, 'audio-dog')).toBe('#059eb8')
    expect(paintHex(ready.swatches, ready.fallbacks, 'AUDIO-Speech')).toBe('#059eb8')
    const unknown = paintHex(ready.swatches, ready.fallbacks, 'unicorn')
    expect(ready.fallbacks).toContain(unknown)
    expect(paintHex(ready.swatches, ready.fallbacks, 'unicorn')).toBe(unknown)
  })
})

describe('validatePalette', () => {
  it('names the pair when two entries share a colour', () => {
    const ready = bundledCamstack()
    const person = ready.swatches.person
    if (person === undefined) throw new Error('person missing')
    const swatches = { ...ready.swatches, vehicle: person }
    const verdict = validatePalette(swatches, ready.fallbacks)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    const named = verdict.violations.filter((item) => item.code === 'too-close')
    expect(
      named.some(
        (item) => item.code === 'too-close' && item.left === 'person' && item.right === 'vehicle',
      ),
    ).toBe(true)
  })

  it('refuses a heatmap handle that clears ΔE 7 but still reads as the live cursor', () => {
    const ready = bundledCamstack()
    const live = ready.swatches.live
    if (live === undefined) throw new Error('live missing')
    const swatches = {
      ...ready.swatches,
      heatmapScrub: { form: 'solid' as const, hex: '#715c1d' },
    }
    const apart = deltaE00(live.hex, '#715c1d')
    expect(apart).toBeGreaterThanOrEqual(7)
    expect(apart).toBeLessThan(PALETTE_MIN_DELTA_E_MARK)
    const verdict = validatePalette(swatches, ready.fallbacks)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(
      verdict.violations.some(
        (item) =>
          item.code === 'too-close' && item.left === 'live' && item.right === 'heatmapScrub',
      ),
    ).toBe(true)
  })

  it('keeps the live cursor and the heatmap handle at least the mark floor apart', () => {
    for (const row of DISPLAY_PRESETS) {
      const live = row.swatches.live
      const heat = row.swatches.heatmapScrub
      if (live === undefined || heat === undefined) throw new Error(`${row.id} mark missing`)
      expect(deltaE00(live.hex, heat.hex), row.id).toBeGreaterThanOrEqual(PALETTE_MIN_DELTA_E_MARK)
    }
  })

  it('names the background when an entry fails 3:1', () => {
    const ready = bundledCamstack()
    const swatches = {
      ...ready.swatches,
      live: { form: 'solid' as const, hex: '#0c0a09' },
    }
    const verdict = validatePalette(swatches, ready.fallbacks)
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(
      verdict.violations.some(
        (item) =>
          item.code === 'low-contrast' && item.entry === 'live' && item.background === 'dark',
      ),
    ).toBe(true)
  })
})

describe('paletteFromInput / paletteFromStored', () => {
  it('round-trips a preset and a custom override', () => {
    const chosen = paletteFromInput({ presetId: 'high-contrast' })
    expect(paletteFromStored(storedFromReady(chosen, {}))).toEqual(chosen)

    const custom = paletteFromInput({
      presetId: 'camstack',
      overrides: { face: { form: 'solid', hex: '#1f6e6a' } },
    })
    expect(custom.customized).toBe(true)
    expect(custom.swatches.face).toEqual({ form: 'solid', hex: '#1f6e6a' })
    expect(paletteFromStored(storedFromReady(custom, { face: custom.swatches.face! }))).toEqual(
      custom,
    )
  })

  it('refuses a custom pair and names it', () => {
    const person = bundledCamstack().swatches.person
    if (person === undefined) throw new Error('person missing')
    expect(() => paletteFromInput({ presetId: 'camstack', overrides: { cat: person } })).toThrow(
      PaletteRejectedError,
    )
    try {
      paletteFromInput({ presetId: 'camstack', overrides: { cat: person } })
    } catch (err) {
      expect(err).toBeInstanceOf(PaletteRejectedError)
      if (err instanceof PaletteRejectedError) {
        expect(err.message).toContain('person')
        expect(err.message).toContain('cat')
      }
    }
  })

  it('treats an empty store as the unconfigured CamStack preset', () => {
    expect(paletteFromStored({})).toEqual(bundledCamstack())
    expect(paletteFromStored(undefined)).toMatchObject({ status: 'ready', source: 'unconfigured' })
  })

  it('does not report the default when the stored blob is unreadable', () => {
    const broken = paletteFromStored({ presetId: 'camstack', overrides: { person: 'green' } })
    expect(broken.status).toBe('unknown')
    if (broken.status === 'unknown') expect(broken.reason).toContain('unreadable')
    expect(broken).not.toEqual(bundledCamstack())
  })

  it('does not report the default when the stored palette fails the rule', () => {
    const person = bundledCamstack().swatches.person
    const broken = paletteFromStored({
      presetId: 'camstack',
      overrides: { vehicle: person },
    })
    expect(broken.status).toBe('unknown')
    if (broken.status === 'unknown') expect(broken.reason).toContain('person vs vehicle')
  })
})

describe('taxonomy colours come from the bundled palette', () => {
  it('paints every kind with the palette, and audio leaves share audio', () => {
    const ready = bundledCamstack()
    for (const entry of Object.values(EVENT_TAXONOMY)) {
      expect(entry.color, entry.kind).toBe(paintHex(ready.swatches, ready.fallbacks, entry.kind))
      expect(colorForKind(entry.kind)).toBe(entry.color)
    }
    for (const entry of Object.values(EVENT_TAXONOMY)) {
      if (entry.kind.startsWith('audio-')) continue
      expect(PALETTE_ENTRY_IDS, entry.kind).toContain(entry.kind)
    }
    expect(EVENT_TAXONOMY['audio-dog']?.color).toBe(ready.swatches.audio?.hex)
    expect(EVENT_TAXONOMY.person?.color).toBe('#11a64c')
  })
})

describe('palette legend', () => {
  it('names every entry once, with subclasses under their parent', () => {
    const groups = paletteLegend()
    const seen = groups.flatMap((group) => [group.id, ...group.children.map((child) => child.id)])
    expect(new Set(seen).size).toBe(seen.length)
    expect([...seen].sort()).toEqual([...PALETTE_ENTRY_IDS].sort())
    const vehicle = groups.find((group) => group.id === 'vehicle')
    expect(vehicle?.label).toBe('Vehicle')
    expect(vehicle?.children.some((child) => child.id === 'car' && child.label === 'Car')).toBe(
      true,
    )
    expect(groups.find((group) => group.id === 'audio')?.children).toEqual([])
    expect(groups.find((group) => group.id === 'live')?.label).toBe('Live cursor')
    expect(groups.find((group) => group.id === 'heatmapScrub')?.label).toBe('Heatmap handle')
  })
})
