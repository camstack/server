import { errMsg, type IScopedLogger } from '@camstack/types'
import type { HomeConnectDescriptionStore } from './home-connect-description-store.js'
import {
  decodeHomeConnectValue,
  encodeHomeConnectValue,
} from './home-connect-device-description.js'
import {
  dumpHomeConnectMessage,
  HC_ACTION,
  loadHomeConnectMessage,
  responseTo,
  type HomeConnectMessage,
} from './home-connect-message.js'
import type { HomeConnectWire } from './home-connect-wire.js'

const APP_NAME = 'CamStack'
const APP_ID = 'camstack-hc'

/** Max wait for appliance `/ei/initialValues` after the socket opens. */
export const HOME_CONNECT_INIT_RESOURCE_TIMEOUT_MS = 12_000
/** Max wait for the response to one request. */
export const HOME_CONNECT_REQUEST_TIMEOUT_MS = 5_000
/** Idle interval between liveness probes on an established session. */
export const HOME_CONNECT_KEEPALIVE_MS = 30_000

/** Consecutive unanswered probes before the link is declared dead. */
export const HOME_CONNECT_KEEPALIVE_MAX_MISSES = 3

/** A response `code` at or above this is the appliance refusing the request. */
const RESPONSE_ERROR_CODE_MIN = 400

/** Scalar fields of an informational resource (`/ci/info`, `/ni/info`). */
export type HomeConnectInfoFields = Readonly<Record<string, string | number | boolean>>

export interface HomeConnectSessionOptions {
  readonly wire: HomeConnectWire
  readonly description: HomeConnectDescriptionStore
  readonly onFeature: (key: string, value: unknown) => void
  readonly onEmptyEntityIndex?: () => void
  /** The socket went away while the session was open (not a `close()` of ours). */
  readonly onClosed?: (reason: string) => void
  /** `/ci/info` → `ci`, `/ni/info` → `ni`: every scalar field the appliance sent. */
  readonly onInfo?: (service: 'ci' | 'ni', fields: HomeConnectInfoFields) => void
  /** Feature names whose constraints/availability moved (`/ro/descriptionChange`). */
  readonly onDescriptionChange?: (names: readonly string[]) => void
  readonly logger?: IScopedLogger
  /** Tags merged into every protocol log line (the integration). */
  readonly logTags?: Readonly<Record<string, string>>
  readonly keepaliveMs?: number
  readonly requestTimeoutMs?: number
}

interface PendingRequest {
  readonly resource: string
  readonly resolve: (msg: HomeConnectMessage) => void
  readonly reject: (err: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}

function scalarFields(row: Readonly<Record<string, unknown>>): HomeConnectInfoFields {
  const out: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value
    }
  }
  return out
}

export class HomeConnectSession {
  readonly #wire: HomeConnectWire
  readonly #description: HomeConnectDescriptionStore
  readonly #onFeature: (key: string, value: unknown) => void
  readonly #onEmptyEntityIndex: (() => void) | undefined
  readonly #onClosed: ((reason: string) => void) | undefined
  readonly #onInfo: ((service: 'ci' | 'ni', fields: HomeConnectInfoFields) => void) | undefined
  readonly #onDescriptionChange: ((names: readonly string[]) => void) | undefined
  readonly #logger: IScopedLogger | undefined
  readonly #logTags: Readonly<Record<string, string>>
  readonly #keepaliveMs: number
  readonly #requestTimeoutMs: number
  #sid = 0
  #nextMsgId = 1
  #serviceVersions: Readonly<Record<string, number>> = {}
  readonly #pending = new Map<number, PendingRequest>()
  readonly #warnedUnknownUids = new Set<number>()
  #warnedEmptyIndex = false
  #undecodableCount = 0
  #connected = false
  #closing = false
  #unsubText: (() => void) | null = null
  #unsubClosed: (() => void) | null = null
  #keepalive: ReturnType<typeof setInterval> | null = null
  #missedProbes = 0

  constructor(options: HomeConnectSessionOptions) {
    this.#wire = options.wire
    this.#description = options.description
    this.#onFeature = options.onFeature
    this.#onEmptyEntityIndex = options.onEmptyEntityIndex
    this.#onClosed = options.onClosed
    this.#onInfo = options.onInfo
    this.#onDescriptionChange = options.onDescriptionChange
    this.#logger = options.logger
    this.#logTags = options.logTags ?? {}
    this.#keepaliveMs = options.keepaliveMs ?? HOME_CONNECT_KEEPALIVE_MS
    this.#requestTimeoutMs = options.requestTimeoutMs ?? HOME_CONNECT_REQUEST_TIMEOUT_MS
  }

  get connected(): boolean {
    return this.#connected
  }

