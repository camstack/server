/**
 * The claimed-status overlay (D663, ruling S3) — the ONE question every
 * resolution of a device-scoped `getStatus` asks before it is answered: is this
 * `(cap, device)` claimed on the hub, and if so, what does the merged slice say?
 *
 * Declared here, in `@camstack/types`, because `ICapabilityRegistry` carries
 * the setter and the question; the kernel's `status-overlay.ts` re-exports the
 * types so the registry and the transport both import from it and neither
 * imports the other.
 */

/**
 * - `claimed`: `slice` is ALREADY parsed with the cap's `status.schema`; `null`
 *   means the claim is HELD (a claimed field with no value yet) or the merged
 *   slice did not parse — "not reported" (D315), never the native value.
 * - `unclaimed`: the device is KNOWN to carry no claim on this cap — the only
 *   answer that lets the native provider's own `getStatus` speak.
 * - `unknown`: the device's claims are not known — its row has not been read
 *   and the claims index cannot vouch for it, or the row could not be read. A
 *   consumer answers `null` ("not reported"), never the native: not-yet-known
 *   must not look like not-claimed (D315, D49).
 */
export type StatusOverlayAnswer =
  | { readonly kind: 'claimed'; readonly slice: Readonly<Record<string, unknown>> | null }
  | { readonly kind: 'unclaimed' }
  | { readonly kind: 'unknown' }

/**
 * Installed by the device-manager over its `DeviceStateMirror`.
 *
 * `peek` is synchronous and costs one in-memory lookup: it answers from what is
 * already known and says `unknown` otherwise. `resolve` makes the claims known
 * first — the claims index, and when that cannot vouch for the device, its
 * runtime-state row read once (single-flight) — and answers `unknown` only when
 * the row cannot be read.
 */
export interface StatusOverlay {
  peek(capName: string, deviceId: number): StatusOverlayAnswer
  resolve(capName: string, deviceId: number): Promise<StatusOverlayAnswer>
}
