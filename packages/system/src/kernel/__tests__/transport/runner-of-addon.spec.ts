/**
 * The agent's registry is wired with the runner -> addons map: a grouped runner's records call
 * claiming a member addon is stamped with the ADDON id; a stranger is refused; and a registry
 * wired with no map refuses the claim instead of re-keying it by the group.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { CapCallInput } from '../../transport/child-cap-protocol.js'
import { createLocalTransport } from '../../transport/create-local-transport.js'
import { LocalChildClient } from '../../transport/local-child-client.js'
import { LocalChildRegistry } from '../../transport/local-child-registry.js'
import { RunnerOfAddon } from '../../transport/runner-of-addon.js'

const GROUP = 'agent-net-access'

async function connect(
  resolve: ((addonId: string) => string) | undefined,
  calls: CapCallInput[],
): Promise<{ client: LocalChildClient; registry: LocalChildRegistry }> {
  const registry = new LocalChildRegistry({
    server: createLocalTransport().createServer('agent-1'),
    ...(resolve !== undefined ? { resolveChildIdForAddon: resolve } : {}),
    onUnownedCall: async (input) => {
      calls.push(input)
      return { ok: true }
    },
  })
  registry.onReadinessSnapshotRequest(() => [])
  await registry.start()
  const client = new LocalChildClient({
    nodeId: 'agent-1',
    childId: GROUP,
    caps: [],
    dispatch: async () => {
      throw new Error('no inbound caps')
    },
  })
  await client.start()
  return { client, registry }
}

const open: { close: () => Promise<void> }[] = []
afterEach(async () => {
  for (const o of open.splice(0)) await o.close()
})

describe('agent registry, grouped runner', () => {
  it('stamps a records call with the verified addon id', async () => {
    const map = new RunnerOfAddon()
    map.record('member-addon', GROUP)
    const calls: CapCallInput[] = []
    const { client, registry } = await connect(map.resolve, calls)
    open.push(client, registry)
    await client.callOut({
      capName: 'records',
      method: 'put',
      args: {},
      actingAddonId: 'member-addon',
    })
    expect(calls[0]?.callerAddonId).toBe('member-addon')
  })

  it('refuses a claim for an addon the runner does not host', async () => {
    const map = new RunnerOfAddon()
    map.record('member-addon', GROUP)
    const calls: CapCallInput[] = []
    const { client, registry } = await connect(map.resolve, calls)
    open.push(client, registry)
    await expect(
      client.callOut({
        capName: 'records',
        method: 'put',
        args: {},
        actingAddonId: 'stranger',
      }),
    ).rejects.toThrow(/acting-addon-not-hosted/)
  })

  it('a registry with no map refuses a records claim, never re-keys it by the group', async () => {
    const calls: CapCallInput[] = []
    const { client, registry } = await connect(undefined, calls)
    open.push(client, registry)
    await expect(
      client.callOut({
        capName: 'records',
        method: 'put',
        args: {},
        actingAddonId: 'member-addon',
      }),
    ).rejects.toThrow(/acting-addon-not-hosted/)
    expect(calls).toEqual([])
  })
})