  async connect(): Promise<void> {
    if (this.#connected) return
    this.#closing = false
    this.#unsubText = this.#wire.onText((text) => this.#handleIncoming(text))
    this.#unsubClosed = this.#wire.onClosed(() => this.#handleWireClosed())
    try {
      await this.#handshake()
    } catch (err: unknown) {
      await this.close()
      throw err
    }
    this.#connected = true
    this.#startKeepalive()
  }

  async #handshake(): Promise<void> {
    const initPromise = this.#waitForResource('/ei/initialValues')
    await this.#wire.connect()
    const initRaw = await initPromise
    const init = loadHomeConnectMessage(initRaw)
    this.#sid = init.sID
    const first = init.data?.[0]
    const edMsgId = first?.['edMsgID']
    if (typeof edMsgId === 'number') this.#nextMsgId = edMsgId

    this.#wire.send(
      dumpHomeConnectMessage(
        responseTo(init, {
          deviceType: init.version === 1 ? 2 : 'Application',
          deviceName: APP_NAME,
          deviceID: APP_ID,
        }),
      ),
    )

    const services = await this.#sendGet('/ci/services', 1)
    this.#setServiceVersions(services)

    if (this.#serviceVersions['ei'] === 2) {
      await this.#sendNotify('/ei/deviceReady')
    }

    if ('iz' in this.#serviceVersions) {
      await this.#sendGet('/iz/info', this.#serviceVersions['iz'] ?? 1).catch(() => undefined)
    }

