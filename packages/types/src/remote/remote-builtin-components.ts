/**
 * The built-in palette of remote layout components (D973): what the template
 * editor's "Add component" offers before any addon contributes more. The
 * core-blocks builtin serves this list through the `remote-layout-components`
 * cap; the built-in layout presets are composed from the same entries with
 * `insertComponent`, so a preset and a hand-built layout use one vocabulary.
 *
 * Roles are the existing remote roles; where the vocabulary has no word
 * (a generic minus / plus, a colour key, an app slot) the key is `custom:<key>`.
 * Printed legends are data, not interface strings, so they are not translated.
 */
import type { RemoteComponentButton, RemoteLayoutComponent } from './remote-components.js'

type ButtonInit = Pick<RemoteComponentButton, 'role'> &
  Partial<Omit<RemoteComponentButton, 'idSuffix' | 'row' | 'col' | 'role'>>

const btn = (
  idSuffix: string,
  row: number,
  col: number,
  init: ButtonInit,
): RemoteComponentButton => ({
  idSuffix,
  row,
  col,
  rowSpan: 1,
  colSpan: 1,
  ...init,
})

function rocker(
  id: string,
  name: string,
  it: string,
  frame: 'rocker-v' | 'rocker-h',
  title: string | null,
  buttons: RemoteComponentButton[],
  size: { rows: number; cols: number },
): RemoteLayoutComponent {
  return {
    id,
    name,
    nameI18n: { en: name, it },
    icon: frame === 'rocker-v' ? 'chevrons-up-down' : 'chevrons-left-right',
    category: id.includes('channel') || id.includes('volume') ? 'volume' : 'navigation',
    size,
    group: title === null ? { frame } : { frame, title },
    buttons,
  }
}

