/**
 * The `tsvesync` adapter behind {@link VeSyncClient}. The library is a thin VeSync cloud client
 * whose manager logs in, lists the account's devices into `fans` and drives each one; this file
 * maps that onto the contract the integration manager builds against.
 *
 * Two library traits shape it:
 *   - `login()` answers only a boolean — the REASON lives in the library's log lines. The adapter
 *     captures the lines a call produces and classifies them ({@link VeSyncLoginError}).
 *   - the library logger is process-wide (`setLogger` inside the `VeSync` constructor), so every
 *     manager gets the same router and calls are serialized: one call's lines never land in
 *     another call's capture.
 *
 * Sessions: the library reports every token it mints through `onTokenChange` and adopts a stored
 * one through `hydrateSession`; the adapter maps both onto the contract's `VeSyncSession` so the
 * library's own type never leaves this file.
 *
 * Credentials: the email and password go to the library and nowhere else. Only the FIRST
 * argument of a library log line (its message) and the `code` / `message` / `msg` of an object
 * argument travel into an error text — never the request or response bodies.
 */
import { type Session as TsVeSyncSession, VeSync } from 'tsvesync'
import {
  type VeSyncClient,
  type VeSyncClientFactory,
  type VeSyncPurifierSnapshot,
  type VeSyncRegion,
  type VeSyncSession,
  VeSyncSessionRejectedError,
} from './vesync-client-contract.js'

/** The logger shape `tsvesync` accepts as `customLogger`. */
export interface TsVeSyncLogSink {
  readonly debug: (message: string, ...args: unknown[]) => void
  readonly info: (message: string, ...args: unknown[]) => void
  readonly warn: (message: string, ...args: unknown[]) => void
  readonly error: (message: string, ...args: unknown[]) => void
}

/** The part of a `tsvesync` fan / air purifier the adapter reads and drives. */
export interface TsVeSyncFan {
  readonly cid: string
  /** The device-list `macID`; empty when not reported. */
  readonly macId: string
  readonly deviceName: string
  readonly deviceType: string
  readonly deviceStatus: string
  readonly connectionStatus: string
  readonly mode: string
  readonly speed: number
  readonly filterLife: number
  readonly screenStatus: 'on' | 'off'
  readonly childLock: boolean
  readonly airQualityValue: number
  getMaxFanSpeed(): number
  getSupportedModes(): ReadonlyArray<string>
  hasFeature(feature: string): boolean
  /** Refreshes the cached details; the answer is ignored (a failed refresh keeps the last ones). */
  getDetails(): Promise<unknown>
  turnOn(): Promise<boolean>
  turnOff(): Promise<boolean>
  changeFanSpeed(level: number): Promise<boolean>
  setMode(mode: string): Promise<boolean>
  /** Present on the air-purifier models (`VeSyncAirBypass` and kin). */
  setChildLock?(on: boolean): Promise<boolean>
  /** Present on the air-purifier models (`VeSyncAirBypass` and kin). */
  setDisplay?(on: boolean): Promise<boolean>
}

/** The part of the `tsvesync` `VeSync` manager the adapter uses. */
export interface TsVeSyncManager {
  login(retryAttempts?: number, initialDelayMs?: number): Promise<boolean>
  getDevices(): Promise<boolean>
  /** Adopt a persisted session (sets the token, account and region; sends nothing). */
  hydrateSession(session: TsVeSyncSession): void
  readonly fans: readonly object[]
}

/** What a manager is built from. `logger` is the shared router every manager is given. */
export interface TsVeSyncManagerInput {
  readonly email: string
  readonly password: string
  readonly region: VeSyncRegion
  /** ISO-3166 alpha-2; absent leaves the library's own default (`US`). */
  readonly countryCode?: string
  /** The terminal id to present on sign-in; absent leaves the library's random one. */
  readonly terminalId?: string
  readonly logger: TsVeSyncLogSink
  /** The library's report of a freshly minted token (after its own login or re-login). */
  readonly onTokenChange?: (session: TsVeSyncSession) => void
}

