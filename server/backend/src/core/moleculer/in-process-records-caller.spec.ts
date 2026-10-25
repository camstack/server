/**
 * Hub in-process `ctx.records` reaches sqlite-settings over UDS. The stated
 * `callerAddonId` in args must survive onto {@link CapCallInput.callerAddonId}
 * or the child strips it and RecordsProvider refuses `records/no-caller`.
 */
import { describe, expect, it, vi } from 'vitest'
import type { CapCallInput, CapRoute } from '@camstack/system'
import { recordsCallerOf } from '../../../../../packages/system/src/builtins/sqlite-storage/records/records-provider.js'
import { stampCallerAddonId } from '../../../../../packages/system/src/kernel/transport/cap-route-resolver.js'
import { buildCapCallFn, type CapCallFnLocalChild, type CapCallFnResolver } from './cap-call-fn.js'

const HUB_LOCAL_UDS: CapRoute = {
  kind: 'hub-local-uds',
  capName: 'records',
  childId: 'sqlite-settings',
}

describe('in-process records transport over a registry proxy', () => {
  it('resolver hub-local-uds: wire caller preserves identity into the provider args', async () => {
    const childCalls: CapCallInput[] = []
    const child: CapCallFnLocalChild = {
      childProvides: () => false,
      callCapOnChild: async (_childId, input) => {
        childCalls.push(input)
        return { kinds: {} }
      },
    }
    const resolver: CapCallFnResolver = {
      resolveCapRoute: () => HUB_LOCAL_UDS,
      dispatch: async (route, _method, args, _addonId, callerAddonId) => {
        if (route.kind !== 'hub-local-uds') throw new Error('unexpected route')
        const stamped = stampCallerAddonId(args, callerAddonId)
        expect(() => recordsCallerOf(stamped)).not.toThrow()
        expect(recordsCallerOf(stamped)).toBe('storage-orchestrator')
        return { kinds: {} }
      },
    }
    const fn = buildCapCallFn({
      capName: 'records',
      addonId: 'sqlite-settings',
      nodeId: 'hub',
      udsChildId: null,
      getLocalChildRegistry: () => child,
      getResolver: () => resolver,
      legacyBrokerCall: vi.fn(),
    })

    await fn('declareKinds', {
      kinds: { locations: { database: 'settings', schemaVersion: 1 } },
      callerAddonId: 'storage-orchestrator',
    })
  })

  it('direct UDS without wire caller strips stated identity → no-caller', () => {
    const args = stampCallerAddonId(
      {
        kinds: { locations: { database: 'settings', schemaVersion: 1 } },
        callerAddonId: 'storage-orchestrator',
      },
      undefined,
    )
    expect(() => recordsCallerOf(args)).toThrow(/no caller identity/)
  })
})
