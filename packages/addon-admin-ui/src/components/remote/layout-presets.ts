/**
 * The built-in starting points of the `remote` template kind: layouts that
 * mirror the physical remotes people actually hold. Code-defined and
 * read-only — they are never written to the template store. Choosing one in
 * the template editor makes an independent copy the operator edits and saves
 * as their own template, then binds actions to as always.
 *
 * Every grid is 12 columns wide so a row can be split in 2, 3, 4 or 6 equal
 * keys. A key the role vocabulary has no word for (TTX, PRE-CH, a colour key)
 * is a `custom:<key>` role; a streaming-app key wears an `app:<brand>` icon
 * (`app-brand-icons`). Key legends printed on the plastic are data, not
 * interface strings, so they are not translated.
 */
import {
  builtinRemoteComponent,
  type ComponentButtonSpec,
  type InsertOptions,
  insertComponent,
  type RemoteLayoutPayload,
} from '@camstack/types'
import { appIconKey } from './app-brand-icons'
import { type ButtonSpec, buildLayout } from './layout-model'

export interface RemoteLayoutPreset {
  readonly id: string
  readonly layout: RemoteLayoutPayload
}

const COLUMNS = 12
const THIRD = 4
const QUARTER = 3

/** A key spanning `colSpan` columns, starting at `col`. */
const key = (
  id: string,
  role: string,
  row: number,
  col: number,
  colSpan: number,
  extra: Pick<ButtonSpec, 'label' | 'icon' | 'rowSpan'> = {},
): ButtonSpec => ({ id, role, row, col, colSpan, ...extra })

const custom = (name: string): string => `custom:${name}`

/** `[col, role]` keys of one row, equal thirds. */
function thirds(
  row: number,
  roles: readonly string[],
  labels: readonly string[] = [],
): ButtonSpec[] {
  return roles.map((role, i) =>
    key(`r${row}c${i}`, role, row, i * THIRD, THIRD, {
      ...(labels[i] === undefined ? {} : { label: labels[i] }),
    }),
  )
}

/** The 3 × 3 pad: up / left ok right / down around the centre column. */
function dpad(row: number): ButtonSpec[] {
  return [
    key('up', 'up', row, THIRD, THIRD),
    key('left', 'left', row + 1, 0, THIRD),
    key('ok', 'ok', row + 1, THIRD, THIRD),
    key('right', 'right', row + 1, 2 * THIRD, THIRD),
    key('down', 'down', row + 2, THIRD, THIRD),
  ]
}

/** Four equal keys on one row, each opening a streaming app. */
function appRow(row: number, brands: readonly string[]): ButtonSpec[] {
  return brands.map((brand, i) =>
    key(`app_${brand}`, custom(`app_${brand}`), row, i * QUARTER, QUARTER, {
      icon: appIconKey(brand),
    }),
  )
}

/** A built-in component placed on the grid; a refusal is a programming error in the preset. */
interface ComponentStep {
  readonly id: string
  readonly row: number
  readonly col: number
  readonly options?: InsertOptions
}

/** A section divider across the whole grid. */
const divider = (row: number, title: string): ComponentStep => ({
  id: 'core:section-divider',
  row,
  col: 0,
  options: { scale: { cols: COLUMNS }, title },
})

/**
 * `keys` placed first, then each built-in component through `insertComponent`,
 * the same path the editor's "Add component" takes: a preset is made of the
 * vocabulary an operator builds with.
 */
function compose(
  rows: number,
  keys: readonly ButtonSpec[],
  steps: readonly ComponentStep[],
): RemoteLayoutPayload {
  let layout = buildLayout(COLUMNS, rows, keys)
  for (const step of steps) {
    const result = insertComponent(
      layout,
      builtinRemoteComponent(step.id),
      { row: step.row, col: step.col },
      step.options,
    )
    if (!result.ok) {
      throw new Error(`preset component ${step.id} at ${step.row}:${step.col}: ${result.reason}`)
    }
    layout = result.layout
  }
  return layout
}

/** A 3-wide component stretched to the 12-column grid. */
const FULL_WIDTH_3: InsertOptions = { scale: { cols: THIRD } }
const TALL_ROCKER: InsertOptions = { scale: { rows: 2, cols: THIRD } }

/** A key on the keypad's bottom row, left (`col` 0) or right (`col` 2) of the zero. */
const keypadExtra = (
  idSuffix: string,
  col: number,
  role: string,
  label: string,
): ComponentButtonSpec => ({ idSuffix, row: 3, col, rowSpan: 1, colSpan: 1, role, label })