/** Factory seam over `new VeSync(...)` — the spec substitutes a fake library here. */
export type TsVeSyncManagerFactory = (input: TsVeSyncManagerInput) => TsVeSyncManager

/** Why a sign-in failed, as far as the library's own lines tell. */
export type VeSyncLoginFailureKind = 'credentials' | 'region' | 'unreachable' | 'refused'

/** A failed VeSync sign-in. `words` is the library's own account of it, secret-free. */
export class VeSyncLoginError extends Error {
  readonly kind: VeSyncLoginFailureKind
  readonly words: string

  constructor(kind: VeSyncLoginFailureKind, words: string) {
    super(
      kind === 'region'
        ? `vesync: sign-in failed (${kind}): ${words} — ${REGION_HINT}`
        : `vesync: sign-in failed (${kind}): ${words}`,
    )
    this.name = 'VeSyncLoginError'
    this.kind = kind
    this.words = words
  }
}

/** One library log line as captured. */
export interface LibraryLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly args: readonly unknown[]
}

/** Library speed levels start at 1; the contract speaks percent. */
const MIN_LEVEL = 1
/** The mode in which a speed level applies; every other supported mode is a preset. */
const MANUAL_MODE = 'manual'
/** A purifier is the fan kind that has a filter (humidifiers and tower fans do not). */
const PURIFIER_FEATURE = 'filter_life'
const AIR_QUALITY_FEATURE = 'air_quality'
/** Transport error codes that mean "the cloud was not reached". */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ERR_NETWORK',
])
const CREDENTIALS_PATTERN = /credential/i
/**
 * A sign-in refused for the region or the country. "auth code expired" is what Step 2 answers when
 * the account signs in under the wrong `userCountryCode`; `countryCode` is the library's own hint.
 */
const REGION_PATTERN =
  /both US and EU|COUNTRY CODE REQUIRED|region-change token|auth code expired|countryCode/i
/** What a region refusal tells the operator to do. */
const REGION_HINT =
  'set the Country code on the VeSync integration to the country the account was registered in'

/**
 * The process-wide library logger. Lines go to the capture of the call in flight; calls are
 * serialized so exactly one capture is open at a time.
 */
class LibraryLogRouter implements TsVeSyncLogSink {
  #capture: LibraryLine[] | null = null
  #queue: Promise<unknown> = Promise.resolve()

  readonly debug = (message: string, ...args: unknown[]): void => this.#push('debug', message, args)
  readonly info = (message: string, ...args: unknown[]): void => this.#push('info', message, args)
  readonly warn = (message: string, ...args: unknown[]): void => this.#push('warn', message, args)
  readonly error = (message: string, ...args: unknown[]): void => this.#push('error', message, args)

  /** Run `fn` alone, with every library line it causes collected. */
  run<T>(
    fn: () => Promise<T>,
  ): Promise<{ readonly value: T; readonly lines: readonly LibraryLine[] }> {
    const next = this.#queue.then(async () => {
      const lines: LibraryLine[] = []
      this.#capture = lines
      try {
        return { value: await fn(), lines }
      } finally {
        this.#capture = null
      }
    })
    this.#queue = next.catch((): null => null)
    return next
  }

  #push(level: LibraryLine['level'], message: string, args: readonly unknown[]): void {
    this.#capture?.push({ level, message: String(message), args })
  }
}

const sharedRouter = new LibraryLogRouter()

/**
 * The real library: one `VeSync` manager per account, the shared router as its logger. The
 * library signs in as VeSync's official app id by itself (tsvesync >= 1.7.1; any other id is
 * refused at Step 2 as "auth code expired"); the terminal id is the integration's own, adopted
 * through `restoreClientIdentity` so every sign-in presents the same device.
 */
