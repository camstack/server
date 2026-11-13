import { RemoteLayoutPayloadSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { copyOfPreset, REMOTE_LAYOUT_PRESETS } from '../layout-presets'
import { resolveAppBrand } from '../app-brand-icons'
import { buildLayout } from '../layout-model'

describe('built-in remote layout presets', () => {
  it('offers the common physical remotes', () => {
    const ids = REMOTE_LAYOUT_PRESETS.map((p) => p.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        'samsung-classic',
        'hisense-vidaa',
        'samsung-bn59-01315',
        'hisense-erf3-vidaa',
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

  const PHYSICAL_KEYS = [
    'power',
    'input',
    'volume_up',
    'volume_down',
    'mute',
    'channel_up',
    'channel_down',
    'up',
    'down',
    'left',
    'right',
    'ok',
    'back',
    'home',
    'exit',
    'info',
    'guide',
    'play',
    'pause',
    'stop',
    'rewind',
    'fast_forward',
    ...Array.from({ length: 10 }, (_, n) => `digit_${n}`),
    'custom:color_red',
    'custom:color_green',
    'custom:color_yellow',
    'custom:color_blue',
    'custom:settings',
    'custom:ch_list',
  ]

  it.each([
    [
      'samsung-bn59-01315',
      [
        'custom:pre_ch',
        'custom:ttx_mix',
        'custom:ad_subt',
        'custom:netflix',
        'custom:prime_video',
        'custom:samsung_tv_plus',
      ],
    ],
    [
      'hisense-erf3-vidaa',
      [
        'menu',
        'custom:sleep',
        'custom:subtitle',
        'custom:txt',
        'custom:rec',
        'custom:media',
        'custom:youtube',
        'custom:netflix',
      ],
    ],
  ])('%s carries every physical key of the remote', (id, extra) => {
    const preset = REMOTE_LAYOUT_PRESETS.find((p) => p.id === id)
    const roles = new Set(preset?.layout.buttons.map((b) => b.role))
    for (const role of [...PHYSICAL_KEYS, ...extra]) expect(roles.has(role), role).toBe(true)
  })

  it('the new presets dress their app keys with app: icons the registry knows', () => {
    for (const id of ['samsung-bn59-01315', 'hisense-erf3-vidaa']) {
      const preset = REMOTE_LAYOUT_PRESETS.find((p) => p.id === id)
      const apps = preset?.layout.buttons.filter((b) => b.icon?.startsWith('app:')) ?? []
      expect(apps.length, id).toBeGreaterThanOrEqual(2)
      for (const b of apps) expect(resolveAppBrand(b.icon), `${id} ${b.icon}`).toBeDefined()
    }
  })

  it('every preset puts its colour keys on the four colour roles, toned, and none keeps a lettered role', () => {
    for (const preset of REMOTE_LAYOUT_PRESETS) {
      const roles = preset.layout.buttons.map((b) => b.role)
      expect(
        roles.some((r) => /^custom:color_[abcd]$/.test(r)),
        preset.id,
      ).toBe(false)
      for (const b of preset.layout.buttons.filter((x) => x.role.startsWith('custom:color_'))) {
        expect(b.tone, `${preset.id} ${b.role}`).toBe(b.role.slice('custom:color_'.length))
      }
    }
  })

  it('samsung-classic: row 0 is Power, the source selector, Input; row 1 the four app keys; Samsung keys carry A-D', () => {
    const layout = REMOTE_LAYOUT_PRESETS.find((p) => p.id === 'samsung-classic')?.layout
    const at = (row: number) =>
      (layout?.buttons ?? []).filter((b) => b.row === row).sort((a, b) => a.col - b.col)
    expect(at(0).map((b) => b.role)).toEqual(['power', 'source_select', 'input'])
    expect(at(1).map((b) => b.icon)).toEqual([
      'app:netflix',
      'app:youtube',
      'app:primevideo',
      'app:disneyplus',
    ])
    const colours = (layout?.buttons ?? []).filter((b) => b.role.startsWith('custom:color_'))
    expect(colours.map((b) => [b.role, b.label, b.showLegend])).toEqual([
      ['custom:color_red', 'A', true],
      ['custom:color_green', 'B', true],
      ['custom:color_yellow', 'C', true],
      ['custom:color_blue', 'D', true],
    ])
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
      {
        id: 'b',
        role: 'mute',
        row: 0,
        col: 1,
        icon: 'app:netflix',
        label: 'N',
      },
    ])
    expect(ok.buttons.map((b) => b.id)).toEqual(['a', 'b'])
    expect(ok.buttons[1]).toMatchObject({
      icon: 'app:netflix',
      label: 'N',
      rowSpan: 1,
      colSpan: 1,
    })
    expect(() =>
      buildLayout(2, 1, [
        { id: 'a', role: 'power', row: 0, col: 0, colSpan: 2 },
        { id: 'b', role: 'mute', row: 0, col: 1 },
      ]),
    ).toThrow(/overlap/)
    expect(() => buildLayout(1, 1, [{ id: 'a', role: 'power', row: 1, col: 0 }])).toThrow(/outside/)
  })
})
