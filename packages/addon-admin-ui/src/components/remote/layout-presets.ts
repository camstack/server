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
import type { RemoteLayoutPayload } from '@camstack/types'
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

/** 1-9 in three rows, then `[left] 0 [right]` on the fourth. */
function digits(row: number, left?: ButtonSpec, right?: ButtonSpec): ButtonSpec[] {
  const out: ButtonSpec[] = []
  for (let n = 1; n <= 9; n += 1) {
    out.push(
      key(`d${n}`, `digit_${n}`, row + Math.floor((n - 1) / 3), ((n - 1) % 3) * THIRD, THIRD),
    )
  }
  out.push(key('zero', 'digit_0', row + 3, THIRD, THIRD))
  if (left !== undefined) out.push({ ...left, row: row + 3, col: 0, colSpan: THIRD })
  if (right !== undefined) out.push({ ...right, row: row + 3, col: 2 * THIRD, colSpan: THIRD })
  return out
}

/** Four equal keys on one row, each opening a streaming app. */
function appRow(row: number, brands: readonly string[]): ButtonSpec[] {
  return brands.map((brand, i) =>
    key(`app_${brand}`, custom(`app_${brand}`), row, i * QUARTER, QUARTER, {
      icon: appIconKey(brand),
    }),
  )
}

const SAMSUNG_CLASSIC = buildLayout(COLUMNS, 17, [
  key('power', 'power', 0, 0, THIRD),
  key('input', 'input', 0, 2 * THIRD, THIRD),
  ...digits(
    1,
    { id: 'ttx', role: custom('ttx_mix'), row: 0, col: 0, label: 'TTX/MIX' },
    { id: 'prech', role: custom('pre_ch'), row: 0, col: 0, label: 'PRE-CH' },
  ),
  key('vol_up', 'volume_up', 5, 0, THIRD, { rowSpan: 2 }),
  key('vol_down', 'volume_down', 7, 0, THIRD, { rowSpan: 2 }),
  key('mute', 'mute', 5, THIRD, THIRD),
  key('ch_list', custom('ch_list'), 6, THIRD, THIRD, { label: 'CH LIST' }),
  key('settings', custom('settings'), 7, THIRD, THIRD, { label: 'Settings' }),
  key('home', 'home', 8, THIRD, THIRD),
  key('ch_up', 'channel_up', 5, 2 * THIRD, THIRD, { rowSpan: 2 }),
  key('ch_down', 'channel_down', 7, 2 * THIRD, THIRD, { rowSpan: 2 }),
  key('guide', 'guide', 9, 0, THIRD),
  key('e_manual', custom('e_manual'), 9, THIRD, THIRD, { label: 'e-Manual' }),
  key('info', 'info', 9, 2 * THIRD, THIRD),
  ...dpad(10),
  key('back', 'back', 12, 0, THIRD),
  key('exit', 'exit', 12, 2 * THIRD, THIRD),
  key('color_a', custom('color_a'), 13, 0, QUARTER, { label: 'A' }),
  key('color_b', custom('color_b'), 13, QUARTER, QUARTER, { label: 'B' }),
  key('color_c', custom('color_c'), 13, 2 * QUARTER, QUARTER, { label: 'C' }),
  key('color_d', custom('color_d'), 13, 3 * QUARTER, QUARTER, { label: 'D' }),
  key('pic_size', custom('pic_size'), 14, 0, THIRD, { label: 'P.SIZE' }),
  key('picture', custom('picture'), 14, THIRD, THIRD, { label: 'Picture' }),
  key('ad_subt', custom('ad_subt'), 14, 2 * THIRD, THIRD, { label: 'AD/SUBT' }),
  key('rewind', 'rewind', 15, 0, QUARTER),
  key('play', 'play', 15, QUARTER, QUARTER),
  key('pause', 'pause', 15, 2 * QUARTER, QUARTER),
  key('forward', 'fast_forward', 15, 3 * QUARTER, QUARTER),
  key('stop', 'stop', 16, THIRD, THIRD),
])

const HISENSE_VIDAA = buildLayout(COLUMNS, 15, [
  key('power', 'power', 0, 0, THIRD),
  key('input', 'input', 0, 2 * THIRD, THIRD),
  ...appRow(1, ['netflix', 'youtube', 'primevideo', 'disneyplus']),
  ...appRow(2, ['dazn', 'raiplay', 'spotify', 'plex']),
  key('red', custom('color_red'), 3, 0, QUARTER, { label: 'Red' }),
  key('green', custom('color_green'), 3, QUARTER, QUARTER, { label: 'Green' }),
  key('yellow', custom('color_yellow'), 3, 2 * QUARTER, QUARTER, { label: 'Yellow' }),
  key('blue', custom('color_blue'), 3, 3 * QUARTER, QUARTER, { label: 'Blue' }),
  ...thirds(4, ['menu', 'home', 'exit']),
  key('guide', 'guide', 5, 0, THIRD),
  key('info', 'info', 5, 2 * THIRD, THIRD),
  ...dpad(5),
  key('back', 'back', 7, 0, THIRD),
  key('play_pause', 'play_pause', 7, 2 * THIRD, THIRD),
  key('vol_up', 'volume_up', 8, 0, THIRD),
  key('mute', 'mute', 8, THIRD, THIRD),
  key('ch_up', 'channel_up', 8, 2 * THIRD, THIRD),
  key('vol_down', 'volume_down', 9, 0, THIRD),
  key('ch_list', custom('ch_list'), 9, THIRD, THIRD, { label: 'CH.LIST' }),
  key('ch_down', 'channel_down', 9, 2 * THIRD, THIRD),
  key('subtitle', custom('subtitle'), 10, 0, 6, { label: 'Subtitle' }),
  key('text', custom('text'), 10, 6, 6, { label: 'Text' }),
  ...digits(11),
])

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