export const BUILTIN_REMOTE_COMPONENTS: readonly RemoteLayoutComponent[] = [
  {
    id: 'core:power',
    name: 'Power',
    nameI18n: { en: 'Power', it: 'Accensione' },
    icon: 'power',
    category: 'power',
    size: { rows: 1, cols: 1 },
    group: null,
    buttons: [btn('power', 0, 0, { role: 'power', shape: 'round', tone: 'danger' })],
  },
  {
    id: 'core:dpad',
    name: 'D-pad with OK',
    nameI18n: { en: 'D-pad with OK', it: 'Croce direzionale con OK' },
    icon: 'gamepad-2',
    category: 'navigation',
    size: { rows: 3, cols: 3 },
    group: { frame: 'dpad' },
    buttons: [
      btn('up', 0, 1, { role: 'up' }),
      btn('left', 1, 0, { role: 'left' }),
      btn('ok', 1, 1, { role: 'ok', shape: 'round', tone: 'accent' }),
      btn('right', 1, 2, { role: 'right' }),
      btn('down', 2, 1, { role: 'down' }),
    ],
  },
  rocker(
    'core:rocker-volume-v',
    'Volume rocker',
    'Bilanciere volume',
    'rocker-v',
    'VOL',
    [
      btn('up', 0, 0, { role: 'volume_up', shape: 'pill' }),
      btn('down', 1, 0, { role: 'volume_down', shape: 'pill' }),
    ],
    { rows: 2, cols: 1 },
  ),
  rocker(
    'core:rocker-channel-v',
    'Channel rocker',
    'Bilanciere canali',
    'rocker-v',
    'CH',
    [
      btn('up', 0, 0, { role: 'channel_up', shape: 'pill' }),
      btn('down', 1, 0, { role: 'channel_down', shape: 'pill' }),
    ],
    { rows: 2, cols: 1 },
  ),
  rocker(
    'core:rocker-h',
    'Minus / plus rocker',
    'Bilanciere meno / più',
    'rocker-h',
    null,
    [
      btn('minus', 0, 0, { role: 'custom:minus', label: '−', shape: 'pill' }),
      btn('plus', 0, 1, { role: 'custom:plus', label: '+', shape: 'pill' }),
    ],
    { rows: 1, cols: 2 },
  ),
  {
    id: 'core:keypad',
    name: 'Numeric keypad',
    nameI18n: { en: 'Numeric keypad', it: 'Tastierino numerico' },
    icon: 'grid-3x3',
    category: 'numbers',
    size: { rows: 4, cols: 3 },
    group: { frame: 'keypad' },
    buttons: [
      ...Array.from({ length: 9 }, (_, i) =>
        btn(`d${i + 1}`, Math.floor(i / 3), i % 3, { role: `digit_${i + 1}` }),
      ),
      btn('d0', 3, 1, { role: 'digit_0' }),
    ],
  },
  {
    id: 'core:colour-keys',
    name: 'Colour keys',
    nameI18n: { en: 'Colour keys', it: 'Tasti colorati' },
    icon: 'palette',
    category: 'colour',
    size: { rows: 1, cols: 4 },
    group: null,
    buttons: [
      btn('red', 0, 0, { role: 'custom:color_red', tone: 'red' }),
      btn('green', 0, 1, { role: 'custom:color_green', tone: 'green' }),
      btn('yellow', 0, 2, { role: 'custom:color_yellow', tone: 'yellow' }),
      btn('blue', 0, 3, { role: 'custom:color_blue', tone: 'blue' }),
    ],
  },
  {
    id: 'core:media-transport',
    name: 'Media transport',
    nameI18n: { en: 'Media transport', it: 'Controlli multimediali' },
    icon: 'play',
    category: 'media',
    size: { rows: 1, cols: 5 },
    group: null,
    buttons: [
      btn('rewind', 0, 0, { role: 'rewind' }),
      btn('play', 0, 1, { role: 'play' }),
      btn('pause', 0, 2, { role: 'pause' }),
      btn('forward', 0, 3, { role: 'fast_forward' }),
      btn('stop', 0, 4, { role: 'stop' }),
    ],
  },
  {
    id: 'core:apps-row',
    name: 'App row',
    nameI18n: { en: 'App row', it: 'Riga di app' },
    icon: 'app-window',
    category: 'apps',
    size: { rows: 1, cols: 4 },
    group: null,
    buttons: [1, 2, 3, 4].map((n) => btn(`app${n}`, 0, n - 1, { role: `custom:app_slot_${n}` })),
  },
  {
    id: 'core:back-home-menu',
    name: 'Back, Home, Menu',
    nameI18n: { en: 'Back, Home, Menu', it: 'Indietro, Home, Menu' },
    icon: 'house',
    category: 'navigation',
    size: { rows: 1, cols: 3 },
    group: null,
    buttons: [
      btn('back', 0, 0, { role: 'back' }),
      btn('home', 0, 1, { role: 'home' }),
      btn('menu', 0, 2, { role: 'menu' }),
    ],
  },
  {
    id: 'core:section-divider',
    name: 'Section divider',
    nameI18n: { en: 'Section divider', it: 'Divisore di sezione' },
    icon: 'separator-horizontal',
    category: 'layout',
    size: { rows: 1, cols: 1 },
    group: { frame: 'divider', title: 'Section' },
    buttons: [],
  },
  {
    id: 'core:panel',
    name: 'Titled panel',
    nameI18n: { en: 'Titled panel', it: 'Pannello con titolo' },
    icon: 'panel-top',
    category: 'layout',
    size: { rows: 2, cols: 3 },
    group: { frame: 'panel', title: 'Panel' },
    buttons: [],
  },
]

/** A built-in component by id (the presets compose from these). */
export function builtinRemoteComponent(id: string): RemoteLayoutComponent {
  const found = BUILTIN_REMOTE_COMPONENTS.find((component) => component.id === id)
  if (found === undefined) throw new Error(`no built-in remote component "${id}"`)
  return found
}
