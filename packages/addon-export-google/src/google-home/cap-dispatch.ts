/**
 * The ONE place a `CapCall` becomes a real capability invocation, and the one
 * place a trait's status read becomes a real `getStatus` query.
 *
 * Both switches are exhaustive over their union, closed with a `never` binding
 * — so adding a row to `TRAIT_CATALOG` that needs a new call fails to compile
 * here rather than falling through to a default branch. That default branch is
 * precisely what produced 177 Home Assistant entities that could never carry a
 * value (see `scripts/check-export-coverage.ts`); this module has none.
 *
 * Everything above this file is pure and testable without a tRPC client.
 * Everything below it is `ctx.api`. Keeping the boundary this thin is what
 * makes "no casts" achievable: the api surface is typed, and each call site
 * names its concrete path.
 */
import type { AddonApi } from '@dominevo/types'
import { commandOrigin } from '@dominevo/types/addon'

import type { CapCall, CapStatusRead } from './trait-catalog.js'

/** The linked Google account a command was asked for. */
export interface GooglePrincipal {
  readonly principalId: string
  readonly principalName?: string
}

export async function dispatchCapCall(
  api: AddonApi,
  call: CapCall,
  principal?: GooglePrincipal,
): Promise<void> {
  const origin =
    principal === undefined || principal.principalId === ''
      ? undefined
      : commandOrigin({
          kind: 'on-behalf',
          source: 'google',
          principalId: principal.principalId,
          ...(principal.principalName ? { principalName: principal.principalName } : {}),
        })
  switch (call.kind) {
    case 'switch.setState':
      await api.switch.setState.mutate({ deviceId: call.deviceId, on: call.on }, origin)
      return
    case 'brightness.setBrightness':
      await api.brightness.setBrightness.mutate(
        {
          deviceId: call.deviceId,
          level: call.percentage,
        },
        origin,
      )
      return
    case 'lockControl.lock':
      await api.lockControl.lock.mutate({ deviceId: call.deviceId }, origin)
      return
    case 'lockControl.unlock':
      await api.lockControl.unlock.mutate({ deviceId: call.deviceId }, origin)
      return
    case 'cover.open':
      await api.cover.open.mutate({ deviceId: call.deviceId }, origin)
      return
    case 'cover.close':
      await api.cover.close.mutate({ deviceId: call.deviceId }, origin)
      return
    case 'cover.setPosition':
      await api.cover.setPosition.mutate(
        { deviceId: call.deviceId, position: call.position },
        origin,
      )
      return
    default: {
      const unreachable: never = call
      throw new Error(`unhandled cap call ${JSON.stringify(unreachable)}`)
    }
  }
}

export async function readCapStatus(
  api: AddonApi,
  read: CapStatusRead,
  deviceId: number,
): Promise<unknown> {
  switch (read) {
    case 'switch':
      return api.switch.getStatus.query({ deviceId })
    case 'brightness':
      return api.brightness.getStatus.query({ deviceId })
    case 'lockControl':
      return api.lockControl.getStatus.query({ deviceId })
    case 'cover':
      return api.cover.getStatus.query({ deviceId })
    default: {
      const unreachable: never = read
      throw new Error(`unhandled cap status read ${String(unreachable)}`)
    }
  }
}