export const createTsVeSyncLibraryManager: TsVeSyncManagerFactory = (input) => {
  const manager = new VeSync(input.email, input.password, undefined, {
    region: input.region,
    ...(input.countryCode !== undefined ? { countryCode: input.countryCode } : {}),
    customLogger: input.logger,
    ...(input.onTokenChange !== undefined ? { onTokenChange: input.onTokenChange } : {}),
    debug: false,
    redact: true,
  })
  if (input.terminalId !== undefined)
    manager.restoreClientIdentity({ terminalId: input.terminalId })
  return manager
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The secret-free words of one line: the message plus primitive args and error fields. */
function wordsOf(line: LibraryLine): string {
  const parts: string[] = [line.message.trim()]
  for (const arg of line.args) {
    if (typeof arg === 'string' || typeof arg === 'number') {
      parts.push(String(arg))
      continue
    }
    if (!isRecord(arg)) continue
    for (const key of ['code', 'message', 'msg']) {
      const field = arg[key]
      if (typeof field === 'string' || typeof field === 'number') parts.push(String(field))
    }
  }
  return parts.filter((p) => p.length > 0).join(' ')
}

/** Whether a line reports a transport failure (no HTTP answer at all). */
function isTransportFailure(line: LibraryLine): boolean {
  return line.args.some((arg) => {
    if (!isRecord(arg) || 'status' in arg) return false
    const code = arg['code']
    const message = arg['message']
    return (
      (typeof code === 'string' && NETWORK_CODES.has(code)) ||
      (typeof message === 'string' && /timeout/i.test(message))
    )
  })
}

/** Classify a failed sign-in from the lines the library logged while attempting it. */
export function classifyLoginFailure(lines: readonly LibraryLine[]): VeSyncLoginError {
  const errors = lines.filter((l) => l.level === 'error' || l.level === 'warn')
  const words = errors.map(wordsOf).join('; ') || 'VeSync gave no reason'
  // Region first: the library's closing line on ANY failure ("Unable to authenticate with
  // supplied credentials …") matches the credentials pattern; a region refusal never names one.
  if (errors.some((l) => REGION_PATTERN.test(wordsOf(l)))) {
    return new VeSyncLoginError('region', words)
  }
  if (errors.some((l) => CREDENTIALS_PATTERN.test(l.message))) {
    return new VeSyncLoginError('credentials', words)
  }
  if (errors.some(isTransportFailure)) return new VeSyncLoginError('unreachable', words)
  return new VeSyncLoginError('refused', words)
}

/** Narrow a library device to a fan with the calls the adapter needs. */
function isFan(device: object): device is TsVeSyncFan {
  return (
    'cid' in device &&
    typeof device.cid === 'string' &&
    'hasFeature' in device &&
    typeof device.hasFeature === 'function' &&
    'getDetails' in device &&
    typeof device.getDetails === 'function' &&
    'turnOn' in device &&
    typeof device.turnOn === 'function' &&
    'turnOff' in device &&
    typeof device.turnOff === 'function' &&
    'changeFanSpeed' in device &&
    typeof device.changeFanSpeed === 'function' &&
    'setMode' in device &&
    typeof device.setMode === 'function' &&
    'getMaxFanSpeed' in device &&
    typeof device.getMaxFanSpeed === 'function'
  )
}

function isPurifier(fan: TsVeSyncFan): boolean {
  return fan.hasFeature(PURIFIER_FEATURE)
}

/** Map one library purifier onto the contract snapshot. */
export function snapshotOf(fan: TsVeSyncFan): VeSyncPurifierSnapshot {
  const maxLevel = Math.max(MIN_LEVEL, fan.getMaxFanSpeed())
  const power = fan.deviceStatus === 'on'
  const presets = fan.getSupportedModes().filter((m) => m !== MANUAL_MODE)
  const speedPercent =
    power && fan.speed >= MIN_LEVEL ? Math.round((fan.speed / maxLevel) * 100) : null
  return {
    nativeId: fan.cid,
    name: fan.deviceName,
    ...(fan.deviceType !== '' ? { model: fan.deviceType } : {}),
    ...(fan.macId.trim() !== '' ? { mac: fan.macId.trim() } : {}),
    power,
    speedPercent,
    percentageStep: 100 / maxLevel,
    preset: presets.includes(fan.mode) ? fan.mode : '',
    availablePresets: presets,
    childLock: fan.childLock,
    display: fan.screenStatus === 'on',
    ...(fan.hasFeature(AIR_QUALITY_FEATURE) ? { airQuality: fan.airQualityValue } : {}),
    filterLifePercent: Number.isFinite(fan.filterLife) ? fan.filterLife : null,
    online: fan.connectionStatus === 'online',
  }
}

/** A contract percent → the library level: 1..max, rounded up so any non-zero percent runs. */
export function levelOf(percent: number, maxLevel: number): number {
  const top = Math.max(MIN_LEVEL, maxLevel)
  return Math.min(top, Math.max(MIN_LEVEL, Math.ceil((percent / 100) * top)))
}

/** The library's session → the contract's (nulls for what the token does not say). */
export function sessionFromLibrary(session: TsVeSyncSession): VeSyncSession {
  return {
    token: session.token,
    accountId: session.accountId,
    countryCode: session.countryCode ?? null,
    region: session.region,
    apiBaseUrl: session.apiBaseUrl,
    authFlowUsed: session.authFlowUsed ?? null,
    terminalId: session.terminalId ?? null,
    issuedAt: session.issuedAt ?? null,
    expiresAt: session.expiresAt ?? null,
  }
}

/** The contract's session → the shape `hydrateSession` adopts. */
export function sessionToLibrary(session: VeSyncSession): TsVeSyncSession {
  return {
    token: session.token,
    accountId: session.accountId,
    countryCode: session.countryCode,
    region: session.region,
    apiBaseUrl: session.apiBaseUrl,
    ...(session.authFlowUsed !== null ? { authFlowUsed: session.authFlowUsed } : {}),
    ...(session.terminalId !== null ? { terminalId: session.terminalId } : {}),
    issuedAt: session.issuedAt,
    expiresAt: session.expiresAt,
  }
}

/** The library re-authenticated by itself inside a call (a token error mid-run). */
const LIBRARY_RELOGIN_PATTERN = /re-authenticat/i

/** One VeSync account driven through `tsvesync`. */
class TsVeSyncClient implements VeSyncClient {
  readonly #manager: TsVeSyncManager
  readonly #router: LibraryLogRouter
  #fans: Map<string, TsVeSyncFan> = new Map()
  #snapshots: Map<string, VeSyncPurifierSnapshot> = new Map()
  /** A restored session no call has proven yet: its first refusal is a session refusal. */
  #unprovenRestore = false

  constructor(manager: TsVeSyncManager, router: LibraryLogRouter) {
    this.#manager = manager
    this.#router = router
  }

  /** One attempt, no library-side retry: a later reconnect is the manager's decision. */
  async login(): Promise<void> {
    this.#unprovenRestore = false
    const { value, lines } = await this.#router.run(() => this.#manager.login(1, 0))
    if (!value) throw classifyLoginFailure(lines)
  }

  restoreSession(session: VeSyncSession): void {
    this.#manager.hydrateSession(sessionToLibrary(session))
    this.#unprovenRestore = true
  }

  async logout(): Promise<void> {
    this.#fans = new Map()
    this.#snapshots = new Map()
  }

  async listDevices(): Promise<readonly VeSyncPurifierSnapshot[]> {
    const { value: listed, lines } = await this.#router.run(async () => {
      const ok = await this.#manager.getDevices()
      if (!ok) return false
      for (const device of this.#manager.fans) {
        if (isFan(device) && isPurifier(device)) await device.getDetails()
      }
      return true
    })
    if (!listed) throw this.#listFailure(lines)
    this.#unprovenRestore = false
    const fans = new Map<string, TsVeSyncFan>()
    const snapshots = new Map<string, VeSyncPurifierSnapshot>()
    for (const device of this.#manager.fans) {
      if (!isFan(device) || !isPurifier(device)) continue
      fans.set(device.cid, device)
      snapshots.set(device.cid, snapshotOf(device))
    }
    this.#fans = fans
    this.#snapshots = snapshots
    return [...snapshots.values()]
  }

  getDevice(nativeId: string): VeSyncPurifierSnapshot | null {
    return this.#snapshots.get(nativeId) ?? null
  }

  setPower(nativeId: string, on: boolean): Promise<void> {
    return this.#command(nativeId, on ? 'turnOn' : 'turnOff', (fan) =>
      on ? fan.turnOn() : fan.turnOff(),
    )
  }

  setFanSpeed(nativeId: string, percent: number): Promise<void> {
    return this.#command(nativeId, 'changeFanSpeed', (fan) =>
      fan.changeFanSpeed(levelOf(percent, fan.getMaxFanSpeed())),
    )
  }

  setMode(nativeId: string, mode: string): Promise<void> {
    return this.#command(nativeId, 'setMode', (fan) => fan.setMode(mode))
  }

  setChildLock(nativeId: string, on: boolean): Promise<void> {
    return this.#command(nativeId, 'setChildLock', (fan) => {
      if (fan.setChildLock === undefined) {
        throw new Error(`vesync: ${fan.deviceType} has no child lock`)
      }
      return fan.setChildLock(on)
    })
  }

  setDisplay(nativeId: string, on: boolean): Promise<void> {
    return this.#command(nativeId, 'setDisplay', (fan) => {
      if (fan.setDisplay === undefined) {
        throw new Error(`vesync: ${fan.deviceType} has no display control`)
      }
      return fan.setDisplay(on)
    })
  }

  /**
   * Why a device list failed. The library re-authenticating by itself and failing is a sign-in
   * failure; a restored session refused before any call proved it is a session refusal (the
   * caller signs in fresh); a transport failure or anything else stays a plain error.
   */
  #listFailure(lines: readonly LibraryLine[]): Error {
    if (lines.some((l) => LIBRARY_RELOGIN_PATTERN.test(l.message))) {
      return classifyLoginFailure(lines)
    }
    if (this.#unprovenRestore && !lines.some(isTransportFailure)) {
      return new VeSyncSessionRejectedError(failureWords(lines))
    }
    return new Error(`vesync: device list failed: ${failureWords(lines)}`)
  }

  async #command(
    nativeId: string,
    name: string,
    run: (fan: TsVeSyncFan) => Promise<boolean>,
  ): Promise<void> {
    const fan = this.#fans.get(nativeId)
    if (fan === undefined) {
      throw new Error(`vesync: unknown purifier "${nativeId}" — not on the last device list`)
    }
    const { value, lines } = await this.#router.run(() => run(fan))
    if (!value) throw new Error(`vesync: ${name} refused for "${nativeId}": ${failureWords(lines)}`)
  }
}

function failureWords(lines: readonly LibraryLine[]): string {
  return (
    lines
      .filter((l) => l.level === 'error' || l.level === 'warn')
      .map(wordsOf)
      .join('; ') || 'VeSync gave no reason'
  )
}

/** Build the client factory over a library manager factory (the real `tsvesync` by default). */
export function createTsVeSyncClientFactory(
  createManager: TsVeSyncManagerFactory = createTsVeSyncLibraryManager,
): VeSyncClientFactory {
  return ({ email, password, region, countryCode, terminalId, onSession }) =>
    new TsVeSyncClient(
      createManager({
        email,
        password,
        region,
        ...(countryCode !== undefined ? { countryCode } : {}),
        ...(terminalId !== undefined ? { terminalId } : {}),
        logger: sharedRouter,
        ...(onSession !== undefined
          ? { onTokenChange: (session) => onSession(sessionFromLibrary(session)) }
          : {}),
      }),
      sharedRouter,
    )
}

/** The client factory the addon runs with. */
export const tsVeSyncClientFactory: VeSyncClientFactory = createTsVeSyncClientFactory()
