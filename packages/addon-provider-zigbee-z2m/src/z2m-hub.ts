/**
 * The sessions of every Zigbee2MQTT integration of this process, and who listens to them. A device
 * (or the integration's Gateway) subscribes by `(integrationId, ieee)` and keeps its subscription
 * across a reconnect, a changed endpoint and a session that does not exist yet: the subscription is
 * the hub's, never the session's. A subscriber is told what is already known the moment it joins.
 */
import type { IScopedLogger } from '@camstack/types'
import type { Z2mConnection, Z2mEndpoint, Z2mSocketFactory, Z2mTimers } from './z2m-client.js'
import type { Z2mBridgeInfo, Z2mDevice, Z2mState } from './z2m-protocol.js'
import { Z2mSession } from './z2m-session.js'

export interface Z2mDeviceListener {
  /** The device's entry in the server's table; null when the server no longer lists it. */
  readonly device: (device: Z2mDevice | null) => void
  /** `delta` is what the message carried (empty on a replay); an event is read from it, never from `state`. */
  readonly state: (state: Z2mState, delta: Z2mState) => void
  readonly availability: (online: boolean) => void
}

export interface Z2mLinkListener {
  readonly connection: (state: Z2mConnection) => void
  readonly bridge: (info: Z2mBridgeInfo | null, online: boolean | null) => void
  readonly devices: (devices: ReadonlyMap<string, Z2mDevice>) => void
}

export interface Z2mConnectOptions {
  readonly factory?: Z2mSocketFactory
  readonly timers?: Z2mTimers
  readonly backoffBaseMs?: number
  readonly backoffMaxMs?: number
}

function key(integrationId: string, ieee: string): string {
  return `${integrationId}\0${ieee}`
}

export class Z2mHub {
  private readonly sessions = new Map<string, Z2mSession>()
  private readonly deviceListeners = new Map<string, Set<Z2mDeviceListener>>()
  private readonly linkListeners = new Map<string, Set<Z2mLinkListener>>()

  session(integrationId: string): Z2mSession | null {
    return this.sessions.get(integrationId) ?? null
  }

  /** Open the session of an integration, replacing a previous one (a changed endpoint). */
  connect(
    integrationId: string,
    endpoint: Z2mEndpoint,
    logger: IScopedLogger,
    options: Z2mConnectOptions = {},
  ): Z2mSession {
    this.disconnect(integrationId)
    const session = new Z2mSession({
      integrationId,
      endpoint,
      logger,
      ...options,
      sink: {
        connection: (state) => {
          for (const l of this.linkListeners.get(integrationId) ?? []) l.connection(state)
        },
        bridge: (info, online) => {
          for (const l of this.linkListeners.get(integrationId) ?? []) l.bridge(info, online)
        },
        devices: (table) => this.onTable(integrationId, table),
        state: (ieee, state, delta) => {
          for (const l of this.deviceListeners.get(key(integrationId, ieee)) ?? []) {
            l.state(state, delta)
          }
        },
        availability: (ieee, online) => {
          for (const l of this.deviceListeners.get(key(integrationId, ieee)) ?? []) {
            l.availability(online)
          }
        },
      },
    })
    this.sessions.set(integrationId, session)
    session.start()
    return session
  }

  disconnect(integrationId: string): void {
    const session = this.sessions.get(integrationId)
    if (session === undefined) return
    session.stop()
    this.sessions.delete(integrationId)
  }

  disconnectAll(): void {
    for (const id of [...this.sessions.keys()]) this.disconnect(id)
  }

  subscribeDevice(integrationId: string, ieee: string, listener: Z2mDeviceListener): () => void {
    const k = key(integrationId, ieee)
    const set = this.deviceListeners.get(k) ?? new Set<Z2mDeviceListener>()
    set.add(listener)
    this.deviceListeners.set(k, set)
    const session = this.sessions.get(integrationId)
    if (session !== null && session !== undefined) {
      const device = session.deviceOf(ieee)
      if (session.deviceTable().size > 0) listener.device(device)
      const state = session.stateOf(ieee)
      if (state !== null) listener.state(state, {})
      const online = session.availabilityOf(ieee)
      if (online !== null) listener.availability(online)
    }
    return () => {
      set.delete(listener)
      if (set.size === 0) this.deviceListeners.delete(k)
    }
  }

  subscribeLink(integrationId: string, listener: Z2mLinkListener): () => void {
    const set = this.linkListeners.get(integrationId) ?? new Set<Z2mLinkListener>()
    set.add(listener)
    this.linkListeners.set(integrationId, set)
    const session = this.sessions.get(integrationId)
    if (session !== undefined) {
      listener.connection(session.connection)
      listener.bridge(session.bridgeInfo, session.isBridgeOnline)
      if (session.deviceTable().size > 0) listener.devices(session.deviceTable())
    }
    return () => {
      set.delete(listener)
      if (set.size === 0) this.linkListeners.delete(integrationId)
    }
  }

  private onTable(integrationId: string, table: ReadonlyMap<string, Z2mDevice>): void {
    for (const l of this.linkListeners.get(integrationId) ?? []) l.devices(table)
    const prefix = integrationId + '\0'
    for (const [k, listeners] of this.deviceListeners) {
      if (!k.startsWith(prefix)) continue
      const device = table.get(k.slice(prefix.length)) ?? null
      for (const l of listeners) l.device(device)
    }
  }
}

/** The process-wide hub. */
export const z2mHub = new Z2mHub()
