/**
 * The live picture of ONE Zigbee2MQTT server: its bridge info, its device table, the last state of
 * every device and who is available. State is PUSHED by the server (there is no polling): the
 * frontend socket replays the retained `bridge/*` topics and every device's state on connect, and
 * streams every change after.
 *
 * Devices are keyed by `ieee_address`. A state topic is the device's `friendly_name`, which an
 * operator can change, so the table is the only place a name is turned into an address, and a state
 * that arrives before the table is held until the table says whose it is.
 */
import type { IScopedLogger } from '@camstack/types'
import {
  Z2mAvailabilitySchema,
  Z2mBridgeInfoSchema,
  Z2mBridgeStateSchema,
  Z2mDevicesSchema,
  Z2mStateSchema,
  type Z2mBridgeInfo,
  type Z2mDevice,
  type Z2mEnvelope,
  type Z2mState,
} from './z2m-protocol.js'
import {
  Z2mClient,
  type Z2mConnection,
  type Z2mEndpoint,
  type Z2mSocketFactory,
  type Z2mTimers,
} from './z2m-client.js'

export interface Z2mSessionSink {
  readonly connection: (state: Z2mConnection) => void
  readonly bridge: (info: Z2mBridgeInfo | null, online: boolean | null) => void
  readonly devices: (devices: ReadonlyMap<string, Z2mDevice>) => void
  /** `state` is the merged picture; `delta` is what this message carried. */
  readonly state: (ieee: string, state: Z2mState, delta: Z2mState) => void
  readonly availability: (ieee: string, online: boolean) => void
}

export interface Z2mSessionOptions {
  readonly integrationId: string
  readonly endpoint: Z2mEndpoint
  readonly logger: IScopedLogger
  readonly sink: Z2mSessionSink
  readonly factory?: Z2mSocketFactory
  readonly timers?: Z2mTimers
  readonly backoffBaseMs?: number
  readonly backoffMaxMs?: number
}

const AVAILABILITY_SUFFIX = '/availability'
const SET_SUFFIX = '/set'
const GET_SUFFIX = '/get'

export class Z2mSession {
  private readonly client: Z2mClient
  private devices = new Map<string, Z2mDevice>()
  private readonly ieeeByName = new Map<string, string>()
  private readonly states = new Map<string, Z2mState>()
  /** State and availability that arrived before the table named their device, by friendly name. */
  private readonly heldStates = new Map<string, Z2mState>()
  private readonly heldAvailability = new Map<string, boolean>()
  private readonly available = new Map<string, boolean>()
  /** Devices whose first state since the socket opened (the server's snapshot) has been seen. */
  private readonly snapshotSeen = new Set<string>()
  private info: Z2mBridgeInfo | null = null
  private bridgeOnline: boolean | null = null

  constructor(private readonly opts: Z2mSessionOptions) {
    this.client = new Z2mClient({
      endpoint: opts.endpoint,
      logger: opts.logger,
      onEnvelope: (envelope) => this.onEnvelope(envelope),
      onConnection: (state) => {
        if (state === 'online') this.snapshotSeen.clear()
        opts.sink.connection(state)
      },
      ...(opts.factory !== undefined ? { factory: opts.factory } : {}),
      ...(opts.timers !== undefined ? { timers: opts.timers } : {}),
      ...(opts.backoffBaseMs !== undefined ? { backoffBaseMs: opts.backoffBaseMs } : {}),
      ...(opts.backoffMaxMs !== undefined ? { backoffMaxMs: opts.backoffMaxMs } : {}),
    })
  }

  start(): void {
    this.client.start()
  }

  stop(): void {
    this.client.stop()
  }

  get connection(): Z2mConnection {
    return this.client.connection
  }

  get bridgeInfo(): Z2mBridgeInfo | null {
    return this.info
  }

  get isBridgeOnline(): boolean | null {
    return this.bridgeOnline
  }

  deviceTable(): ReadonlyMap<string, Z2mDevice> {
    return this.devices
  }

  deviceOf(ieee: string): Z2mDevice | null {
    return this.devices.get(ieee) ?? null
  }

  stateOf(ieee: string): Z2mState | null {
    return this.states.get(ieee) ?? null
  }

  availabilityOf(ieee: string): boolean | null {
    return this.available.get(ieee) ?? null
  }

  /** Command a device: `<friendly_name>/set`, resolved from the table now, so a rename is followed. */
  command(ieee: string, payload: Readonly<Record<string, unknown>>): void {
    const device = this.devices.get(ieee)
    if (device === undefined) throw new Error(`Zigbee2MQTT does not list device ${ieee}`)
    this.client.publish(device.friendly_name + SET_SUFFIX, payload)
  }

