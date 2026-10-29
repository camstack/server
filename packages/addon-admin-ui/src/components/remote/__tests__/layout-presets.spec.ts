import { RemoteLayoutPayloadSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { copyOfPreset, REMOTE_LAYOUT_PRESETS } from '../layout-presets'
import { buildLayout } from '../layout-model'

describe('built-in remote layout presets', () => {
  it('offers the common physical remotes', () => {
    const ids = REMOTE_LAYOUT_PRESETS.map((p) => p.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        'samsung-classic',
        'hisense-vidaa',
        'samsung-smart',
        'lg-magic',
        'google-tv',
        'apple-tv',
      ]),
    )
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each(
    REMOTE_LAYOUT_PRESETS.map((p) => [p.id, p] as const),
  )('%s parses with the template schema (no overlaps, nothing outside the grid)', (_id, preset) => {
    const parsed = RemoteLayoutPayloadSchema.safeParse(preset.layout)
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
    expect(preset.layout.buttons.length).toBeGreaterThan(5)
  })

  it('the Samsung classic carries its legacy keys as custom roles', () => {
    const preset = REMOTE_LAYOUT_PRESETS.find((p) => p.id === 'samsung-classic')
    const roles = new Set(preset?.layout.buttons.map((b) => b.role))
    for (const role of ['power', 'input', 'digit_0', 'ok', 'custom:ttx_mix', 'custom:pre_ch']) {
      expect(roles.has(role), role).toBe(true)
    }
  })

  it('the Hisense preset has a row of app buttons wearing app: icons', () => {
    const preset = REMOTE_LAYOUT_PRESETS.find((p) => p.id === 'hisense-vidaa')
    const apps = preset?.layout.buttons.filter((b) => b.icon?.startsWith('app:')) ?? []
    expect(apps.length).toBeGreaterThanOrEqual(4)
  })

  it('creating from a preset returns an independent editable copy', () => {
    const preset = REMOTE_LAYOUT_PRESETS[0]
    if (preset === undefined) throw new Error('no presets')
    const copy = copyOfPreset(preset.id)
    expect(copy).toEqual(preset.layout)
    expect(copy).not.toBe(preset.layout)
    expect(copy?.buttons[0]).not.toBe(preset.layout.buttons[0])
    expect(copyOfPreset('missing')).toBeNull()
  })
})

describe('buildLayout', () => {
  it('places buttons through the model and refuses an overlap', () => {
    const ok = buildLayout(2, 1, [
      { id: 'a', role: 'power', row: 0, col: 0 },
      { id: 'b', role: 'mute', row: 0, col: 1, icon: 'app:netflix', label: 'N' },
    ])
    expect(ok.buttons.map((b) => b.id)).toEqual(['a', 'b'])
    expect(ok.buttons[1]).toMatchObject({ icon: 'app:netflix', label: 'N', rowSpan: 1, colSpan: 1 })
    expect(() =>
      buildLayout(2, 1, [
        { id: 'a', role: 'power', row: 0, col: 0, colSpan: 2 },
        { id: 'b', role: 'mute', row: 0, col: 1 },
      ]),
    ).toThrow(/overlap/)
    expect(() => buildLayout(1, 1, [{ id: 'a', role: 'power', row: 1, col: 0 }])).toThrow(/outside/)
  })
})
