export type {
  HotkeyCombo,
  HotkeyKey,
  HotkeyModifier,
  HotkeyPlatform,
  KeyEventLike,
} from './combo'
export { detectPlatform, matchesCombo, parseCombo } from './combo'
export type {
  HotkeyHandler,
  HotkeyProviderProps,
  HotkeyScopeProps,
  UseHotkeyOptions,
} from './hotkey-provider'
export { FALLBACK_SCOPE, HotkeyProvider, HotkeyScope, useHotkey } from './hotkey-provider'
export type { UseSearchFieldHotkeyOptions } from './use-search-field-hotkey'
export { useSearchFieldHotkey } from './use-search-field-hotkey'
