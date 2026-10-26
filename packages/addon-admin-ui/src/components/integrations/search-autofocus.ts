/**
 * Whether a picker search field should take focus when it opens.
 *
 * A coarse pointer (a phone) opens the software keyboard on focus. The stream
 * player already treats `(hover: none) and (pointer: coarse)` as touch. A
 * missing or throwing `matchMedia` (jsdom, a locked-down webview) focuses, so
 * a keyboard user can type immediately.
 */
const COARSE_POINTER = '(hover: none) and (pointer: coarse)'

export function shouldAutofocusSearch(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  try {
    return !window.matchMedia(COARSE_POINTER).matches
  } catch {
    return true
  }
}
