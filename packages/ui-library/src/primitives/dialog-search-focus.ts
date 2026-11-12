/**
 * A dialog that opens to let the operator pick something focuses its search
 * field - the one input marked `data-dialog-autofocus`, nothing else. `showModal` otherwise lands on the Close button, which sits before
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

/**
 * Opt-in marker. A picker puts it on the one search input a dialog should open
 * on; any other search field (a table's filter, a nested list) is left alone.
 */
export const DIALOG_AUTOFOCUS_ATTRIBUTE = 'data-dialog-autofocus'

const FIELD_TAGS: ReadonlySet<string> = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/** True when focus already sits on a field the dialog's own content chose (an `autoFocus` input). */
function focusIsOnDialogField(dialog: HTMLElement): boolean {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || active === dialog || !dialog.contains(active)) {
    return false
  }
  return FIELD_TAGS.has(active.tagName) || active.isContentEditable
}

/**
 * Focus the marked search field of the dialog, when a keyboard is the pointer.
 * Never moves focus off a field the dialog content already focused itself.
 */
export function focusDialogSearch(dialog: HTMLElement): void {
  if (!prefersKeyboardSearchFocus()) return
  if (focusIsOnDialogField(dialog)) return
  const search = dialog.querySelector(`input[${DIALOG_AUTOFOCUS_ATTRIBUTE}]`)
  if (!(search instanceof HTMLInputElement) || search.disabled) return
  search.focus()
}
