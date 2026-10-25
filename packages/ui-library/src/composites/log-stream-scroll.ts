/**
 * Pure scroll-geometry helpers for LogStream's follow-the-tail behaviour.
 *
 * Kept free of React/DOM lifecycle so the (subtle) "is the viewport pinned
 * to the bottom?" decision is unit-testable in isolation. The component
 * wires these into a `useLayoutEffect` (capture pinned-state BEFORE rows
 * grow) + a user-scroll handler (re-pin when the operator returns to the
 * bottom). See log-stream.tsx for the lifecycle.
 */

/** Default distance (px) from the bottom within which we treat the
 * viewport as "pinned". Generous enough to absorb sub-pixel rounding and
 * the height of a partially-revealed last row, tight enough that a
 * deliberate scroll-up of even one full row reads as "not pinned". */
export const PIN_THRESHOLD_PX = 40

/** The slice of scroll geometry the pin decision needs. Matches the
 * properties of an `HTMLElement` (`scrollTop` / `scrollHeight` /
 * `clientHeight`) so callers can pass the element fields directly. */
export interface ScrollGeometry {
  readonly scrollTop: number
  readonly scrollHeight: number
  readonly clientHeight: number
}

/**
 * True when the viewport is scrolled to (or within `threshold` px of) the
 * bottom of its content.
 *
 * `scrollHeight - scrollTop - clientHeight` is the distance from the
 * bottom: 0 when fully scrolled down, growing as the operator scrolls up.
 * A `<=` comparison against the threshold means an exact-bottom geometry
 * (distance 0) always counts as pinned even with a 0 threshold.
 */
export function isPinnedToBottom(
  geometry: ScrollGeometry,
  threshold: number = PIN_THRESHOLD_PX,
): boolean {
  const distanceFromBottom = geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight
  return distanceFromBottom <= threshold
}
