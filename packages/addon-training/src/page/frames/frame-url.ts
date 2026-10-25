/**
 * The open frame lives in the URL (`?frame=<id>`), next to the corpus filter's
 * own keys: the modal opens from it, it survives a reload and can be sent to
 * someone. Replaced, never pushed — stepping through frames is not navigation.
 */

export const FRAME_PARAM = 'frame'

/** The frame id in a location search string, or `null`. */
export function readFrameParam(search: string): string | null {
  const raw = new URLSearchParams(search).get(FRAME_PARAM)?.trim() ?? ''
  return raw === '' ? null : raw
}

/** Write (or clear) the frame on `params` in place. Leaves other keys alone. */
export function applyFrameToSearchParams(params: URLSearchParams, frameId: string | null): void {
  if (frameId === null || frameId === '') params.delete(FRAME_PARAM)
  else params.set(FRAME_PARAM, frameId)
}

/** Replace the location's `frame` key (keeps every other key). */
export function replaceFrameInUrl(frameId: string | null): void {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  applyFrameToSearchParams(url.searchParams, frameId)
  window.history.replaceState({}, '', url.toString())
}
