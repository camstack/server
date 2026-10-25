import { lookup } from 'node:dns/promises'
import { errMsg, type IScopedLogger } from '@camstack/types'
import type { HomeConnectGatewayConfig } from './config.js'
import { homeConnectWsUrl } from './config.js'
import { HomeConnectDescriptionStore } from './home-connect-description-store.js'
import { createHomeConnectTlsWire } from './home-connect-tls-wire.js'
import {
  HomeConnectSession,
  type HomeConnectInfoFields,
  type ProgramOptionValues,
} from './home-connect-session.js'
import type { HomeConnectWireFactory } from './home-connect-wire.js'

/** Feature-name prefixes for the fields `/ci/info` and `/ni/info` carry (no IDDF entity declares them). */
export const HOME_CONNECT_INFO_PREFIX = 'HomeConnect.Info.'
export const HOME_CONNECT_NETWORK_PREFIX = 'HomeConnect.Network.'

/** Reconnect delays after a dropped or refused socket; the last one repeats. */
export const HOME_CONNECT_RECONNECT_BACKOFF_MS: readonly number[] = [
  1_000, 2_000, 5_000, 10_000, 30_000, 60_000,
]

export interface HomeConnectApplianceInfo {
  readonly haId: string
  readonly name: string
  readonly type: string
  readonly availablePrograms: readonly string[]
}

/** State of the local socket to one appliance. */
export type HomeConnectLinkState = 'connecting' | 'connected' | 'disconnected'

export interface HomeConnectWsClient {
  /**
   * Open the link and keep it open: after this resolves OR rejects the client owns
   * the lifecycle — a refused first connect and every later drop are retried with a
   * bounded backoff until `close()`. Rejects only to report the first attempt.
   */
  connect(): Promise<void>
  close(): void
  getAppliances(): readonly HomeConnectApplianceInfo[]
  /** Last value per feature; empty while the link is down (a stale value is not a value). */
  getFeatures(haId: string): ReadonlyMap<string, unknown>
  /** Resolves when the appliance accepted the write; the value shows up through `onFeatureChange`. */
  setFeature(haId: string, key: string, value: unknown): Promise<void>
  onFeatureChange(listener: (haId: string, key: string, value: unknown) => void): () => void
  getLinkState(haId: string): HomeConnectLinkState
  onLinkChange(listener: (haId: string, state: HomeConnectLinkState) => void): () => void
  /** The live description of the appliance; `null` for a client that has none. */
  getDescription(haId: string): HomeConnectDescriptionStore | null
  /** An IDDF that arrived after the link opened: swap it in and re-read the values. */
  setDescription(haId: string, description: string | Record<string, unknown>): Promise<void>
  selectProgram(haId: string, program: string, options?: ProgramOptionValues): Promise<void>
  startProgram(haId: string, program: string, options?: ProgramOptionValues): Promise<void>
}

export type HomeConnectWsClientFactory = (config: HomeConnectGatewayConfig) => HomeConnectWsClient

/** Minimal WebSocket surface (legacy AES subscribe shim). */
export interface WsLike {
  readonly readyState: number
  send(data: string): void
  close(): void
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (ev: WsEvent) => void,
  ): void
  removeEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (ev: WsEvent) => void,
  ): void
}

export interface WsEvent {
  readonly type: string
  readonly data?: string
}

export type WsFactory = (url: string) => WsLike

const WS_OPEN = 1

interface ParsedDescription {
  readonly appliances: HomeConnectApplianceInfo[]
}

function programNamesFromLegacyList(programsRaw: unknown): string[] {
  const programs: string[] = []
  if (!Array.isArray(programsRaw)) return programs
  for (const p of programsRaw) {
    if (typeof p === 'string') programs.push(p)
  }
  return programs
}

