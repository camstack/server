/**
 * The device-call redirect (D963) — the ONE question every resolution of a
 * device-scoped cap call asks before it routes the call to the owning
 * provider: does something take this call over?
 *
 * Today the remote extension is the one that does. A media-player command on a
 * device whose remote binds the command's role runs the binding (an infrared
 * code, a smart-TV call); an unbound role falls through to the native cap. A
 * `getStatus` on a media player no running source answers is served from the
 * remote's own bookkeeping, marked `assumed`. It is a dispatch concern, not a
 * UI one, so it holds for every caller: the admin UI, an automation, an
 * exporter, a forked addon.
 *
 * Declared here, like the claimed-status overlay, because `ICapabilityRegistry`
 * carries the setter and the question; the kernel registry and the transport
 * entries both import from it and neither imports the other.
 */

/** A device-scoped cap call as an entry sees it. */
export interface DeviceCall {
  readonly capName: string
  readonly method: string
  readonly deviceId: number
  readonly args: unknown
}

/**
 * - `not-redirected`: nothing took the call over — route it as before.
 * - `redirected`: `result` IS the call's answer; the provider is not called.
 *   A redirect that FAILS throws instead, so the caller sees the failure and
 *   the native cap never silently runs in its place.
 */
export type DeviceCallAnswer =
  | { readonly kind: 'not-redirected' }
  | { readonly kind: 'redirected'; readonly result: unknown }

/** Installed by the owner of the redirecting authority (core-blocks, for the remote). */
export interface DeviceCallRedirect {
  /** Synchronous and cheap: could this `(cap, method)` ever be redirected? */
  covers(capName: string, method: string): boolean
  attempt(call: DeviceCall): Promise<DeviceCallAnswer>
}
