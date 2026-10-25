/**
 * The one piece of guard-point knowledge that is OURS.
 *
 * The protocol itself — the command ids, the XML shapes, the two-digit
 * exponent, the `chnType` asymmetry, the `setGrd`/`toGrd` verbs — lives in
 * `@apocaliss92/nodelink-js` (`getPtzGuard` / `setPtzGuard` / `goToPtzGuard`)
 * since 0.7.2. It belongs there: it is knowledge about Baichuan, not about
 * CamStack, and a second copy here would diverge at the first firmware that
 * changes one of those details.
 *
 * This constant stays because it is a PRODUCT decision, not a protocol fact.
 */

/**
 * The idle-return delay used when pinning a guard point on a camera that has
 * none configured yet.
 *
 * 60 s is what the camera's own app showed as its starting value in the
 * capture. Copying the vendor's default is the honest choice for a number we
 * have no independent reason to pick.
 */
export const DEFAULT_GUARD_TIMEOUT_SECONDS = 60
