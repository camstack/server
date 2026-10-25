/**
 * claimed-get-status.ts — the ONE function every transport entry that resolves
 * a cap call BY NAME asks before it routes a device-scoped `getStatus` (D663,
 * ruling S3).
 *
 * There is no single chokepoint: three entries dispatch straight to the owning
 * runner, and each would answer the NATIVE slice of a claimed cap —
 *   1. `LocalChildRegistry`'s sibling short-circuit (a hub-local forked child —
 *      an exporter, the notification center — calling a device owned by a
 *      co-resident child: the S3 case itself);
 *   2. `createParentUnownedCallHandler` (no sibling owns it: remote agents'
 *      devices, hub-in-process caps, the agent's forward);
 *   3. `MoleculerService.callCapabilityOnNode` (the hub's own tRPC with a
 *      `nodeId` pin — the generated `DeviceProxy` always sends one — and every
 *      hub in-process addon's `ctx.api` through `deviceCapResolverLink`).
 * The registry's D13 resolvers wrap the provider instead (`status-overlay.ts`).
 * `scripts/check-claimed-get-status.ts` fails when a production file that calls
 * `resolveCapRoute` / `resolveChildId` / `callCapOnChild` does not call this.
 *
 * `null` means "not a claimed device-scoped getStatus — route as before". A
 * non-null answer IS the answer: the merged slice, or `null` for a held claim
 * and for a device whose claims cannot be known ("not reported", never the
 * native — D315, D49).
 */
import type { ClaimedStatusResolver } from '../status-overlay.js'
import { extractDeviceId } from './cap-route-resolver.js'

export const GET_STATUS_METHOD = 'getStatus'

/** What the entry knows about the call; `deviceId` wins over one inside `args`. */
export interface ClaimedGetStatusCall {
  readonly capName: string
  readonly method: string
  readonly deviceId?: number
  readonly args?: unknown
}

export interface ClaimedGetStatusAnswer {
  readonly slice: Readonly<Record<string, unknown>> | null
}

/** The device a `getStatus` is about, or `undefined` when the call is not one. */
export function deviceOfGetStatus(call: ClaimedGetStatusCall): number | undefined {
  if (call.method !== GET_STATUS_METHOD) return undefined
  return call.deviceId ?? extractDeviceId(call.args)
}

export async function answerClaimedGetStatus(
  resolve: ClaimedStatusResolver | undefined,
  call: ClaimedGetStatusCall,
): Promise<ClaimedGetStatusAnswer | null> {
  if (resolve === undefined) return null
  const deviceId = deviceOfGetStatus(call)
  if (deviceId === undefined) return null
  const answer = await resolve(call.capName, deviceId)
  if (answer.kind === 'unclaimed') return null
  return { slice: answer.kind === 'claimed' ? answer.slice : null }
}
