/** How many of the two grid columns a utility button takes. */
export type HeroUtilitySpan = 1 | 2

/**
 * How `count` utility buttons lay out on the hero card's two-column grid: pairs
 * share a row and an odd one out takes the last row whole, so no row has a hole
 * (1 = full width, 2 = one row, 3 = two + one full width, 4 = 2x2, 5 = 2x2 + one
 * full width). Zero buttons is an empty list: the section is not drawn.
 * Pure, so another client can mirror it.
 */
export function heroUtilityLayout(count: number): readonly HeroUtilitySpan[] {
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0
  return Array.from({ length: n }, (_, i): HeroUtilitySpan => (i === n - 1 && n % 2 === 1 ? 2 : 1))
}
