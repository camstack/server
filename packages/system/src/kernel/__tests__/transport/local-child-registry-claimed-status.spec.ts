/**
 * The S3 case itself (D663): a hub-local forked child — an HA-MQTT / HomeKit /
 * Alexa exporter, the notification center — calls `battery.getStatus({ deviceId })`
 * of a device OWNED by another hub-local child (`provider-homeassistant`).
 *
 * That call never reaches `onUnownedCall`: `LocalChildRegistry` finds the
 * owning sibling through `resolveChildId` and short-circuits the call to it over
 * UDS, and the sibling's `getStatus` is the NATIVE slice. So the registry asks
 * the hub's claim authority FIRST, through the same `answerClaimedGetStatus` the
 * parent-routed handler and `callCapabilityOnNode` use, and answers a claimed
 * cap from the hub mirror without asking the sibling at all.
 *
 * Driven end to end with a REAL `LocalChildRegistry`, a real sibling child
 * registered over the local transport that owns `(battery, 7)`, and a real
 * caller child issuing the `cap-call-out` — the production path, not the
 * handler in isolation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StatusOverlayAnswer } from '@camstack/types'
import { createLocalTransport } from '../../transport/create-local-transport.js'
import { LocalChildRegistry } from '../../transport/local-child-registry.js'
import type { CapCallMessage, ChildCapDescriptor } from '../../transport/child-cap-protocol.js'
import type { LocalChannel, LocalTransportClient } from '../../transport/local-transport.js'

const nid = () => `hub-claimed-${process.pid}-${Math.random().toString(36).slice(2)}`

const NATIVE = { percentage: 40, charging: 'none', sleeping: false, lastUpdated: 1 }
const OWNED_SLICE = { ...NATIVE, percentage: 90 }
const DEVICE = 7
const OTHER_DEVICE = 8

const claimBattery7 = async (cap: string, id: number): Promise<StatusOverlayAnswer> =>
  cap === 'battery' && id === DEVICE
    ? { kind: 'claimed', slice: OWNED_SLICE }
    : { kind: 'unclaimed' }

interface SiblingCall {
  readonly method: string
  readonly args: unknown
  readonly deviceId: number | undefined
}

describe('LocalChildRegistry — getStatus of a CLAIMED cap never reaches the owning sibling (S3)', () => {
  let registry: LocalChildRegistry | null = null
  const clients: LocalTransportClient[] = []
  afterEach(async () => {
    for (const c of clients) await c.close()
    clients.length = 0
    await registry?.close()
    registry = null
  })

  /** `provider-homeassistant`: owns battery for devices 7 and 8, answers the NATIVE slice. */
  async function registerOwningSibling(nodeId: string, seen: SiblingCall[]): Promise<void> {
    const client = createLocalTransport().createClient(nodeId)
    clients.push(client)
    const channel = await client.connect()
    channel.onRequest(async (body) => {
      const msg = body as CapCallMessage // wire-boundary: trusted local UDS channel
      if (msg.kind !== 'cap-call') throw new Error(`unexpected ${msg.kind}`)
      seen.push({ method: msg.method, args: msg.args, deviceId: msg.deviceId })
      return msg.method === 'getStatus' ? NATIVE : { awoke: true, durationMs: 5 }
    })
    const caps: ChildCapDescriptor[] = [
      { capName: 'battery', mode: 'singleton', deviceId: DEVICE },
      { capName: 'battery', mode: 'singleton', deviceId: OTHER_DEVICE },
    ]
    await channel.request({ kind: 'register', childId: 'provider-homeassistant', caps })
  }

  /** The exporter: a child that owns nothing relevant and calls out. */
  async function connectExporter(nodeId: string): Promise<LocalChannel> {
    const client = createLocalTransport().createClient(nodeId)
    clients.push(client)
    const channel = await client.connect()
    channel.onRequest(async () => {
      throw new Error('the exporter received an unexpected inbound request')
    })
    await channel.request({
      kind: 'register',
      childId: 'export-ha-mqtt',
      caps: [{ capName: 'device-export', mode: 'collection' }],
    })
    return channel
  }

  interface Fixture {
    readonly exporter: LocalChannel
    readonly seen: SiblingCall[]
    readonly unowned: ReturnType<typeof vi.fn>
    readonly claimedStatus: ReturnType<typeof vi.fn>
  }

  async function fixture(opts: { withClaimAuthority: boolean }): Promise<Fixture> {
    const nodeId = nid()
    const seen: SiblingCall[] = []
    const unowned = vi.fn(async () => {
      throw new Error('onUnownedCall must not be reached — a sibling owns the cap')
    })
    const claimedStatus = vi.fn(claimBattery7)
    registry = new LocalChildRegistry({
      server: createLocalTransport().createServer(nodeId),
      ownNodeId: nodeId,
      onUnownedCall: unowned,
      ...(opts.withClaimAuthority ? { claimedStatus } : {}),
    })
    await registry.start()
    await registerOwningSibling(nodeId, seen)
    const exporter = await connectExporter(nodeId)
    return { exporter, seen, unowned, claimedStatus }
  }

  it('the exporter reads the MERGED slice; the owning sibling is never asked, onUnownedCall never runs', async () => {
    const { exporter, seen, unowned } = await fixture({ withClaimAuthority: true })
    const res = await exporter.request({
      kind: 'cap-call-out',
      capName: 'battery',
      method: 'getStatus',
      args: { deviceId: DEVICE },
    })
    expect(res).toEqual(OWNED_SLICE)
    expect(seen).toEqual([])
    expect(unowned).not.toHaveBeenCalled()
  })

  it('the lifted `deviceId` on the envelope is honoured too (the raw-forward shape)', async () => {
    const { exporter, seen } = await fixture({ withClaimAuthority: true })
    const res = await exporter.request({
      kind: 'cap-call-out',
      capName: 'battery',
      method: 'getStatus',
      args: { deviceId: DEVICE },
      deviceId: DEVICE,
    })
    expect(res).toEqual(OWNED_SLICE)
    expect(seen).toEqual([])
  })

  it('getStatus of an UNCLAIMED device, and every other method of the claimed one, still short-circuit to the sibling', async () => {
    const { exporter, seen, claimedStatus } = await fixture({ withClaimAuthority: true })
    // `ipcParentLink` lifts the device onto the envelope (`trpc-links.ts`); the
    // sibling index answers a device-scoped owner only for that lifted id.
    const status = await exporter.request({
      kind: 'cap-call-out',
      capName: 'battery',
      method: 'getStatus',
      args: { deviceId: OTHER_DEVICE },
      deviceId: OTHER_DEVICE,
    })
    const wake = await exporter.request({
      kind: 'cap-call-out',
      capName: 'battery',
      method: 'wakeForStream',
      args: { deviceId: DEVICE, timeoutMs: 1000 },
      deviceId: DEVICE,
    })
    expect(status).toEqual(NATIVE)
    expect(wake).toEqual({ awoke: true, durationMs: 5 })
    expect(seen.map((c) => c.method)).toEqual(['getStatus', 'wakeForStream'])
    // The unclaimed getStatus paid one lookup; wakeForStream paid none.
    expect(claimedStatus).toHaveBeenCalledTimes(1)
    expect(claimedStatus).toHaveBeenCalledWith('battery', OTHER_DEVICE)
  })

  it('without a claim authority (the agent) the sibling answers native — the prior behaviour exactly', async () => {
    const { exporter, seen } = await fixture({ withClaimAuthority: false })
    const res = await exporter.request({
      kind: 'cap-call-out',
      capName: 'battery',
      method: 'getStatus',
      args: { deviceId: DEVICE },
      deviceId: DEVICE,
    })
    expect(res).toEqual(NATIVE)
    expect(seen).toHaveLength(1)
  })
})
