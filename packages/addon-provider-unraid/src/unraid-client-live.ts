import { Agent } from 'undici'
import WebSocket from 'ws'
import {
  UnraidApiError,
  UnraidAuthError,
  UnraidClient,
  UnraidTransportError,
  type ArrayDisk,
  type ArrayInfo,
  type DockerContainer,
  type DockerContainerStats,
  type CpuMetrics,
  type Notification,
  type WebSocketImpl,
} from 'node-unraid'
import type {
  UnraidArrayDiskInfo,
  UnraidArrayInfo,
  UnraidClientFactory,
  UnraidClientFactoryInput,
  UnraidClientLike,
  UnraidContainerInfo,
  UnraidCpuInfo,
  UnraidNotificationsInfo,
} from './unraid-client-contract.js'

/** How long a live-metric subscription is sampled for one value, in ms. */
const SAMPLE_WINDOW_MS = 2500

/** Why a call to the Unraid API failed. */
export type UnraidClientFailureKind = 'auth' | 'api' | 'transport' | 'unknown'

/** Typed failure of the live adapter; the message never carries the API key. */
export class UnraidClientError extends Error {
  readonly kind: UnraidClientFailureKind
  constructor(kind: UnraidClientFailureKind, message: string) {
    super(message)
    this.name = 'UnraidClientError'
    this.kind = kind
  }
}

/** The subset of the `node-unraid` `UnraidClient` the adapter reads; the real client satisfies it. */
export interface UnraidApiSource {
  readonly array: {
    get(): Promise<ArrayInfo>
    setState(input: { desiredState: 'START' | 'STOP' }): Promise<unknown>
    readonly parity: {
      start(correct: boolean): Promise<unknown>
      cancel(): Promise<unknown>
    }
  }
  readonly docker: {
    list(): Promise<readonly Pick<DockerContainer, 'id' | 'names' | 'state'>[]>
    start(id: string): Promise<unknown>
    stop(id: string): Promise<unknown>
    stats$(): AsyncIterable<DockerContainerStats>
  }
  readonly system: {
    versions(): Promise<unknown>
    cpu$(): AsyncIterable<CpuMetrics>
    info?(): Promise<{ readonly os?: { readonly hostname?: string | null } | null }>
  }
  readonly notifications: {
    warningsAndAlerts(): Promise<Notification[]>
  }
  close(): Promise<void>
}

function classify(err: unknown): UnraidClientError {
  if (err instanceof UnraidClientError) return err
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof UnraidAuthError) return new UnraidClientError('auth', message)
  if (err instanceof UnraidApiError) return new UnraidClientError('api', message)
  if (err instanceof UnraidTransportError) return new UnraidClientError('transport', message)
  return new UnraidClientError('unknown', message)
}

async function guard<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    throw classify(err)
  }
}

/** Parse a numeric string/number from the API; null when absent or not finite. */
function num(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function mapDisk(disk: ArrayDisk): UnraidArrayDiskInfo {
  const temp = disk.temp
  const overWarning =
    temp !== null && disk.warning !== null && disk.warning > 0 && temp >= disk.warning
  const overCritical =
    temp !== null && disk.critical !== null && disk.critical > 0 && temp >= disk.critical
  return {
    id: disk.id,
    name: disk.name ?? `disk${disk.idx}`,
    // The API reports filesystem sizes in kilobytes.
    fsSizeBytes: kbToBytes(num(disk.fsSize)),
    fsUsedBytes: kbToBytes(num(disk.fsUsed)),
    fsFreeBytes: kbToBytes(num(disk.fsFree)),
    tempC: temp,
    healthy: disk.status === 'DISK_OK' && !overWarning && !overCritical,
  }
}

function kbToBytes(kb: number | null): number | null {
  return kb === null ? null : kb * 1024
}

function mapArray(info: ArrayInfo): UnraidArrayInfo {
  const members = [...info.parities, ...info.disks, ...info.caches]
  const kb = info.capacity.kilobytes
  const parity = info.parityCheckStatus
  return {
    state: info.state,
    capacityKb: {
      total: num(kb.total) ?? 0,
      used: num(kb.used) ?? 0,
      free: num(kb.free) ?? 0,
    },
    parityCheck:
      parity === null ? null : { running: parity.running === true, progress: parity.progress ?? 0 },
    disks: members.map(mapDisk),
  }
}

/** First value of a subscription within the sample window, or null. */
async function sampleFirst<T>(source: AsyncIterable<T>): Promise<T | null> {
  const iterator = source[Symbol.asyncIterator]()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), SAMPLE_WINDOW_MS)
  })
  try {
    const next = await Promise.race([iterator.next(), timeout])
    return next === null || next.done === true ? null : next.value
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    void iterator.return?.().catch(() => undefined)
  }
}

