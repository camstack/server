/**
 * Predicates over a Tailwind class string, used by layout tests to assert a
 * responsive DECISION rather than a class literal.
 *
 * Why this exists: the two mobile defects fixed in 2026-08 were both "a
 * utility that should have been behind a breakpoint was applied at every
 * width" — a pinned first table column, a truncated settings value. The
 * invariant worth guarding is exactly that: `sticky` must not appear
 * unconditionally on the name column, `truncate` must not appear
 * unconditionally on a settings value. Asserting the whole `className`
 * byte-for-byte would guard something else (churn) and would go stale the
 * first time a padding token moves — see `docs/ui/conventions.md`,
 * "Frozen-string tests have an expiry date".
 *
 * A Tailwind class is `variant:variant:utility`. Everything before the last
 * `:` is a condition (breakpoint, state, container query); a class with no
 * `:` applies at every width and in every state.
 */

/** Split a class string into non-empty tokens. `undefined` ⇒ no tokens. */
export function classTokens(className: string | undefined): readonly string[] {
  if (className === undefined) return []
  return className.split(/\s+/).filter((token) => token.length > 0)
}

/** Strip Tailwind's `!` important marker (either position) from a token. */
function stripImportant(token: string): string {
  const noPrefix = token.startsWith('!') ? token.slice(1) : token
  return noPrefix.endsWith('!') ? noPrefix.slice(0, -1) : noPrefix
}

/** The utility part of a token — everything after the last `:`. */
function utilityOf(token: string): string {
  const stripped = stripImportant(token)
  const lastColon = stripped.lastIndexOf(':')
  return lastColon === -1 ? stripped : stripped.slice(lastColon + 1)
}

/** The condition segments of a token — everything before the last `:`. */
function variantsOf(token: string): readonly string[] {
  const stripped = stripImportant(token)
  const lastColon = stripped.lastIndexOf(':')
  return lastColon === -1 ? [] : stripped.slice(0, lastColon).split(':')
}

/**
 * True when `utility` is applied with NO condition — i.e. at every width.
 * `hasUnconditionalClass('md:sticky', 'sticky')` is false: that is the point.
 */
export function hasUnconditionalClass(className: string | undefined, utility: string): boolean {
  return classTokens(className).some(
    (token) => variantsOf(token).length === 0 && utilityOf(token) === utility,
  )
}

/** True when `utility` is applied behind the given `variant` (e.g. `md`). */
export function hasVariantClass(
  className: string | undefined,
  variant: string,
  utility: string,
): boolean {
  return classTokens(className).some(
    (token) => utilityOf(token) === utility && variantsOf(token).includes(variant),
  )
}
