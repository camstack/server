/**
 * What a remote key is CALLED and what it LOOKS like, for every role (D963),
 * shared by the admin UI and the viewer. A role is data on the wire; each
 * client resolves its name from `label` (English and Italian side by side) and
 * its glyph from `icon`, a lucide id from the shared icon catalogue — the
 * server sends an id, a client maps it to its own icon set.
 *
 * `legend` is text printed on the key INSTEAD of a glyph (a digit has no
 * pictogram): a client that can draw text shows it, one that cannot falls back
 * to `icon`.
 */
import { t } from '../device/cap-vocabulary/l10n.js'
import type { L10n, VocabIcon, VocabLocale } from '../device/cap-vocabulary/types.js'
import { customKeyOfRole, REMOTE_KNOWN_ROLES, type RemoteKnownRole } from './remote-roles.js'

export interface RemoteRoleVocabEntry {
  readonly label: L10n
  readonly icon: VocabIcon
  readonly legend?: string
}

function digit(n: string): RemoteRoleVocabEntry {
  return { label: t(n, n), icon: 'hash', legend: n }
}

/** One entry per known role: the compiler refuses a role without one. */
export const REMOTE_ROLE_VOCABULARY: Readonly<Record<RemoteKnownRole, RemoteRoleVocabEntry>> = {
  power: { label: t('Power', 'Accensione'), icon: 'power' },
  power_on: { label: t('Power on', 'Accendi'), icon: 'power' },
  power_off: { label: t('Power off', 'Spegni'), icon: 'power-off' },
  volume_up: { label: t('Volume up', 'Volume su'), icon: 'volume-2' },
  volume_down: { label: t('Volume down', 'Volume giù'), icon: 'volume-1' },
  mute: { label: t('Mute', 'Muto'), icon: 'volume-x' },
  channel_up: { label: t('Channel up', 'Canale su'), icon: 'chevrons-up' },
  channel_down: { label: t('Channel down', 'Canale giù'), icon: 'chevrons-down' },
  up: { label: t('Up', 'Su'), icon: 'chevron-up' },
  down: { label: t('Down', 'Giù'), icon: 'chevron-down' },
  left: { label: t('Left', 'Sinistra'), icon: 'chevron-left' },
  right: { label: t('Right', 'Destra'), icon: 'chevron-right' },
  ok: { label: t('OK', 'OK'), icon: 'circle-dot' },
  back: { label: t('Back', 'Indietro'), icon: 'corner-up-left' },
  home: { label: t('Home', 'Home'), icon: 'house' },
  menu: { label: t('Menu', 'Menu'), icon: 'menu' },
  info: { label: t('Info', 'Info'), icon: 'info' },
  guide: { label: t('Guide', 'Guida'), icon: 'book-open' },
  exit: { label: t('Exit', 'Esci'), icon: 'log-out' },
  input: { label: t('Input', 'Ingresso'), icon: 'log-in' },
  play: { label: t('Play', 'Riproduci'), icon: 'play' },
  pause: { label: t('Pause', 'Pausa'), icon: 'pause' },
  play_pause: { label: t('Play / pause', 'Riproduci / pausa'), icon: 'circle-play' },
  stop: { label: t('Stop', 'Stop'), icon: 'square' },
  next: { label: t('Next', 'Successivo'), icon: 'skip-forward' },
  previous: { label: t('Previous', 'Precedente'), icon: 'skip-back' },
  fast_forward: { label: t('Fast forward', 'Avanti veloce'), icon: 'fast-forward' },
  rewind: { label: t('Rewind', 'Indietro veloce'), icon: 'rewind' },
  digit_0: digit('0'),
  digit_1: digit('1'),
  digit_2: digit('2'),
  digit_3: digit('3'),
  digit_4: digit('4'),
  digit_5: digit('5'),
  digit_6: digit('6'),
  digit_7: digit('7'),
  digit_8: digit('8'),
  digit_9: digit('9'),
}

/** The glyph of a `custom:<key>` role (an operator's own key) and of an unknown role. */
export const REMOTE_CUSTOM_ROLE_ICON: VocabIcon = 'circle'

/** A role with no label of its own: `custom:hdmi_1` → `hdmi 1`. */
function humanKey(role: string): string {
  return (customKeyOfRole(role) ?? role).replace(/_/g, ' ')
}

function isKnown(role: string): role is RemoteKnownRole {
  return (REMOTE_KNOWN_ROLES as readonly string[]).includes(role)
}

/** The glyph for any role; a custom or unknown role wears the fallback. */
export function remoteRoleIcon(role: string): VocabIcon {
  return isKnown(role) ? REMOTE_ROLE_VOCABULARY[role].icon : REMOTE_CUSTOM_ROLE_ICON
}

/** The printed legend of a role (a digit), or undefined when it has none. */
export function remoteRoleLegend(role: string): string | undefined {
  return isKnown(role) ? REMOTE_ROLE_VOCABULARY[role].legend : undefined
}

/** The name of any role in `locale`; a custom role is named by its key. */
export function remoteRoleLabel(role: string, locale: VocabLocale): string {
  return isKnown(role) ? REMOTE_ROLE_VOCABULARY[role].label[locale] : humanKey(role)
}