/** Collect container stats from the subscription for one sample window, keyed by id. */
async function sampleContainerStats(
  source: AsyncIterable<DockerContainerStats>,
  expected: number,
): Promise<ReadonlyMap<string, DockerContainerStats>> {
  const stats = new Map<string, DockerContainerStats>()
  if (expected === 0) return stats
  const iterator = source[Symbol.asyncIterator]()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), SAMPLE_WINDOW_MS)
  })
  try {
    while (stats.size < expected) {
      const next = await Promise.race([iterator.next(), timeout])
      if (next === null || next.done === true) break
      stats.set(next.value.id, next.value)
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    void iterator.return?.().catch(() => undefined)
  }
  return stats
}

function mapNotifications(items: readonly Notification[]): UnraidNotificationsInfo {
  const sorted = [...items].sort(
    (a, b) => (Date.parse(b.timestamp ?? '') || 0) - (Date.parse(a.timestamp ?? '') || 0),
  )
  const latest = sorted[0]
  return {
    activeCount: items.length,
    latest:
      latest === undefined
        ? null
        : {
            id: latest.id,
            title: latest.title,
            subject: latest.subject,
            description: latest.description,
            importance: latest.importance,
            timestamp: latest.timestamp,
          },
  }
}

/** Implement {@link UnraidClientLike} over an {@link UnraidApiSource}. Pure polling plus one-shot samples. */
export function createLiveUnraidClient(api: UnraidApiSource): UnraidClientLike {
  return {
    connect: () => guard(async () => void (await api.system.versions())),
    disconnect: () => guard(() => api.close()),
    array: {
      get: () => guard(async () => mapArray(await api.array.get())),
      setState: (desired) =>
        guard(async () => void (await api.array.setState({ desiredState: desired }))),
      parity: {
        start: (correct) => guard(async () => void (await api.array.parity.start(correct))),
        cancel: () => guard(async () => void (await api.array.parity.cancel())),
      },
    },
    docker: {
      list: () =>
        guard(async (): Promise<readonly UnraidContainerInfo[]> => {
          const containers = await api.docker.list()
          // Stats exist only as a subscription; a missing sample is unknown (null), never 0.
          const stats = await (async () =>
            sampleContainerStats(api.docker.stats$(), containers.length))().catch(
            () => new Map<string, DockerContainerStats>(),
          )
          return containers.map((c) => ({
            id: c.id,
            name: (c.names[0] ?? c.id).replace(/^\//, ''),
            running: c.state === 'RUNNING',
            cpuPercent: stats.get(c.id)?.cpuPercent ?? null,
            memPercent: stats.get(c.id)?.memPercent ?? null,
          }))
        }),
      start: (id) => guard(async () => void (await api.docker.start(id))),
      stop: (id) => guard(async () => void (await api.docker.stop(id))),
    },
    system: {
      cpu: () =>
        guard(async (): Promise<UnraidCpuInfo> => {
          const sample = await (async () => sampleFirst(api.system.cpu$()))().catch(() => null)
          // The API exposes no CPU temperature or power draw.
          return { percent: sample?.percentTotal ?? null, tempC: null, powerW: null }
        }),
      ...(api.system.info !== undefined
        ? {
            info: () =>
              guard(async () => {
                const info = await api.system.info?.()
                const hostname = info?.os?.hostname?.trim() ?? ''
                return { hostname: hostname.length > 0 ? hostname : null }
              }),
          }
        : {}),
    },
    notifications: {
      active: () =>
        guard(async () => mapNotifications(await api.notifications.warningsAndAlerts())),
    },
  }
}

/** Production factory: a real `node-unraid` client, authenticated with the integration's API key. */
export const makeLiveUnraidClient: UnraidClientFactory = (input: UnraidClientFactoryInput) => {
  const base = {
    host: input.host,
    port: input.port,
    https: input.https,
    apiKey: input.apiKey,
  }
  if (!input.allowSelfSigned) return createLiveUnraidClient(new UnraidClient(base))
  // Opt-in, per integration: a self-signed certificate on both the HTTP and the WS transport.
  const dispatcher = new Agent({ connect: { rejectUnauthorized: false } })
  return createLiveUnraidClient(
    new UnraidClient({
      ...base,
      fetch: (url, init) => fetch(url, withDispatcher(init, dispatcher)),
      webSocketImpl: selfSignedWebSocketImpl(),
    }),
  )
}

/**
 * TYPE BOUNDARY (the only casts in this file): the repo's `undici` and the `undici-types`
 * behind the global `fetch` / DOM `WebSocket` declare structurally incompatible twins of
 * the same classes, although at runtime they are the same objects. These two helpers
 * narrow that gap in one place.
 */
function withDispatcher(init: RequestInit | undefined, dispatcher: Agent): RequestInit {
  return { ...init, dispatcher } as unknown as RequestInit
}

function selfSignedWebSocketImpl(): WebSocketImpl {
  class SelfSignedWebSocket extends WebSocket {
    constructor(address: string | URL, protocols?: string | string[]) {
      super(address, protocols, { rejectUnauthorized: false })
    }
  }
  return SelfSignedWebSocket as unknown as WebSocketImpl
}
