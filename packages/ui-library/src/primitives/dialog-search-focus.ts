/**
 * A dialog that opens to let the operator pick something focuses its search
 * field. `showModal` otherwise lands on the Close button, which sits before
 * the dialog body, so a child effect that focused the field loses.
 *
 * A coarse pointer opens the software keyboard on focus. A missing or throwing
 * `matchMedia` (jsdom, a locked-down webview) focuses, so a keyboard user can
 * type immediately.
 */
const COARSE_POINTER = '(hover: none) and (pointer: coarse)'

export function prefersKeyboardSearchFocus(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  try {
    return !window.matchMedia(COARSE_POINTER).matches
  } catch {
    return true
  }
}

/** Focus the first search field in the dialog, when a keyboard is the pointer. */
export function focusDialogSearch(dialog: HTMLElement): void {
  if (!prefersKeyboardSearchFocus()) return
  const search = dialog.querySelector('input[type="search"]')
  if (!(search instanceof HTMLInputElement) || search.disabled) return
  search.focus()
}