    const mandatory = await this.#sendGet(
      '/ro/allMandatoryValues',
      this.#serviceVersions['ro'] ?? 1,
    )
    this.#applyValuePayload(mandatory.data)

    if (this.#description.size === 0) {
      this.#onEmptyEntityIndex?.()
    }

    await this.#loadOptionalResources()
  }

  /**
   * Description changes and the info services are best-effort: an appliance that
   * lacks one still serves values, and the failure is logged, not fatal.
   */
  async #loadOptionalResources(): Promise<void> {
    const ro = this.#serviceVersions['ro'] ?? 1
    await this.#sendGet('/ro/allDescriptionChanges', ro)
      .then((msg) => this.#applyDescriptionChanges(msg.data))
      .catch((err: unknown) => this.#warn('allDescriptionChanges unavailable', err))
    for (const [service, resource] of [
      ['ci', '/ci/info'],
      ['ni', '/ni/info'],
    ] as const) {
      if (!(service in this.#serviceVersions)) continue
      await this.#sendGet(resource, this.#serviceVersions[service] ?? 1)
        .then((msg) => {
          const row = msg.data?.[0]
          if (row !== undefined) this.#onInfo?.(service, scalarFields(row))
        })
        .catch((err: unknown) => this.#warn(`${resource} unavailable`, err))
    }
  }

  /** Re-read every mandatory value (after the description arrived late, or a gap). */
  async resync(): Promise<void> {
    if (!this.#connected) return
    const msg = await this.#sendGet('/ro/allMandatoryValues', this.#serviceVersions['ro'] ?? 1)
    this.#applyValuePayload(msg.data)
  }

  async close(): Promise<void> {
    this.#closing = true
    this.#connected = false
    this.#stopKeepalive()
    this.#unsubText?.()
    this.#unsubText = null
    this.#unsubClosed?.()
    this.#unsubClosed = null
    this.#rejectAllPending(new Error('Home Connect session closed'))
    this.#wire.close()
  }

  /**
   * POST one value. The feature changes ONLY when the appliance confirms with a
   * `/ro/values` notification — nothing is echoed here, so a refused write never
   * leaves a value the appliance does not hold.
   */
  async setFeatureByName(key: string, value: unknown): Promise<void> {
    const encoded = encodeHomeConnectValue(key, value, this.#description.index())
    if (!encoded) throw new Error(`Unknown Home Connect feature: ${key}`)
    await this.#post('/ro/values', [{ uid: encoded.uid, value: encoded.value }])
  }

  /** Select (not start) a program, with its option values. */
  async selectProgram(programName: string, options: ProgramOptionValues = {}): Promise<void> {
    const target = this.#description.entityOfKind('selectedProgram')
    if (!target) throw new Error('Home Connect appliance has no selected-program entity')
    await this.#postProgram('/ro/selectedProgram', programName, options)
  }

  /** Start a program (the selected one when `programName` is omitted by the caller resolving it). */
  async startProgram(programName: string, options: ProgramOptionValues = {}): Promise<void> {
    const target = this.#description.entityOfKind('activeProgram')
    if (!target) throw new Error('Home Connect appliance has no active-program entity')
    await this.#postProgram('/ro/activeProgram', programName, options)
  }

  async #postProgram(
    resource: string,
    programName: string,
    options: ProgramOptionValues,
  ): Promise<void> {
    const program = this.#description.entityByName(programName)
    if (!program || program.kind !== 'program') {
      throw new Error(`Unknown Home Connect program: ${programName}`)
    }
    const optionRows: Record<string, unknown>[] = []
    for (const [key, value] of Object.entries(options)) {
      const encoded = encodeHomeConnectValue(key, value, this.#description.index())
      if (!encoded) throw new Error(`Unknown Home Connect program option: ${key}`)
      optionRows.push({ uid: encoded.uid, value: encoded.value })
    }
    await this.#post(resource, [
      { program: program.uid, ...(optionRows.length > 0 ? { options: optionRows } : {}) },
    ])
  }

  async #post(resource: string, data: readonly Record<string, unknown>[]): Promise<void> {
    if (!this.#connected) throw new Error('Home Connect session not connected')
    const ro = this.#serviceVersions['ro'] ?? 1
    const response = await this.#sendAndWaitResponse({
      sID: this.#sid,
      msgID: this.#allocMsgId(),
      resource,
      version: ro,
      action: HC_ACTION.POST,
      data,
    })
    if (response.code !== undefined && response.code >= RESPONSE_ERROR_CODE_MIN) {
      throw new Error(`Home Connect appliance refused ${resource} (code ${response.code})`)
    }
  }

  #setServiceVersions(message: HomeConnectMessage): void {
    const versions: Record<string, number> = {}
    for (const row of message.data ?? []) {
      const service = row['service']
      const version = row['version']
      if (typeof service === 'string' && typeof version === 'number') {
        versions[service] = version
      }
    }
    this.#serviceVersions = versions
  }

  #applyValuePayload(data: readonly Record<string, unknown>[] | undefined): void {
    if (!data) return
    for (const row of data) {
      this.#applyUidRow(row)
    }
  }

  #applyUidRow(row: Record<string, unknown>): void {
    const uidRaw = row['uid']
    if (typeof uidRaw !== 'number') return
    const index = this.#description.index()
    const entity = index.get(uidRaw)
    if (entity === undefined) {
      this.#noteUnknownUid(uidRaw, row['value'])
      return
    }
    const value = row['value']
    if (entity.kind === 'activeProgram' || entity.kind === 'selectedProgram') {
      this.#onFeature(entity.name, this.#programNameOf(value))
      return
    }
    const decoded = decodeHomeConnectValue(uidRaw, value, index)
    if (decoded) this.#onFeature(decoded.key, decoded.value)
  }

  /** A program entity's value is the program's uid; `0` / absent = no program. */
  #programNameOf(value: unknown): string | null {
    if (typeof value !== 'number' || value === 0) return null
    return this.#description.entity(value)?.name ?? null
  }

  #noteUnknownUid(uid: number, value: unknown): void {
    if (this.#description.size === 0) {
      if (!this.#warnedEmptyIndex) {
        this.#warnedEmptyIndex = true
        this.#onEmptyEntityIndex?.()
      }
    }
    if (this.#warnedUnknownUids.has(uid)) return
    this.#warnedUnknownUids.add(uid)
    this.#logger?.warn('Home Connect value for a uid the description does not list — dropped', {
      tags: this.#logTags,
      meta: { uid, valueType: typeof value },
    })
  }

  #applyDescriptionChanges(data: readonly Record<string, unknown>[] | undefined): void {
    if (!data) return
    const touched = this.#description.applyChanges(data)
    if (touched.length > 0) this.#onDescriptionChange?.(touched)
  }

  #applyProgramNotify(data: readonly Record<string, unknown>[] | undefined, kind: string): void {
    const row = data?.[0]
    if (row === undefined) return
    const entity = this.#description.entityOfKind(
      kind === 'active' ? 'activeProgram' : 'selectedProgram',
    )
    if (entity !== undefined) this.#onFeature(entity.name, this.#programNameOf(row['program']))
    const options = row['options']
    if (Array.isArray(options)) {
      for (const option of options) {
        if (typeof option === 'object' && option !== null && !Array.isArray(option)) {
          this.#applyUidRow({ ...option })
        }
      }
    }
  }

  #handleIncoming(text: string): void {
    let message: HomeConnectMessage
    try {
      message = loadHomeConnectMessage(text)
    } catch (err: unknown) {
      this.#noteUndecodable(err)
      return
    }
    if (message.action === HC_ACTION.RESPONSE) {
      const waiter = this.#pending.get(message.msgID)
      if (waiter) {
        clearTimeout(waiter.timer)
        this.#pending.delete(message.msgID)
        waiter.resolve(message)
      }
      return
    }
    if (message.action !== HC_ACTION.NOTIFY) return
    switch (message.resource) {
      case '/ro/values':
        this.#applyValuePayload(message.data)
        return
      case '/ro/descriptionChange':
      case '/ro/allDescriptionChanges':
        this.#applyDescriptionChanges(message.data)
        return
      case '/ro/activeProgram':
        this.#applyProgramNotify(message.data, 'active')
        return
      case '/ro/selectedProgram':
        this.#applyProgramNotify(message.data, 'selected')
        return
      default:
        return
    }
  }

  /** Warn on the first undecodable frame, then at powers of ten — a stuck peer must not flood the log. */
  #noteUndecodable(err: unknown): void {
    this.#undecodableCount += 1
    const n = this.#undecodableCount
    if (n !== 1 && n !== 10 && n !== 100 && n % 1000 !== 0) return
    this.#logger?.warn('Home Connect frame dropped — undecodable', {
      tags: this.#logTags,
      meta: { error: errMsg(err), droppedSoFar: n },
    })
  }

  #warn(message: string, err: unknown): void {
    this.#logger?.warn(`Home Connect ${message}`, {
      tags: this.#logTags,
      meta: { error: errMsg(err) },
    })
  }

  #handleWireClosed(): void {
    if (this.#closing) return
    const wasConnected = this.#connected
    this.#connected = false
    this.#stopKeepalive()
    this.#rejectAllPending(new Error('Home Connect wire closed'))
    if (wasConnected) this.#onClosed?.('wire closed')
  }

  #startKeepalive(): void {
    this.#stopKeepalive()
    this.#missedProbes = 0
    if (this.#keepaliveMs <= 0) return
    this.#keepalive = setInterval(() => {
      void this.#probe()
    }, this.#keepaliveMs)
  }

  #stopKeepalive(): void {
    if (this.#keepalive !== null) clearInterval(this.#keepalive)
    this.#keepalive = null
  }

  /**
   * A cheap request the appliance must answer. A dead socket that never reports
   * closed (NAT drop, appliance power loss) surfaces here as a timeout, and the
   * session is torn down so the owner reconnects.
   */
  async #probe(): Promise<void> {
    if (!this.#connected) return
    try {
      await this.#sendGet('/ci/services', 1)
      this.#missedProbes = 0
    } catch (err: unknown) {
      if (!this.#connected) return
      // One slow answer is not a dead link (the appliance may be busy with a cycle).
      this.#missedProbes += 1
      if (this.#missedProbes < HOME_CONNECT_KEEPALIVE_MAX_MISSES) return
      this.#warn('keepalive failed repeatedly — dropping the connection', err)
      this.#wire.close()
    }
  }

  #waitForResource(resource: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        unsubText()
        unsubClosed()
        fn()
      }
      const unsubText = this.#wire.onText((text) => {
        try {
          const msg = loadHomeConnectMessage(text)
          if (msg.resource === resource) {
            finish(() => resolve(text))
          }
        } catch {
          // Not the awaited frame; #handleIncoming accounts for undecodable ones.
        }
      })
      const unsubClosed = this.#wire.onClosed(() => {
        finish(() => reject(new Error('Home Connect wire closed before init')))
      })
      const timer = setTimeout(() => {
        finish(() => reject(new Error(`Home Connect init timeout waiting for ${resource}`)))
      }, HOME_CONNECT_INIT_RESOURCE_TIMEOUT_MS)
    })
  }

  async #sendGet(resource: string, version: number): Promise<HomeConnectMessage> {
    return this.#sendAndWaitResponse({
      sID: this.#sid,
      msgID: this.#allocMsgId(),
      resource,
      version,
      action: HC_ACTION.GET,
    })
  }

  async #sendNotify(resource: string): Promise<void> {
    const msg = {
      sID: this.#sid,
      msgID: this.#allocMsgId(),
      resource,
      version: this.#serviceVersions[resource.slice(1, 3)] ?? 1,
      action: HC_ACTION.NOTIFY,
    }
    this.#wire.send(dumpHomeConnectMessage(msg))
  }

  #allocMsgId(): number {
    const id = this.#nextMsgId
    this.#nextMsgId += 1
    return id
  }

  #rejectAllPending(err: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    this.#pending.clear()
  }

  async #sendAndWaitResponse(outgoing: HomeConnectMessage): Promise<HomeConnectMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#pending.delete(outgoing.msgID)) {
          reject(new Error(`Home Connect response timeout for ${outgoing.resource}`))
        }
      }, this.#requestTimeoutMs)
      this.#pending.set(outgoing.msgID, { resource: outgoing.resource, resolve, reject, timer })
      try {
        this.#wire.send(dumpHomeConnectMessage(outgoing))
      } catch (err: unknown) {
        clearTimeout(timer)
        this.#pending.delete(outgoing.msgID)
        reject(err instanceof Error ? err : new Error(errMsg(err)))
      }
    })
  }
}

/** Option feature name → value, for `selectProgram` / `startProgram`. */
export type ProgramOptionValues = Readonly<Record<string, string | number | boolean>>