const SAMSUNG_CLASSIC = compose(
  23,
  [
    key('input', 'input', 0, 2 * THIRD, THIRD),
    key('mute', 'mute', 7, THIRD, THIRD),
    key('ch_list', custom('ch_list'), 8, THIRD, THIRD, { label: 'CH LIST' }),
    key('settings', custom('settings'), 9, THIRD, THIRD, { label: 'Settings' }),
    key('home', 'home', 10, THIRD, THIRD),
    key('guide', 'guide', 12, 0, THIRD),
    key('e_manual', custom('e_manual'), 12, THIRD, THIRD, { label: 'e-Manual' }),
    key('info', 'info', 12, 2 * THIRD, THIRD),
    key('back', 'back', 17, 0, THIRD),
    key('exit', 'exit', 17, 2 * THIRD, THIRD),
    key('color_a', custom('color_a'), 19, 0, QUARTER, { label: 'A' }),
    key('color_b', custom('color_b'), 19, QUARTER, QUARTER, { label: 'B' }),
    key('color_c', custom('color_c'), 19, 2 * QUARTER, QUARTER, { label: 'C' }),
    key('color_d', custom('color_d'), 19, 3 * QUARTER, QUARTER, { label: 'D' }),
    key('pic_size', custom('pic_size'), 20, 0, THIRD, { label: 'P.SIZE' }),
    key('picture', custom('picture'), 20, THIRD, THIRD, { label: 'Picture' }),
    key('ad_subt', custom('ad_subt'), 20, 2 * THIRD, THIRD, { label: 'AD/SUBT' }),
  ],
  [
    { id: 'core:power', row: 0, col: 0, options: { scale: { cols: 2 } } },
    divider(1, 'Numbers'),
    {
      id: 'core:keypad',
      row: 2,
      col: 0,
      options: {
        scale: FULL_WIDTH_3.scale,
        extras: [
          keypadExtra('ttx', 0, custom('ttx_mix'), 'TTX/MIX'),
          keypadExtra('prech', 2, custom('pre_ch'), 'PRE-CH'),
        ],
      },
    },
    divider(6, 'Volume and channels'),
    { id: 'core:rocker-volume-v', row: 7, col: 0, options: TALL_ROCKER },
    { id: 'core:rocker-channel-v', row: 7, col: 2 * THIRD, options: TALL_ROCKER },
    divider(11, 'Menus'),
    divider(13, 'Navigation'),
    { id: 'core:dpad', row: 14, col: 0, options: FULL_WIDTH_3 },
    divider(18, 'Colour and picture'),
    divider(21, 'Playback'),
    { id: 'core:media-transport', row: 22, col: 1, options: { scale: { cols: 2 } } },
  ],
)

const HISENSE_APPS = ['netflix', 'youtube', 'primevideo', 'disneyplus', 'dazn', 'raiplay']

const HISENSE_VIDAA = compose(
  20,
  [
    key('input', 'input', 0, 2 * THIRD, THIRD),
    ...thirds(4, ['menu', 'home', 'exit']),
    key('guide', 'guide', 6, 0, THIRD),
    key('info', 'info', 6, 2 * THIRD, THIRD),
    key('back', 'back', 10, 0, THIRD),
    key('play_pause', 'play_pause', 10, 2 * THIRD, THIRD),
    key('mute', 'mute', 12, THIRD, THIRD),
    key('ch_list', custom('ch_list'), 13, THIRD, THIRD, { label: 'CH.LIST' }),
    key('subtitle', custom('subtitle'), 14, 0, 6, { label: 'Subtitle' }),
    key('text', custom('text'), 14, 6, 6, { label: 'Text' }),
  ],
  [
    { id: 'core:power', row: 0, col: 0, options: { scale: { cols: 2 } } },
    {
      id: 'core:panel',
      row: 1,
      col: 0,
      options: {
        scale: FULL_WIDTH_3.scale,
        title: 'Apps',
        extras: HISENSE_APPS.map(
          (brand, i): ComponentButtonSpec => ({
            idSuffix: brand,
            row: Math.floor(i / 3),
            col: i % 3,
            rowSpan: 1,
            colSpan: 1,
            role: custom(`app_${brand}`),
            icon: appIconKey(brand),
          }),
        ),
      },
    },
    { id: 'core:colour-keys', row: 3, col: 0, options: { scale: { cols: QUARTER } } },
    divider(5, 'Navigation'),
    { id: 'core:dpad', row: 7, col: 0, options: FULL_WIDTH_3 },
    divider(11, 'Volume and channels'),
    { id: 'core:rocker-volume-v', row: 12, col: 0, options: FULL_WIDTH_3 },
    { id: 'core:rocker-channel-v', row: 12, col: 2 * THIRD, options: FULL_WIDTH_3 },
    divider(15, 'Numbers'),
    { id: 'core:keypad', row: 16, col: 0, options: FULL_WIDTH_3 },
  ],
)