function programNamesFromHaDeviceDescription(programsRaw: unknown): string[] {
  const programs: string[] = []
  if (!Array.isArray(programsRaw)) return programs
  for (const p of programsRaw) {
    if (isPlainObject(p)) {
      const name = p['name']
      if (typeof name === 'string') programs.push(name)
    } else if (typeof p === 'string') {
      programs.push(p)
    }
  }
  return programs
}

function parseLegacyAppliancesList(rawList: unknown): HomeConnectApplianceInfo[] {
  if (!Array.isArray(rawList)) return []
  const appliances: HomeConnectApplianceInfo[] = []
  for (const item of rawList) {
    if (!isPlainObject(item)) continue
    const row = item
    const haId = row['haId']
    const name = row['name']
    const type = row['type']
    if (typeof haId !== 'string') continue
    appliances.push({
      haId,
      name: typeof name === 'string' ? name : haId,
      type: typeof type === 'string' ? type : 'Dishwasher',
      availablePrograms: programNamesFromLegacyList(row['programs']),
    })
  }
  return appliances
}

function parseHaDeviceDescription(record: Record<string, unknown>): HomeConnectApplianceInfo[] {
  const info = record['info']
  if (!isPlainObject(info)) return []
  const infoRec = info
  const deviceID = infoRec['deviceID']
  if (typeof deviceID !== 'string') return []
  const deviceType = infoRec['deviceType']
  const model = infoRec['model']
  const displayName = typeof model === 'string' && model.length > 0 ? model : deviceID
  return [
    {
      haId: deviceID,
      name: displayName,
      type: typeof deviceType === 'string' ? deviceType : 'Dishwasher',
      availablePrograms: programNamesFromHaDeviceDescription(record['program']),
    },
  ]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseDeviceDescriptionRecord(record: Record<string, unknown>): ParsedDescription {
  const rawList = record['appliances']
  if (Array.isArray(rawList)) {
    return { appliances: parseLegacyAppliancesList(rawList) }
  }
  const fromHa = parseHaDeviceDescription(record)
  if (fromHa.length > 0) return { appliances: fromHa }
  return { appliances: [] }
}

function parseDeviceDescription(
  input: string | Record<string, unknown> | undefined,
): ParsedDescription {
  if (input === undefined) return { appliances: [] }
  if (isPlainObject(input)) return parseDeviceDescriptionRecord(input)
  if (typeof input !== 'string') return { appliances: [] }
  const trimmed = input.trim()
  if (trimmed.length === 0 || trimmed === '[object Object]') return { appliances: [] }
  try {
    const root: unknown = JSON.parse(trimmed)
    if (!isPlainObject(root)) return { appliances: [] }
    return parseDeviceDescriptionRecord(root)
  } catch {
    return { appliances: [] }
  }
}

function usesProtocolStack(
  config: HomeConnectGatewayConfig,
  deps: { readonly wireFactory?: HomeConnectWireFactory },
): boolean {
  if (deps.wireFactory) return true
  return config.mode === 'TLS'
}

async function resolveConnectAddress(host: string): Promise<string> {
  try {
    const result = await lookup(host, { verbatim: true })
    return typeof result === 'string' ? result : result.address
  } catch {
    return host.replace(/^https?:\/\//, '').split('/')[0] ?? host
  }
}

const defaultWireFactory: HomeConnectWireFactory = (input) => {
  if (input.mode === 'TLS') {
    return createHomeConnectTlsWire({
      host: input.host,
      connectAddress: input.connectAddress,
      psk: input.psk,
    })
  }
  throw new Error('Home Connect AES local socket is not implemented — use TLS pairing')
}

/** In-memory client for unit tests (no real WebSocket). */
export function createInMemoryHomeConnectClient(input: {
  readonly appliances: readonly HomeConnectApplianceInfo[]
  readonly initialFeatures?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
  readonly description?: string | Record<string, unknown>
}): HomeConnectWsClient {
  const appliances = [...input.appliances]
  const featureStore = new Map<string, Map<string, unknown>>()
  const listeners = new Set<(haId: string, key: string, value: unknown) => void>()
  const linkListeners = new Set<(haId: string, state: HomeConnectLinkState) => void>()
  const description = new HomeConnectDescriptionStore(input.description)
  let connected = false

  for (const app of appliances) {
    const seed = input.initialFeatures?.[app.haId]
    if (seed) {
      featureStore.set(app.haId, new Map(Object.entries(seed)))
    }
  }

  function ensureFeatures(haId: string): Map<string, unknown> {
    let map = featureStore.get(haId)
    if (!map) {
      map = new Map()
      featureStore.set(haId, map)
    }
    return map
  }

  function applyFeature(haId: string, key: string, value: unknown): void {
    ensureFeatures(haId).set(key, value)
    for (const fn of listeners) fn(haId, key, value)
  }

  function setLink(state: HomeConnectLinkState): void {
    for (const app of appliances) for (const fn of linkListeners) fn(app.haId, state)
  }

  return {
    async connect(): Promise<void> {
      connected = true
      setLink('connected')
    },
    close(): void {
      connected = false
      setLink('disconnected')
    },
    getAppliances(): readonly HomeConnectApplianceInfo[] {
      return appliances
    },
    getFeatures(haId: string): ReadonlyMap<string, unknown> {
      return ensureFeatures(haId)
    },
    async setFeature(haId: string, key: string, value: unknown): Promise<void> {
      if (!connected) throw new Error('Home Connect WebSocket not connected')
      applyFeature(haId, key, value)
    },
    onFeatureChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getLinkState: () => (connected ? 'connected' : 'disconnected'),
    onLinkChange(listener) {
      linkListeners.add(listener)
      return () => linkListeners.delete(listener)
    },
    getDescription: () => description,
    async setDescription(_haId, next): Promise<void> {
      description.replace(next)
    },
    async selectProgram(haId, program): Promise<void> {
      if (!connected) throw new Error('Home Connect WebSocket not connected')
      const target = description.entityOfKind('selectedProgram')
      if (target) applyFeature(haId, target.name, program)
    },
    async startProgram(haId, program): Promise<void> {
      if (!connected) throw new Error('Home Connect WebSocket not connected')
      const target = description.entityOfKind('activeProgram')
      if (target) applyFeature(haId, target.name, program)
    },
  }
}

export function createHomeConnectWsClient(
  config: HomeConnectGatewayConfig,
  deps: HomeConnectWsClientDeps = {},
): HomeConnectWsClient {
  const parsed = parseDeviceDescription(config.deviceDescription)
  const appliances = [...parsed.appliances]
  const description = new HomeConnectDescriptionStore(config.deviceDescription)
  const primaryHaId = appliances[0]?.haId ?? config.host

  if (usesProtocolStack(config, deps)) {
    return createProtocolHomeConnectClient({
      config,
      appliances,
      description,
      primaryHaId,
      wireFactory: deps.wireFactory ?? defaultWireFactory,
      deps,
    })
  }

  if (description.size > 0 && config.mode === 'AES') {
    deps.onProtocolWarn?.('aes-legacy-fallback-with-entities')
  }

  return createLegacySubscribeClient(config, deps, appliances)
}

export interface HomeConnectWsClientDeps {
  readonly wsFactory?: WsFactory
  readonly wireFactory?: HomeConnectWireFactory
  readonly onProtocolWarn?: (code: string) => void
  readonly logger?: IScopedLogger
  readonly logTags?: Readonly<Record<string, string>>
  /** Override the reconnect delays (tests). */
  readonly backoffMs?: readonly number[]
  /** Override the session liveness-probe interval (tests); `0` disables it. */
  readonly keepaliveMs?: number
  /** Override the jitter source, a value in [0, 1) (tests). */
  readonly random?: () => number
  /** Override the DNS step (tests). */
  readonly resolveAddress?: (host: string) => Promise<string>
}

function infoFeatureName(service: 'ci' | 'ni', field: string): string {
  return `${service === 'ci' ? HOME_CONNECT_INFO_PREFIX : HOME_CONNECT_NETWORK_PREFIX}${field}`
}

function createProtocolHomeConnectClient(input: {
  readonly config: HomeConnectGatewayConfig
  readonly appliances: HomeConnectApplianceInfo[]
  readonly description: HomeConnectDescriptionStore
  readonly primaryHaId: string
  readonly wireFactory: HomeConnectWireFactory
  readonly deps: HomeConnectWsClientDeps
}): HomeConnectWsClient {
  const { deps, description } = input
  const featureStore = new Map<string, Map<string, unknown>>()
  const listeners = new Set<(haId: string, key: string, value: unknown) => void>()
  const linkListeners = new Set<(haId: string, state: HomeConnectLinkState) => void>()
  const backoff = deps.backoffMs ?? HOME_CONNECT_RECONNECT_BACKOFF_MS
  const jitter = deps.random ?? Math.random
  const haId = input.primaryHaId
  let session: HomeConnectSession | null = null
  let link: HomeConnectLinkState = 'disconnected'
  let wanted = false
  let attempt = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let opening: Promise<void> | null = null
  let warnedEmptyIndex = false

  function ensureFeatures(): Map<string, unknown> {
    let map = featureStore.get(haId)
    if (!map) {
      map = new Map()
      featureStore.set(haId, map)
    }
    return map
  }

  function applyFeature(key: string, value: unknown): void {
    ensureFeatures().set(key, value)
    for (const fn of listeners) fn(haId, key, value)
  }

  function setLink(next: HomeConnectLinkState): void {
    if (link === next) return
    link = next
    for (const fn of linkListeners) fn(haId, next)
  }

  function applyInfo(service: 'ci' | 'ni', fields: HomeConnectInfoFields): void {
    for (const [field, value] of Object.entries(fields)) {
      applyFeature(infoFeatureName(service, field), value)
    }
  }

  function dropSession(): void {
    session = null
    // A value read before the drop is not a value now: the appliance may have
    // changed it, or lost power. Everything is unknown until the next handshake.
    ensureFeatures().clear()
    setLink('disconnected')
  }

  async function openOnce(): Promise<void> {
    setLink('connecting')
    const connectAddress = await (deps.resolveAddress ?? resolveConnectAddress)(input.config.host)
    // close() may have run during the lookup: nothing was built yet, so nothing is left behind.
    if (!wanted) throw new Error('Home Connect client closed')
    const wire = input.wireFactory({
      host: input.config.host,
      connectAddress,
      psk: input.config.psk,
      mode: input.config.mode,
      iv64: input.config.iv64,
    })
    const next: HomeConnectSession = new HomeConnectSession({
      wire,
      description,
      onFeature: applyFeature,
      onInfo: applyInfo,
      onDescriptionChange: (names) => {
        for (const name of names) {
          for (const fn of listeners) fn(haId, name, ensureFeatures().get(name))
        }
      },
      onEmptyEntityIndex: () => {
        if (warnedEmptyIndex) return
        warnedEmptyIndex = true
        deps.onProtocolWarn?.('empty-entity-index')
      },
      onClosed: (reason) => {
        if (session !== next) return
        deps.logger?.warn('Home Connect link dropped — reconnecting', {
          tags: deps.logTags ?? {},
          meta: { haId, reason },
        })
        dropSession()
        scheduleReconnect()
      },
      logger: deps.logger,
      logTags: deps.logTags,
      keepaliveMs: deps.keepaliveMs,
    })
    session = next
    try {
      await next.connect()
    } catch (err: unknown) {
      if (session === next) session = null
      throw err
    }
    if (!wanted) {
      // close() ran while the handshake was in flight and found nothing to close yet.
      if (session === next) session = null
      await next.close()
      throw new Error('Home Connect client closed')
    }
    attempt = 0
    setLink('connected')
  }

  function scheduleReconnect(): void {
    if (!wanted || retryTimer !== null) return
    const base = backoff[Math.min(attempt, backoff.length - 1)] ?? 60_000
    // +-20 % so appliances behind one router do not all knock on the same tick.
    const delay = Math.round(base * (1 + (jitter() - 0.5) * 0.4))
    attempt += 1
    retryTimer = setTimeout(() => {
      retryTimer = null
      // A connect() may have won the race while this timer was pending: one session only.
      if (!wanted || opening !== null || link === 'connected') return
      opening = openOnce()
        .catch((err: unknown) => {
          deps.logger?.warn('Home Connect reconnect failed', {
            tags: deps.logTags ?? {},
            meta: { haId, attempt, error: errMsg(err) },
          })
          setLink('disconnected')
          scheduleReconnect()
        })
        .finally(() => {
          opening = null
        })
    }, delay)
  }

  return {
    async connect(): Promise<void> {
      wanted = true
      if (retryTimer !== null) clearTimeout(retryTimer)
      retryTimer = null
      if (link === 'connected') return
      if (opening !== null) return opening
      const attemptPromise = openOnce()
      opening = attemptPromise.then(
        () => undefined,
        () => undefined,
      )
      try {
        await attemptPromise
      } catch (err: unknown) {
        setLink('disconnected')
        scheduleReconnect()
        throw err
      } finally {
        opening = null
      }
    },
    close(): void {
      wanted = false
      if (retryTimer !== null) clearTimeout(retryTimer)
      retryTimer = null
      const closing = session
      session = null
      ensureFeatures().clear()
      setLink('disconnected')
      if (closing) void closing.close()
    },
    getAppliances(): readonly HomeConnectApplianceInfo[] {
      return input.appliances
    },
    getFeatures(targetHaId: string): ReadonlyMap<string, unknown> {
      if (targetHaId !== haId && !featureStore.has(targetHaId)) {
        return new Map()
      }
      return featureStore.get(targetHaId) ?? ensureFeatures()
    },
    async setFeature(targetHaId: string, key: string, value: unknown): Promise<void> {
      const live = requireSession(session, targetHaId, haId)
      await live.setFeatureByName(key, value)
    },
    onFeatureChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getLinkState: () => link,
    onLinkChange(listener) {
      linkListeners.add(listener)
      return () => linkListeners.delete(listener)
    },
    getDescription: (targetHaId) => (targetHaId === haId ? description : null),
    async setDescription(targetHaId, next): Promise<void> {
      if (targetHaId !== haId) throw new Error(`Unknown appliance ${targetHaId}`)
      description.replace(next)
      await session?.resync()
    },
    async selectProgram(targetHaId, program, options): Promise<void> {
      await requireSession(session, targetHaId, haId).selectProgram(program, options)
    },
    async startProgram(targetHaId, program, options): Promise<void> {
      await requireSession(session, targetHaId, haId).startProgram(program, options)
    },
  }
}

function requireSession(
  session: HomeConnectSession | null,
  targetHaId: string,
  haId: string,
): HomeConnectSession {
  if (!session?.connected) throw new Error('Home Connect WebSocket not connected')
  if (targetHaId !== haId) throw new Error(`Unknown appliance ${targetHaId}`)
  return session
}

function createLegacySubscribeClient(
  config: HomeConnectGatewayConfig,
  deps: { readonly wsFactory?: WsFactory },
  appliances: HomeConnectApplianceInfo[],
): HomeConnectWsClient {
  const linkListeners = new Set<(haId: string, state: HomeConnectLinkState) => void>()
  const wsFactory = deps.wsFactory ?? defaultWsFactoryLegacy
  const url = homeConnectWsUrl(config)
  const featureStore = new Map<string, Map<string, unknown>>()
  const listeners = new Set<(haId: string, key: string, value: unknown) => void>()
  let ws: WsLike | null = null
  let connected = false

  function ensureFeatures(haId: string): Map<string, unknown> {
    let map = featureStore.get(haId)
    if (!map) {
      map = new Map()
      featureStore.set(haId, map)
    }
    return map
  }

  function applyFeature(haId: string, key: string, value: unknown): void {
    ensureFeatures(haId).set(key, value)
    for (const fn of listeners) fn(haId, key, value)
  }

  return {
    async connect(): Promise<void> {
      if (connected) return
      await new Promise<void>((resolve, reject) => {
        const socket = wsFactory(url)
        ws = socket
        const onOpen = (): void => {
          connected = true
          for (const app of appliances) for (const fn of linkListeners) fn(app.haId, 'connected')
          socket.removeEventListener('open', onOpen)
          socket.removeEventListener('error', onError)
          for (const app of appliances) {
            socket.send(JSON.stringify({ type: 'subscribe', haId: app.haId }))
          }
          resolve()
        }
        const onError = (): void => {
          reject(new Error('Home Connect WebSocket connection failed'))
        }
        socket.addEventListener('open', onOpen)
        socket.addEventListener('error', onError)
        socket.addEventListener('message', (ev) => {
          if (!ev.data) return
          try {
            const row: unknown = JSON.parse(ev.data)
            if (!isPlainObject(row)) return
            if (row['type'] === 'feature') {
              const msgHaId = row['haId']
              const key = row['key']
              if (typeof msgHaId === 'string' && typeof key === 'string') {
                applyFeature(msgHaId, key, row['value'])
              }
            }
          } catch {
            // ignore malformed frames
          }
        })
      })
    },
    close(): void {
      connected = false
      ws?.close()
      ws = null
    },
    getAppliances(): readonly HomeConnectApplianceInfo[] {
      return appliances
    },
    getFeatures(haId: string): ReadonlyMap<string, unknown> {
      return ensureFeatures(haId)
    },
    async setFeature(haId: string, key: string, value: unknown): Promise<void> {
      if (!ws || ws.readyState !== WS_OPEN) {
        throw new Error('Home Connect WebSocket not connected')
      }
      ws.send(JSON.stringify({ type: 'set', haId, key, value }))
    },
    onFeatureChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getLinkState: () => (connected ? 'connected' : 'disconnected'),
    onLinkChange(listener) {
      linkListeners.add(listener)
      return () => linkListeners.delete(listener)
    },
    getDescription: () => null,
    async setDescription(): Promise<void> {
      throw new Error('Home Connect AES local socket has no description model')
    },
    async selectProgram(): Promise<void> {
      throw new Error('Home Connect AES local socket cannot select a program')
    },
    async startProgram(): Promise<void> {
      throw new Error('Home Connect AES local socket cannot start a program')
    },
  }
}

function isWsLike(value: unknown): value is WsLike {
  if (!isPlainObject(value)) return false
  return (
    typeof value['readyState'] === 'number' &&
    typeof value['send'] === 'function' &&
    typeof value['close'] === 'function' &&
    typeof value['addEventListener'] === 'function' &&
    typeof value['removeEventListener'] === 'function'
  )
}

function defaultWsFactoryLegacy(url: string): WsLike {
  const WS = globalThis.WebSocket
  if (typeof WS !== 'function') {
    throw new Error(`WebSocket unavailable — cannot connect to ${url}`)
  }
  const socket = new WS(url)
  if (!isWsLike(socket)) {
    throw new Error(`WebSocket instance is not WsLike-compatible (${url})`)
  }
  return socket
}

/** Default factory used by the integration manager (overridable in tests). */
export const defaultHomeConnectWsClientFactory: HomeConnectWsClientFactory = (config) =>
  createHomeConnectWsClient(config)
