/** Text limits for what goes onto a camera. */

/** Cut to `max` characters, spending the last three on an ellipsis. */
export function limitText(text: string, max: number | undefined): string {
  if (max === undefined || max <= 0) return text
  if (text.length <= max) return text
  if (max <= 3) return text.slice(0, max)
  return `${text.slice(0, max - 3)}...`
}
