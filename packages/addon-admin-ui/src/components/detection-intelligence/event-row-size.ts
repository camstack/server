/**
 * The size of the compact event rows (Archive → Review): a slider step from
 * compact to large. The thumbnail grows with it; the text stays readable at
 * every step. Remembered per viewer (guarded `localStorage`, through the
 * persisted-choice hook), so one operator's choice never reaches another.
 */
export type EventRowSize = 0 | 1 | 2

export const EVENT_ROW_SIZES: readonly EventRowSize[] = [0, 1, 2]
export const EVENT_ROW_SIZE_DEFAULT: EventRowSize = 0
export const EVENT_ROW_SIZE_STORAGE_KEY = 'camstack.archive.eventRowSize'

/** Thumbnail width per step: 72 px compact, then two larger steps. */
export const EVENT_ROW_THUMB_CLASS: Readonly<Record<EventRowSize, string>> = {
  0: 'w-[72px]',
  1: 'w-28',
  2: 'w-40',
}

/** The slider's number back to a size; anything unknown is compact. */
export function toEventRowSize(value: number): EventRowSize {
  return value === 1 || value === 2 ? value : 0
}
