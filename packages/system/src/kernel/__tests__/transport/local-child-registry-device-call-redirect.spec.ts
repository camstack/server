/**
 * The sibling short-circuit (D963): a hub-local forked child — an exporter, the
 * notification center — sends `media-player.play({ deviceId })` to a device
 * owned by a co-resident child. `LocalChildRegistry` finds the owner and
 * short-circuits over UDS, so it asks the device-call redirect FIRST, through
 * the same `answerDeviceCallRedirect` the parent-routed handler and
 * `callCapabilityOnNode` use. A redirected call is answered here and the owning
 * sibling is never asked; everything else short-circuits as before.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DeviceCall, DeviceCallAnswer } from '@camstack/types'
import { createLocalTransport } from '../../transport/create-local-transport.js'
import { LocalChildRegistry } from '../../transport/local-child-registry.js'
import type { CapCallMessage, ChildCapDescriptor } from '../../transport/child-cap-protocol.js'
import type { LocalChannel, LocalTransportClient } from '../../transport/local-transport.js'

const nid = () => `hub-redirect-${process.pid}-${Math.random().toString(36).slice(2)}`
const DEVICE = 7

describe('LocalChildRegistry — a call the device remote takes over never reaches the sibling (D963)', () => {
  let registry: LocalChildRegistry | null = null
  const clients: LocalTransportClient[] = []
  afterEach(async () => {
    for (const c of clients) await c.close()
    clients.length = 0
    await registry?.close()
    registry = null
  })

  async function fixture(answer: DeviceCallAnswer | undefined) {
    const nodeId = nid()
    const seen: string[] = []
    const attempts: DeviceCall[] = []
    registry = new LocalChildRegistry({
      server: createLocalTransport().createServer(nodeId),
      ownNodeId: nodeId,
      onUnownedCall: vi.fn(async () => {
        throw new Error('onUnownedCall must not be reached — a sibling owns the cap')
      }),
      ...(answer === undefined
        ? {}
        : {
            deviceCallRedirect: {
              covers: (cap: string, method: string) => cap === 'media-player' && method === 'play',
              attempt: async (call: DeviceCall) => {
                attempts.push(call)
                return answer
              },
            },
          }),
    })
    await registry.start()
    const owner = createLocalTransport().createClient(nodeId)
    clients.push(owner)
    const ownerChannel = await owner.connect()
    ownerChannel.onRequest(async (body) => {
      const msg = body as CapCallMessage // wire-boundary: trusted local UDS channel
      if (msg.kind !== 'cap-call') throw new Error(`unexpected ${msg.kind}`)
      seen.push(msg.method)
      return 'native'
    })
    const caps: ChildCapDescriptor[] = [
      { capName: 'media-player', mode: 'singleton', deviceId: DEVICE },
    ]
    await ownerChannel.request({ kind: 'register', childId: 'provider-x', caps })
    const client = createLocalTransport().createClient(nodeId)
    clients.push(client)
    const exporter: LocalChannel = await client.connect()
    exporter.onRequest(async () => {
      throw new Error('unexpected inbound request')
    })
    await exporter.request({
      kind: 'register',
      childId: 'export-x',
      caps: [{ capName: 'device-export', mode: 'collection' }],
    })
    return { exporter, seen, attempts }
  }

  const play = {
    kind: 'cap-call-out',
    capName: 'media-player',
    method: 'play',
    args: { deviceId: DEVICE },
    deviceId: DEVICE,
  } as const

  it('answers a redirected call from the redirect; the owning sibling is never asked', async () => {
    const { exporter, seen, attempts } = await fixture({ kind: 'redirected', result: 'sent' })
    expect(await exporter.request(play)).toBe('sent')
    expect(seen).toEqual([])
    expect(attempts).toEqual([
      { capName: 'media-player', method: 'play', deviceId: DEVICE, args: { deviceId: DEVICE } },
    ])
  })

  it('short-circuits to the sibling when nothing takes the call over', async () => {
    const { exporter, seen } = await fixture({ kind: 'not-redirected' })
    expect(await exporter.request(play)).toBe('native')
    expect(seen).toEqual(['play'])
  })

  it('without a redirect (the agent) the sibling answers — the prior behaviour exactly', async () => {
    const { exporter, seen } = await fixture(undefined)
    expect(await exporter.request(play)).toBe('native')
    expect(seen).toEqual(['play'])
  })
})