  /** Ask a device to publish a property now: `<friendly_name>/get`. */
  ask(ieee: string, payload: Readonly<Record<string, unknown>>): void {
    const device = this.devices.get(ieee)
    if (device === undefined) throw new Error(`Zigbee2MQTT does not list device ${ieee}`)
    this.client.publish(device.friendly_name + GET_SUFFIX, payload)
  }

  request(
    topic: string,
    payload: Readonly<Record<string, unknown>>,
    timeoutMs?: number,
  ): Promise<unknown> {
    return this.client.request(topic, payload, timeoutMs)
  }

  private onEnvelope(envelope: Z2mEnvelope): void {
    const { topic, payload } = envelope
    if (topic === 'bridge/state') return this.onBridgeState(payload)
    if (topic === 'bridge/info') return this.onBridgeInfo(payload)
    if (topic === 'bridge/devices') return this.onDevices(payload)
    if (topic === 'bridge/event') return this.onBridgeEvent(payload)
    if (topic.startsWith('bridge/')) return
    if (topic.endsWith(AVAILABILITY_SUFFIX)) {
      return this.onAvailability(topic.slice(0, -AVAILABILITY_SUFFIX.length), payload)
    }
    if (topic.endsWith(SET_SUFFIX) || topic.endsWith(GET_SUFFIX)) return
    this.onState(topic, payload)
  }

  private onBridgeState(payload: unknown): void {
    const parsed = Z2mBridgeStateSchema.safeParse(payload)
    if (!parsed.success) return
    const state = typeof parsed.data === 'string' ? parsed.data : parsed.data.state
    this.bridgeOnline = state === 'online'
    this.opts.sink.bridge(this.info, this.bridgeOnline)
  }

  private onBridgeInfo(payload: unknown): void {
    const parsed = Z2mBridgeInfoSchema.safeParse(payload)
    if (!parsed.success) {
      this.opts.logger.warn('zigbee2mqtt: bridge/info did not parse', {
        meta: { issues: parsed.error.issues.length },
      })
      return
    }
    this.info = parsed.data
    this.opts.sink.bridge(this.info, this.bridgeOnline)
  }

  private onBridgeEvent(payload: unknown): void {
    const type =
      typeof payload === 'object' && payload !== null && 'type' in payload ? payload.type : null
    if (typeof type === 'string') {
      this.opts.logger.info('zigbee2mqtt: bridge event', { meta: { type } })
    }
  }

  private onDevices(payload: unknown): void {
    const parsed = Z2mDevicesSchema.safeParse(payload)
    if (!parsed.success) {
      // A table that does not parse changes nothing: the previous one stays (D49).
      this.opts.logger.warn(
        'zigbee2mqtt: bridge/devices did not parse; the previous table is kept',
        {
          meta: { issues: parsed.error.issues.length },
        },
      )
      return
    }
    this.devices = new Map(parsed.data.map((d) => [d.ieee_address, d]))
    this.ieeeByName.clear()
    for (const device of parsed.data) this.ieeeByName.set(device.friendly_name, device.ieee_address)
    this.opts.sink.devices(this.devices)
    for (const [name, held] of this.heldStates) {
      if (this.ieeeByName.has(name)) {
        this.heldStates.delete(name)
        this.onState(name, held)
      }
    }
    for (const [name, online] of this.heldAvailability) {
      const ieee = this.ieeeByName.get(name)
      if (ieee === undefined) continue
      this.heldAvailability.delete(name)
      this.setAvailability(ieee, online)
    }
  }

  private onState(name: string, payload: unknown): void {
    const parsed = Z2mStateSchema.safeParse(payload)
    if (!parsed.success) return
    const ieee = this.ieeeByName.get(name)
    if (ieee === undefined) {
      this.heldStates.set(name, {
        ...this.heldStates.get(name),
        ...parsed.data,
      })
      return
    }
    const merged: Z2mState = { ...this.states.get(ieee), ...parsed.data }
    this.states.set(ieee, merged)
    // The server replays every device's last state when a socket opens: its `action` is old news,
    // not a button press, so the first state of a device after (re)connect carries no event.
    const snapshot = !this.snapshotSeen.has(ieee)
    this.snapshotSeen.add(ieee)
    const { action: _replayed, ...rest } = parsed.data
    this.opts.sink.state(ieee, merged, snapshot ? rest : parsed.data)
  }

  private onAvailability(name: string, payload: unknown): void {
    const parsed = Z2mAvailabilitySchema.safeParse(payload)
    if (!parsed.success) return
    const online = (typeof parsed.data === 'string' ? parsed.data : parsed.data.state) === 'online'
    const ieee = this.ieeeByName.get(name)
    if (ieee === undefined) {
      this.heldAvailability.set(name, online)
      return
    }
    this.setAvailability(ieee, online)
  }

  private setAvailability(ieee: string, online: boolean): void {
    this.available.set(ieee, online)
    this.opts.sink.availability(ieee, online)
  }
}
