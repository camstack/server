/**
 * The remote's keys by ROLE (the `remote` cap's vocabulary): the glyph and the
 * word each known role is drawn with, and the pad rows the remote view lays
 * them out in. A key the device declares with its own label keeps it; a role
 * this table does not know is drawn by its label in the last row.
 */
import type { UiTextFn } from '../../../contexts/ui-text'
import type { CardGlyph } from '../icons'
import type { CardRemoteKey } from './model'

interface RoleSpec {
  readonly glyph?: CardGlyph
  /** Drawn as the glyph alone; the label stays the accessible name. */
  readonly iconOnly?: boolean
  readonly label: (t: UiTextFn) => string
}

const ROLES: Readonly<Record<string, RoleSpec>> = {
  power: {
    glyph: 'power',
    iconOnly: true,
    label: (t) => t('uiLibrary.deviceCard.remoteKey.power', 'Power'),
  },
  power_on: { glyph: 'power', label: (t) => t('uiLibrary.deviceCard.turnOn', 'Turn on') },
  power_off: { glyph: 'power', label: (t) => t('uiLibrary.deviceCard.turnOff', 'Turn off') },
  source_select: {
    glyph: 'source',
    label: (t) => t('uiLibrary.deviceCard.media.source', 'Source'),
  },
  input: { glyph: 'source', label: (t) => t('uiLibrary.deviceCard.media.source', 'Source') },
  home: { glyph: 'home', label: (t) => t('uiLibrary.deviceCard.remoteKey.home', 'Home') },
  up: { glyph: 'up', iconOnly: true, label: (t) => t('uiLibrary.deviceCard.remoteKey.up', 'Up') },
  down: {
    glyph: 'down',
    iconOnly: true,
    label: (t) => t('uiLibrary.deviceCard.remoteKey.down', 'Down'),
  },
  left: {
    glyph: 'left',
    iconOnly: true,
    label: (t) => t('uiLibrary.deviceCard.remoteKey.left', 'Left'),
  },
  right: {
    glyph: 'right',
    iconOnly: true,
    label: (t) => t('uiLibrary.deviceCard.remoteKey.right', 'Right'),
  },
  ok: { label: (t) => t('uiLibrary.deviceCard.remoteKey.ok', 'OK') },
  back: { glyph: 'return', label: (t) => t('uiLibrary.deviceCard.remoteKey.back', 'Back') },
  menu: { glyph: 'listMenu', label: (t) => t('uiLibrary.deviceCard.remoteKey.menu', 'Menu') },
  info: { glyph: 'info', label: (t) => t('uiLibrary.deviceCard.remoteKey.info', 'Info') },
  volume_up: { glyph: 'plus', label: (t) => t('uiLibrary.deviceCard.remoteKey.vol', 'Vol') },
  volume_down: { glyph: 'minus', label: (t) => t('uiLibrary.deviceCard.remoteKey.vol', 'Vol') },
  channel_up: { glyph: 'plus', label: (t) => t('uiLibrary.deviceCard.remoteKey.ch', 'Ch') },
  channel_down: { glyph: 'minus', label: (t) => t('uiLibrary.deviceCard.remoteKey.ch', 'Ch') },
  mute: {
    glyph: 'mute',
    iconOnly: true,
    label: (t) => t('uiLibrary.deviceCard.media.mute', 'Mute'),
  },
  previous: {
    glyph: 'previous',
    iconOnly: true,
    label: (t) => t('uiLibrary.deviceCard.media.previous', 'Previous'),
  },
  play_pause: {
    glyph: 'playPause',
    iconOnly: true,
    label: (t) => t('uiLibrary.deviceCard.media.playPause', 'Play / pause'),
  },
  play: {
    glyph: 'play',
    iconOnly: true,
    label: (t) => t('uiLibrary.deviceCard.media.play', 'Play'),
  },
  pause: { glyph: 'pause', iconOnly: true, label: (t) => t('uiLibrary.deviceCard.pause', 'Pause') },
  stop: { glyph: 'stop', iconOnly: true, label: (t) => t('uiLibrary.deviceCard.stop', 'Stop') },
  next: {
    glyph: 'next',
    iconOnly: true,
    label: (t) => t('uiLibrary.deviceCard.media.next', 'Next'),
  },
}

/** The key the card draws for a declared role (its label wins over the default word). */
export function remoteKeyOf(
  role: string,
  label: string | null | undefined,
  t: UiTextFn,
): CardRemoteKey {
  const spec = ROLES[role]
  return {
    id: role,
    label: label ?? spec?.label(t) ?? role,
    ...(spec?.glyph === undefined ? {} : { glyph: spec.glyph }),
  }
}

/** The key is drawn as its glyph alone (its label is the accessible name). */
export function remoteKeyIconOnly(key: CardRemoteKey): boolean {
  return key.glyph !== undefined && ROLES[key.id]?.iconOnly === true
}

export type RemotePadRow =
  | { readonly kind: 'row'; readonly keys: readonly CardRemoteKey[] }
  | { readonly kind: 'dpad'; readonly keys: readonly CardRemoteKey[] }
  | { readonly kind: 'pairs'; readonly keys: readonly CardRemoteKey[] }

const GROUPS: readonly {
  readonly kind: RemotePadRow['kind']
  readonly roles: readonly string[]
}[] = [
  { kind: 'row', roles: ['power', 'power_on', 'power_off', 'source_select', 'input', 'home'] },
  { kind: 'dpad', roles: ['up', 'left', 'ok', 'right', 'down'] },
  { kind: 'row', roles: ['back', 'menu', 'info', 'guide', 'exit'] },
  { kind: 'pairs', roles: ['volume_up', 'channel_up', 'volume_down', 'channel_down'] },
  {
    kind: 'row',
    roles: [
      'mute',
      'previous',
      'rewind',
      'play_pause',
      'play',
      'pause',
      'stop',
      'fast_forward',
      'next',
    ],
  },
]

const DPAD: ReadonlySet<string> = new Set(['up', 'down', 'left', 'right', 'ok'])

/**
 * The pad layout of a remote that declares a direction pad (a TV, a media
 * box): power and source on top, the pad, back / menu / info, volume and
 * channel in pairs, the transport; whatever is left closes it. A remote
 * without a pad is one row; null means: lay it out flat.
 */
export function remotePadRows(keys: readonly CardRemoteKey[]): readonly RemotePadRow[] | null {
  if (!keys.some((k) => DPAD.has(k.id))) return null
  const byId = new Map(keys.map((k) => [k.id, k]))
  const placed = new Set<string>()
  const rows: RemotePadRow[] = []
  for (const group of GROUPS) {
    const found = group.roles.flatMap((role) => {
      const key = byId.get(role)
      return key === undefined ? [] : [key]
    })
    found.forEach((k) => placed.add(k.id))
    if (found.length > 0) rows.push({ kind: group.kind, keys: found })
  }
  const rest = keys.filter((k) => !placed.has(k.id))
  if (rest.length > 0) rows.push({ kind: 'row', keys: rest })
  return rows
}
