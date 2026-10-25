/**
 * Which of a block's OWN `replace` claims the hub holds, or is being asked for
 * (D663) — the fact that decides what a `device.state-changed` of that cap is
 * for the block's native self-reads. With no claim it IS the provider's native;
 * under the block's claim it is the block's own merge, and the native arrives
 * only on `device.native-shadow-changed`.
 *
 * - Fed by what actually LANDED, never by the plan (C-1): the boot seed (the
 *   hub's claims index), a claim the hub answered `ok`, a release the hub
 *   confirmed. A throw or an unexplained refusal changes nothing (D49).
 * - While a claim RPC is IN FLIGHT the hub may already merge (the mirror emits
 *   from inside `claim()`, before the answer): a `device.state-changed` then is
 *   neither native nor composed, and is not taken as either (N-1). The reply —
 *   any reply — ends the window, and the caller re-reads the native once.
 * - Keyed by OWNER (N-7): another block's claim on the same cap, and an `add`
 *   claim (which emits no shadow), never make this block's cap held.
 */
import type { FieldClaim } from '@camstack/types'

/** What one claim RPC of an owner did, as its target saw it. */
export type ClaimEvent = 'claiming' | 'held' | 'free' | 'unsettled'

function slot(deviceId: number, cap: string, owner: string): string {
  return `${owner}@${deviceId}#${cap}`
}

function without(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
  return new Set([...set].filter((k) => k !== key))
}

export class HeldClaims {
  private held: ReadonlySet<string> = new Set()
  private claiming: ReadonlySet<string> = new Set()

  /** The `replace` claims the hub holds before this process wrote any (the boot seed). */
  seed(claims: readonly FieldClaim[]): void {
    const replaced = claims.filter((c) => c.mode === 'replace')
    this.held = new Set([
      ...this.held,
      ...replaced.map((c) => slot(c.deviceId, c.capName, c.owner)),
    ])
  }

  apply(deviceId: number, cap: string, owner: string, event: ClaimEvent): void {
    const k = slot(deviceId, cap, owner)
    if (event === 'claiming') {
      this.claiming = new Set([...this.claiming, k])
      return
    }
    this.claiming = without(this.claiming, k)
    if (event === 'held') this.held = new Set([...this.held, k])
    else if (event === 'free') this.held = without(this.held, k)
  }

  /** `device.state-changed` of `cap` is NOT the native for `owner`'s self-reads: its claim is held, or being asked for. */
  shadowsNative(deviceId: number, cap: string, owner: string): boolean {
    const k = slot(deviceId, cap, owner)
    return this.held.has(k) || this.claiming.has(k)
  }
}
