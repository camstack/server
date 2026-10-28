/** Keys a combo may name. Extend this union to support a new key. */
export type HotkeyKey =
  | 'a'
  | 'b'
  | 'c'
  | 'd'
  | 'e'
  | 'f'
  | 'g'
  | 'h'
  | 'i'
  | 'j'
  | 'k'
  | 'l'
  | 'm'
  | 'n'
  | 'o'
  | 'p'
  | 'q'
  | 'r'
  | 's'
  | 't'
  | 'u'
  | 'v'
  | 'w'
  | 'x'
  | 'y'
  | 'z'
  | '0'
  | '1'
  | '2'
  | '3'
  | '4'
  | '5'
  | '6'
  | '7'
  | '8'
  | '9'
  | 'escape'
  | 'enter'
  | '/'
  | '?'

/** `mod` is Command on macOS and Ctrl everywhere else. */
export type HotkeyModifier = 'mod' | 'shift' | 'alt'

/** `f`, `mod+f`, `mod+shift+k` — typed, so a typo does not compile. */
export type HotkeyCombo =
  | HotkeyKey
  | `${HotkeyModifier}+${HotkeyKey}`
  | `${HotkeyModifier}+${HotkeyModifier}+${HotkeyKey}`

export type HotkeyPlatform = 'mac' | 'other'

export interface ParsedCombo {
  readonly mod: boolean
  readonly shift: boolean
  readonly alt: boolean
  readonly key: string
}

/** The slice of a `KeyboardEvent` the matcher reads. */
export interface KeyEventLike {
  readonly key: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
}

export function parseCombo(combo: HotkeyCombo): ParsedCombo {
  const parts = combo.split('+')
  // A combo ending in `+` is not part of the vocabulary, so the key is always the last part.
  const key = parts[parts.length - 1] ?? ''
  const modifiers = parts.slice(0, -1)
  return {
    mod: modifiers.includes('mod'),
    shift: modifiers.includes('shift'),
    alt: modifiers.includes('alt'),
    key,
  }
}

export function detectPlatform(): HotkeyPlatform {
  if (typeof navigator === 'undefined') return 'other'
  return /mac|iphone|ipad/i.test(navigator.platform) ? 'mac' : 'other'
}

export function matchesCombo(
  event: KeyEventLike,
  combo: HotkeyCombo,
  platform: HotkeyPlatform,
): boolean {
  const want = parseCombo(combo)
  const modDown = platform === 'mac' ? event.metaKey : event.ctrlKey
  const strayDown = platform === 'mac' ? event.ctrlKey : event.metaKey
  return (
    event.key.toLowerCase() === want.key &&
    modDown === want.mod &&
    !strayDown &&
    event.shiftKey === want.shift &&
    event.altKey === want.alt
  )
}