const SAMSUNG_SMART = buildLayout(COLUMNS, 8, [
  key('power', 'power', 0, 0, THIRD),
  key('input', 'input', 0, 2 * THIRD, THIRD),
  ...dpad(1),
  ...thirds(4, ['back', 'home', 'play_pause']),
  key('vol_up', 'volume_up', 5, 0, THIRD),
  key('mute', 'mute', 5, THIRD, THIRD, { rowSpan: 2 }),
  key('ch_up', 'channel_up', 5, 2 * THIRD, THIRD),
  key('vol_down', 'volume_down', 6, 0, THIRD),
  key('ch_down', 'channel_down', 6, 2 * THIRD, THIRD),
  ...appRow(7, ['netflix', 'primevideo', 'disneyplus', 'youtube']),
])

const LG_MAGIC = buildLayout(COLUMNS, 9, [
  key('power', 'power', 0, 0, THIRD),
  key('input', 'input', 0, 2 * THIRD, THIRD),
  key('settings', custom('settings'), 1, 0, THIRD, { label: 'Settings' }),
  key('up', 'up', 1, THIRD, THIRD),
  key('guide', 'guide', 1, 2 * THIRD, THIRD),
  key('left', 'left', 2, 0, THIRD),
  key('ok', 'ok', 2, THIRD, THIRD),
  key('right', 'right', 2, 2 * THIRD, THIRD),
  key('back', 'back', 3, 0, THIRD),
  key('down', 'down', 3, THIRD, THIRD),
  key('home', 'home', 3, 2 * THIRD, THIRD),
  key('vol_up', 'volume_up', 4, 0, THIRD, { rowSpan: 2 }),
  key('vol_down', 'volume_down', 6, 0, THIRD, { rowSpan: 2 }),
  key('mute', 'mute', 4, THIRD, THIRD),
  key('info', 'info', 5, THIRD, THIRD),
  key('menu', 'menu', 6, THIRD, THIRD),
  key('exit', 'exit', 7, THIRD, THIRD),
  key('ch_up', 'channel_up', 4, 2 * THIRD, THIRD, { rowSpan: 2 }),
  key('ch_down', 'channel_down', 6, 2 * THIRD, THIRD, { rowSpan: 2 }),
  ...appRow(8, ['netflix', 'primevideo', 'disneyplus', 'youtube']),
])

const GOOGLE_TV = buildLayout(COLUMNS, 8, [
  key('assistant', custom('assistant'), 0, 0, THIRD, { label: 'Assistant' }),
  key('input', 'input', 0, THIRD, THIRD),
  key('power', 'power', 0, 2 * THIRD, THIRD),
  ...dpad(1),
  ...thirds(4, ['back', 'home', 'guide']),
  key('vol_up', 'volume_up', 5, 0, THIRD),
  key('mute', 'mute', 5, THIRD, THIRD),
  key('ch_up', 'channel_up', 5, 2 * THIRD, THIRD),
  key('vol_down', 'volume_down', 6, 0, THIRD),
  key('play_pause', 'play_pause', 6, THIRD, THIRD),
  key('ch_down', 'channel_down', 6, 2 * THIRD, THIRD),
  ...appRow(7, ['youtube', 'netflix', 'primevideo', 'disneyplus']),
])

const APPLE_TV = buildLayout(COLUMNS, 7, [
  key('siri', custom('siri'), 0, 0, THIRD, { label: 'Siri' }),
  key('power', 'power', 0, 2 * THIRD, THIRD),
  ...dpad(1),
  ...thirds(4, ['back', 'play_pause', 'home']),
  key('vol_up', 'volume_up', 5, 0, 6),
  key('vol_down', 'volume_down', 5, 6, 6),
  key('mute', 'mute', 6, THIRD, THIRD),
])

export const REMOTE_LAYOUT_PRESETS: readonly RemoteLayoutPreset[] = [
  { id: 'samsung-classic', layout: SAMSUNG_CLASSIC },
  { id: 'hisense-vidaa', layout: HISENSE_VIDAA },
  { id: 'samsung-smart', layout: SAMSUNG_SMART },
  { id: 'lg-magic', layout: LG_MAGIC },
  { id: 'google-tv', layout: GOOGLE_TV },
  { id: 'apple-tv', layout: APPLE_TV },
]

/** An independent, editable copy of a preset's layout, or null for an unknown id. */
export function copyOfPreset(id: string): RemoteLayoutPayload | null {
  const preset = REMOTE_LAYOUT_PRESETS.find((p) => p.id === id)
  if (preset === undefined) return null
  return {
    ...preset.layout,
    buttons: preset.layout.buttons.map((b) => ({ ...b })),
  }
}
