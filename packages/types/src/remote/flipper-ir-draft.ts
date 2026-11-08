/**
 * Turns a Flipper `.ir` file into the same draft of the `remote`
 * configuration a SmartIR file produces (`smartIrDraft`), with Flipper's
 * button names mapped to roles. Names the table does not know (an app such as
 * "Netflix") become custom buttons named as the file spells them; a button
 * whose protocol cannot be encoded comes back in `skipped` with the reason.
 * PURE and browser-safe, like the SmartIR path.
 */
import { type FlipperIrFile, flipperIrTable } from '../ir/flipper.js'
import { type SmartIrDraft, type SmartIrTarget, smartIrDraft } from './smartir-draft.js'

const NAME_ROLES: Readonly<Record<string, string>> = {
  power: 'power',
  pwr: 'power',
  poweron: 'power_on',
  on: 'power_on',
  poweroff: 'power_off',
  off: 'power_off',
  volup: 'volume_up',
  volumeup: 'volume_up',
  voldown: 'volume_down',
  volumedown: 'volume_down',
  vol: 'volume_up',
  mute: 'mute',
  chup: 'channel_up',
  channelup: 'channel_up',
  chnext: 'channel_up',
  channelnext: 'channel_up',
  chdown: 'channel_down',
  channeldown: 'channel_down',
  chprev: 'channel_down',
  channelprev: 'channel_down',
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  ok: 'ok',
  enter: 'ok',
  select: 'ok',
  back: 'back',
  return: 'back',
  home: 'home',
  menu: 'menu',
  info: 'info',
  guide: 'guide',
  exit: 'exit',
  input: 'input',
  source: 'input',
  play: 'play',
  pause: 'pause',
  playpause: 'play_pause',
  stop: 'stop',
  next: 'next',
  previous: 'previous',
  prev: 'previous',
  ff: 'fast_forward',
  fastforward: 'fast_forward',
  rew: 'rewind',
  rewind: 'rewind',
}

const DIGIT_PREFIXES = /^(?:num|number|digit|key|btn)/

/** The role a Flipper button name fills, or undefined when it is not a known one. */
export function flipperRole(name: string): string | undefined {
  const squashed = name
    .toLowerCase()
    .replace(/\+/g, 'up')
    .replace(/-/g, 'down')
    .replace(/[^a-z0-9]/g, '')
  const fixed = NAME_ROLES[squashed]
  if (fixed !== undefined) return fixed
  const digit = squashed.replace(DIGIT_PREFIXES, '')
  return /^[0-9]$/.test(digit) ? `digit_${digit}` : undefined
}

export function flipperIrDraft(file: FlipperIrFile, target: SmartIrTarget): SmartIrDraft {
  const { table, skipped } = flipperIrTable(file)
  const draft = smartIrDraft(table, target, { roleOf: flipperRole })
  return {
    ...draft,
    skipped: [...skipped.map((s) => ({ name: s.name, reason: s.reason })), ...draft.skipped],
  }
}
