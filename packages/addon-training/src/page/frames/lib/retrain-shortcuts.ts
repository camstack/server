/**
 * The Retrain page's keyboard map — pure, so the whole table is tested.
 *
 * Annotation is a repetitive job done hundreds of frames at a time, and every
 * trip to the mouse for "next frame" or "this one is a car" is the cost that
 * decides whether the dataset gets annotated at all. The rule that matters
 * just as much: while the operator is TYPING (a label, a sub-label), no key
 * does anything but type — Backspace in a label field must never delete a box.
 * Save is the one exception, as it is in every editor.
 */
import type { RetrainMacroClass } from '@camstack/types'

/** The part of a KeyboardEvent the map reads. */
export interface ShortcutKey {
  readonly key: string
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
  /** Focus is in an input, select, textarea or contenteditable. */
  readonly typing: boolean
}

export type ShortcutAction =
  | { readonly kind: 'next-frame' }
  | { readonly kind: 'prev-frame' }
  | { readonly kind: 'delete' }
  | { readonly kind: 'set-class'; readonly macroClass: RetrainMacroClass }
  | { readonly kind: 'accept' }
  | { readonly kind: 'accept-all' }
  | { readonly kind: 'toggle-model-error' }
  | { readonly kind: 'toggle-complete' }
  | { readonly kind: 'undo' }
  | { readonly kind: 'redo' }
  | { readonly kind: 'save' }
  | { readonly kind: 'select-next' }
  | { readonly kind: 'select-prev' }
  | { readonly kind: 'deselect' }
  | { readonly kind: 'zoom-in' }
  | { readonly kind: 'zoom-out' }
  | { readonly kind: 'zoom-fit' }

/** The class hotkeys, in the order of the class dropdown. */
export const CLASS_HOTKEYS: readonly RetrainMacroClass[] = [
  'person',
  'vehicle',
  'animal',
  'package',
  'face',
  'plate',
]

/** Is this element one where keys mean text? */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== 'object' || !('tagName' in target)) return false
  const tag = String(target.tagName).toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return 'isContentEditable' in target && target.isContentEditable === true
}

export function resolveShortcut(event: ShortcutKey): ShortcutAction | null {
  const mod = event.ctrlKey || event.metaKey
  const lower = event.key.toLowerCase()
  if (mod && !event.altKey) {
    if (lower === 's' && !event.shiftKey) return { kind: 'save' }
    if (event.typing) return null
    if (lower === 'z') return event.shiftKey ? { kind: 'redo' } : { kind: 'undo' }
    if (lower === 'y' && !event.shiftKey) return { kind: 'redo' }
    return null
  }
  if (event.typing || mod || event.altKey) return null
  switch (event.key) {
    case 'ArrowRight':
      return { kind: 'next-frame' }
    case 'ArrowLeft':
      return { kind: 'prev-frame' }
    case 'Delete':
    case 'Backspace':
      return { kind: 'delete' }
    case 'Escape':
      return { kind: 'deselect' }
    case 'Tab':
      return event.shiftKey ? { kind: 'select-prev' } : { kind: 'select-next' }
    case 'ArrowDown':
      return { kind: 'select-next' }
    case 'ArrowUp':
      return { kind: 'select-prev' }
    case '+':
    case '=':
      return { kind: 'zoom-in' }
    case '-':
    case '_':
      return { kind: 'zoom-out' }
    case '0':
      return { kind: 'zoom-fit' }
    default:
      break
  }
  const digit = Number.parseInt(event.key, 10)
  if (Number.isInteger(digit) && digit >= 1 && digit <= CLASS_HOTKEYS.length) {
    const macroClass = CLASS_HOTKEYS[digit - 1]
    return macroClass !== undefined ? { kind: 'set-class', macroClass } : null
  }
  if (lower === 'a') return event.shiftKey ? { kind: 'accept-all' } : { kind: 'accept' }
  if (lower === 'e' && !event.shiftKey) return { kind: 'toggle-model-error' }
  if (lower === 'c' && !event.shiftKey) return { kind: 'toggle-complete' }
  return null
}

/** The help rows the page shows, one per shortcut; the texts live in the `shortcuts.*` bundle keys. */
export const RETRAIN_SHORTCUTS = [
  'frameNav',
  'drawBox',
  'moveBox',
  'deleteBox',
  'classes',
  'accept',
  'acceptAll',
  'modelError',
  'complete',
  'selectNext',
  'deselect',
  'undo',
  'redo',
  'save',
  'zoom',
  'pan',
] as const
