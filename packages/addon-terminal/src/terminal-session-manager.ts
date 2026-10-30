/**
 * Terminal session lifecycle: spawn an allowlisted pty, hold authoritative
 * screen state in a headless vt buffer, and fan live output to data-plane
 * subscribers. Output/input never traverse the event bus — a dropped chunk
 * desynchronises the vt parser permanently ([D8]); the data plane is ordered and
 * lossless. See docs/design/2026-07-26-terminal-session-design.md.
 *
 * This module depends only on the injected `PtySpawner` and `ScreenFactory`, so
 * it is fully testable without `node-pty` or `@xterm/headless`.
 */
import type {
  IScopedLogger,
  ITerminalSessionProvider,
  TerminalOutputEvent as RoutedTerminalOutputEvent,
  TerminalInstanceInfo,
  TerminalLegacyCamera,
  TerminalOutputBatch,
  TerminalProfileInfo,
  TerminalSessionInfo,
} from '@camstack/types'
import { buildProfiles, findProfile, type TerminalProfile } from './profiles.js'
import type { PtyProcess, PtySpawner } from './pty.js'
import type { TerminalStyledRow } from './terminal-cell-runs.js'
import { environmentEntriesToRecord, environmentRecordToEntries } from './terminal-instances.js'
import { settingsSchemaForProfile } from './profile-settings.js'

/** A headless vt screen holding authoritative state for reconnect repaint. */
export interface ScreenBuffer {
  write(data: string): void
  flush(): Promise<void>
  resize(cols: number, rows: number): void
  /** A self-contained escape sequence that repaints the current screen. */
  snapshot(): string
  /** Visible rows with terminal escape sequences already interpreted. */
  lines(): readonly string[]
  /** The same rows, carrying the colour and weight `lines()` discards. */
  styledLines(): readonly TerminalStyledRow[]
  dispose(): void
}

export type ScreenFactory = (cols: number, rows: number) => ScreenBuffer

export type TerminalOutputEvent =
  | { readonly kind: 'data'; readonly data: string }
  | { readonly kind: 'exit'; readonly exitCode: number; readonly signal?: number }

type UnsequencedOutputEvent =
  | { readonly kind: 'data'; readonly data: string }
  | { readonly kind: 'exit'; readonly exitCode: number; readonly signal?: number }

export type TerminalOutputSink = (event: TerminalOutputEvent) => void

export interface TerminalInstanceControl {
  listInstances(): Promise<readonly TerminalInstanceInfo[]>
  createInstance(input: {
    readonly targetNodeId: string
    readonly profileId: string
    readonly name?: string
    readonly executable?: string
    readonly args?: readonly string[]
    readonly cwd?: string
    readonly environment?: readonly string[]
    readonly profileSettings?: Readonly<Record<string, unknown>>
  }): Promise<TerminalInstanceInfo>
  updateInstance(input: {
    readonly instanceId: string
    readonly targetNodeId?: string
    readonly name?: string
    readonly executable?: string
    readonly args?: readonly string[]
    readonly cwd?: string
    readonly environment?: readonly string[]
    readonly profileSettings?: Readonly<Record<string, unknown>>
  }): Promise<TerminalInstanceInfo>
  deleteInstance(input: { readonly instanceId: string }): Promise<void>
  setInstanceEnabled(input: {
    readonly instanceId: string
    readonly enabled: boolean
  }): Promise<TerminalInstanceInfo>
  listLegacyCameras(): Promise<readonly TerminalLegacyCamera[]>
  adoptLegacyMonitor(input: {
    readonly stableId: string
    readonly name?: string
  }): Promise<TerminalInstanceInfo>
}

export interface TerminalSessionManagerOptions {
  readonly spawn: PtySpawner
  readonly screenFactory: ScreenFactory
  readonly logger: IScopedLogger
  readonly btmPath: string
  readonly btmEnabled?: boolean
  readonly btmArgs?: readonly string[]
  readonly topEnabled?: boolean
  readonly topPath?: string
  readonly topArgs?: readonly string[]
  readonly glancesEnabled?: boolean
  readonly glancesPath?: string
  readonly glancesArgs?: readonly string[]
  readonly glancesPythonPath?: string
  readonly glancesEnv?: Readonly<Record<string, string>>
  readonly allowShell: boolean
  readonly shellPath: string
  readonly customProfiles?: readonly unknown[]
  readonly maxSessions: number
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string>>
  /** ID minter — injectable so tests are deterministic. */
  readonly mintId?: () => string
  /** Clock — injectable for deterministic `startedAt`. */
  readonly now?: () => number
  /**
   * Resolve a profile's executable to an absolute path, or `null` when it is
   * not on PATH. Injectable so the composition root enforces a real
   * filesystem check while unit tests stay hermetic (default: permissive,
   * every name resolves to itself).
   */
  readonly resolveBinary?: (file: string) => string | null
}

interface LiveSession {
  readonly info: TerminalSessionInfo
  readonly pty: PtyProcess
  readonly screen: ScreenBuffer
  readonly sinks: Set<TerminalOutputSink>
  readonly output: RoutedTerminalOutputEvent[]
  readonly outputWaiters: Set<() => void>
  outputChars: number
  nextSeq: number
  exited: boolean
  disposed: boolean
  lastExit?: { exitCode: number; signal?: number }
  retireTimer?: ReturnType<typeof setTimeout>
}

const MIN_GRID = 1
const MAX_COLS = 1000
const MAX_ROWS = 500

/**
 * How long an exited session is kept addressable so a GET /out that arrives
 * AFTER the pty died still delivers the `exit` event (with its code) to the UI,
 * instead of a bare 404 that renders as a blank terminal. A process that fails
 * to start (missing binary → exit 127) is the common case this makes visible.
 */
const EXITED_RETENTION_MS = 10_000
const OUTPUT_REPLAY_CHARS = 256 * 1024

function clampDimension(value: number, max: number): number {
  if (!Number.isFinite(value)) return MIN_GRID
  const int = Math.floor(value)
  if (int < MIN_GRID) return MIN_GRID
  if (int > max) return max
  return int
}

export class TerminalSessionManager implements ITerminalSessionProvider {
  private readonly sessions = new Map<string, LiveSession>()
  private readonly opts: TerminalSessionManagerOptions
  private profiles: readonly TerminalProfile[]
  private readonly mintId: () => string
  private readonly now: () => number
  private readonly resolveBinary: (file: string) => string | null
  private maxSessions: number
  private instanceControl: TerminalInstanceControl | null = null

  constructor(opts: TerminalSessionManagerOptions) {
    this.opts = opts
    this.profiles = buildProfiles({
      btmPath: opts.btmPath,
      btmEnabled: opts.btmEnabled,
      btmArgs: opts.btmArgs,
      topEnabled: opts.topEnabled,
      topPath: opts.topPath,
      topArgs: opts.topArgs,
      glancesEnabled: opts.glancesEnabled,
      glancesPath: opts.glancesPath,
      glancesArgs: opts.glancesArgs,
      glancesPythonPath: opts.glancesPythonPath,
      glancesEnv: opts.glancesEnv,
      allowShell: opts.allowShell,
      shellPath: opts.shellPath,
      customProfiles: opts.customProfiles,
      onInvalid: (message) => opts.logger.warn(message),
    })
    this.mintId = opts.mintId ?? (() => crypto.randomUUID())
    this.now = opts.now ?? (() => Date.now())
    this.resolveBinary = opts.resolveBinary ?? ((file) => file)
    this.maxSessions = opts.maxSessions
  }

  /** Re-derive the allowlist after a settings change. */
  reconfigureProfiles(config: {
    readonly btmPath: string
    readonly btmEnabled?: boolean
    readonly btmArgs?: readonly string[]
    readonly topEnabled?: boolean
    readonly topPath?: string
    readonly topArgs?: readonly string[]
    readonly glancesEnabled?: boolean
    readonly glancesPath?: string
    readonly glancesArgs?: readonly string[]
    readonly glancesPythonPath?: string
    readonly glancesEnv?: Readonly<Record<string, string>>
    readonly allowShell: boolean
    readonly shellPath: string
    readonly maxSessions: number
    readonly customProfiles?: readonly unknown[]
  }): void {
    this.profiles = buildProfiles({
      ...config,
      onInvalid: (message) => this.opts.logger.warn(message),
    })
    this.maxSessions = config.maxSessions
  }

  async listProfiles(): Promise<readonly TerminalProfileInfo[]> {
    return this.profiles.map((p) => ({
      profileId: p.profileId,
      label: p.label,
      ...(p.description !== undefined ? { description: p.description } : {}),
      executable: p.file,
      args: [...p.args],
      cwd: p.cwd ?? '',
      environment: environmentRecordToEntries(p.env),
      settingsSchema: settingsSchemaForProfile(p.profileId),
    }))
  }

  setInstanceControl(control: TerminalInstanceControl | null): void {
    this.instanceControl = control
  }

  async listInstances(): Promise<readonly TerminalInstanceInfo[]> {
    return this.instanceControl?.listInstances() ?? []
  }

  async createInstance(input: {
    readonly targetNodeId: string
    readonly profileId: string
    readonly name?: string
    readonly executable?: string
    readonly args?: readonly string[]
    readonly cwd?: string
    readonly environment?: readonly string[]
    readonly profileSettings?: Readonly<Record<string, unknown>>
  }): Promise<TerminalInstanceInfo> {
    return this.requireInstanceControl().createInstance(input)
  }

  async updateInstance(input: {
    readonly instanceId: string
    readonly targetNodeId?: string
    readonly name?: string
    readonly executable?: string
    readonly args?: readonly string[]
    readonly cwd?: string
    readonly environment?: readonly string[]
    readonly profileSettings?: Readonly<Record<string, unknown>>
  }): Promise<TerminalInstanceInfo> {
    return this.requireInstanceControl().updateInstance(input)
  }

  async deleteInstance(input: { readonly instanceId: string }): Promise<void> {
    await this.requireInstanceControl().deleteInstance(input)
  }

  async setInstanceEnabled(input: {
    readonly instanceId: string
    readonly enabled: boolean
  }): Promise<TerminalInstanceInfo> {
    return this.requireInstanceControl().setInstanceEnabled(input)
  }

  async listLegacyCameras(): Promise<readonly TerminalLegacyCamera[]> {
    return this.instanceControl?.listLegacyCameras() ?? []
  }

  async adoptLegacyMonitor(input: {
    readonly stableId: string
    readonly name?: string
  }): Promise<TerminalInstanceInfo> {
    return this.requireInstanceControl().adoptLegacyMonitor(input)
  }

  async listSessions(): Promise<readonly TerminalSessionInfo[]> {
    return [...this.sessions.values()].filter((s) => !s.exited).map((s) => s.info)
  }

  async openSession(input: {
    readonly profileId: string
    readonly cols: number
    readonly rows: number
    readonly executable?: string
    readonly args?: readonly string[]
    readonly cwd?: string
    readonly environment?: readonly string[]
  }): Promise<TerminalSessionInfo> {
    const profile = findProfile(this.profiles, input.profileId)
    if (!profile) {
      throw new Error(`Unknown terminal profile: ${input.profileId}`)
    }
    const liveCount = [...this.sessions.values()].filter((s) => !s.exited).length
    if (liveCount >= this.maxSessions) {
      throw new Error(`Terminal session limit reached (${this.maxSessions})`)
    }
    const cols = clampDimension(input.cols, MAX_COLS)
    const rows = clampDimension(input.rows, MAX_ROWS)
    const sessionId = this.mintId()

    const file = input.executable?.trim() || profile.file
    const args = input.args !== undefined ? [...input.args] : [...profile.args]
    const cwd = input.cwd?.trim() || profile.cwd || this.opts.cwd
    const env = {
      ...this.opts.env,
      ...profile.env,
      ...environmentEntriesToRecord(input.environment ?? []),
    }

    // Fail loudly BEFORE spawning when the profile's binary is not installed —
    // otherwise node-pty spawns, the child exits 127, and the session vanishes
    // with the UI showing a blank terminal and no reason.
    const executableCandidates = [
      { file, args },
      ...(input.executable?.trim() ? [] : (profile.fallbacks ?? [])),
    ]
    const executable = executableCandidates
      .map((candidate) => ({
        ...candidate,
        resolvedFile: this.resolveBinary(candidate.file),
      }))
      .find(
        (candidate): candidate is typeof candidate & { resolvedFile: string } =>
          candidate.resolvedFile !== null,
      )
    if (executable === undefined) {
      throw new Error(
        `Terminal profile '${profile.profileId}' cannot start: executable '${file}' ` +
          `was not found on PATH. Install it in the server image or set its path in Terminal settings.`,
      )
    }

    const pty = this.opts.spawn({
      file: executable.resolvedFile,
      args: executable.args,
      cols,
      rows,
      ...(cwd !== undefined && cwd !== '' ? { cwd } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    })
    const screen = this.opts.screenFactory(cols, rows)

    const info: TerminalSessionInfo = {
      sessionId,
      profileId: profile.profileId,
      label: profile.label,
      cols,
      rows,
      startedAt: this.now(),
    }
    const session: LiveSession = {
      info,
      pty,
      screen,
      sinks: new Set(),
      output: [],
      outputWaiters: new Set(),
      outputChars: 0,
      nextSeq: 1,
      exited: false,
      disposed: false,
    }
    this.sessions.set(sessionId, session)

    pty.onData((data) => {
      if (session.exited) return
      session.screen.write(data)
      this.appendOutput(session, { kind: 'data', data })
      for (const sink of session.sinks) {
        try {
          sink({ kind: 'data', data })
        } catch {
          /* a broken sink must not take the pty or its siblings down */
        }
      }
    })
    pty.onExit((event) => {
      this.finishSession(sessionId, session, event, true)
    })

    this.opts.logger.info('terminal: session opened', {
      meta: { sessionId, profileId: profile.profileId, pid: pty.pid, cols, rows },
    })
    return info
  }

  async resize(input: {
    readonly sessionId: string
    readonly cols: number
    readonly rows: number
  }): Promise<void> {
    const session = this.sessions.get(input.sessionId)
    if (!session || session.exited) return
    const cols = clampDimension(input.cols, MAX_COLS)
    const rows = clampDimension(input.rows, MAX_ROWS)
    session.pty.resize(cols, rows)
    session.screen.resize(cols, rows)
    const next: TerminalSessionInfo = { ...session.info, cols, rows }
    this.sessions.set(input.sessionId, { ...session, info: next })
  }

  async close(input: { readonly sessionId: string }): Promise<void> {
    const session = this.sessions.get(input.sessionId)
    if (!session) return
    // A user-initiated close is terminal. Do not wait for node-pty's
    // asynchronous exit event: leaving the entry live lets output clients keep
    // polling it and makes a close look like a reconnectable session.
    this.finishSession(input.sessionId, session, { exitCode: 0 }, false)
    try {
      session.pty.kill()
    } catch {
      /* already gone */
    }
    this.opts.logger.info('terminal: session closed', { meta: { sessionId: input.sessionId } })
  }

  async pullOutput(input: {
    readonly sessionId: string
    readonly afterSeq: number
    readonly waitMs?: number
    readonly waitForOutput?: boolean
  }): Promise<TerminalOutputBatch> {
    const session = this.sessions.get(input.sessionId)
    if (!session) throw new Error(`No such terminal session: ${input.sessionId}`)

    if (
      (input.afterSeq > 0 || input.waitForOutput === true) &&
      input.afterSeq === session.nextSeq - 1 &&
      !session.exited &&
      (input.waitMs ?? 0) > 0
    ) {
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          clearTimeout(timer)
          session.outputWaiters.delete(wake)
          resolve()
        }
        const timer = setTimeout(wake, Math.min(input.waitMs ?? 0, 2_000))
        timer.unref?.()
        session.outputWaiters.add(wake)
      })
    }

    const cursor = session.nextSeq - 1
    // Explicit close tears the screen down immediately. A pull that was
    // already waiting holds this session object, so return its terminal event
    // directly instead of attempting to repaint a disposed screen.
    if (session.disposed) {
      return {
        cursor,
        reset: false,
        events: session.output.filter((event) => event.seq > input.afterSeq),
      }
    }
    const oldestSeq = session.output[0]?.seq ?? session.nextSeq
    if (input.afterSeq === 0 || input.afterSeq < oldestSeq - 1 || input.afterSeq > cursor) {
      await session.screen.flush()
      const exit = session.output.toReversed().find((event) => event.kind === 'exit')
      return {
        cursor,
        reset: true,
        snapshot: session.screen.snapshot(),
        events: exit ? [exit] : [],
      }
    }
    return {
      cursor,
      reset: false,
      events: session.output.filter((event) => event.seq > input.afterSeq),
    }
  }

  async writeInput(input: { readonly sessionId: string; readonly data: string }): Promise<void> {
    this.writeInputToSession(input.sessionId, input.data)
  }

  // ── Data-plane surface (not part of the capability) ───────────────────

  hasSession(sessionId: string): boolean {
    const s = this.sessions.get(sessionId)
    return s !== undefined && !s.exited
  }

  /**
   * True when the session is still addressable — including an EXITED one inside
   * its retention window. `handleOut` gates on this (not `hasSession`) so the
   * exit event reaches the UI; live-only paths (`writeInput`) gate on
   * `hasSession`.
   */
  hasEntry(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /**
   * Attach an output sink. Immediately pushes a full-screen repaint (the current
   * authoritative buffer) so a fresh xterm.js is in sync, then streams live
   * output. Returns a detach function.
   */
  attachOutput(sessionId: string, sink: TerminalOutputSink): () => void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`No such terminal session: ${sessionId}`)
    }
    if (session.exited) {
      sink({
        kind: 'exit',
        exitCode: session.lastExit?.exitCode ?? 0,
        ...(session.lastExit?.signal !== undefined ? { signal: session.lastExit.signal } : {}),
      })
      return () => {}
    }
    const repaint = session.screen.snapshot()
    if (repaint.length > 0) sink({ kind: 'data', data: repaint })
    session.sinks.add(sink)
    return () => {
      session.sinks.delete(sink)
    }
  }

  writeInputToSession(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.exited) return
    session.pty.write(data)
  }

  private appendOutput(session: LiveSession, event: UnsequencedOutputEvent): void {
    const sequenced = { ...event, seq: session.nextSeq } as RoutedTerminalOutputEvent
    session.nextSeq += 1
    session.output.push(sequenced)
    for (const wake of session.outputWaiters) wake()
    if (sequenced.kind === 'data') session.outputChars += sequenced.data.length
    while (session.outputChars > OUTPUT_REPLAY_CHARS && session.output.length > 1) {
      const removed = session.output.shift()
      if (removed?.kind === 'data') session.outputChars -= removed.data.length
    }
  }

  /** Kill every live session — called on addon shutdown. */
  disposeAll(): void {
    for (const [sessionId, session] of this.sessions) {
      this.finishSession(sessionId, session, { exitCode: 0 }, false)
      try {
        session.pty.kill()
      } catch {
        /* ignore */
      }
    }
  }

  private finishSession(
    sessionId: string,
    session: LiveSession,
    exit: { readonly exitCode: number; readonly signal?: number },
    retainForLateExit: boolean,
  ): void {
    if (session.exited) return
    session.exited = true
    session.lastExit = exit
    this.appendOutput(session, {
      kind: 'exit',
      exitCode: exit.exitCode,
      ...(exit.signal !== undefined ? { signal: exit.signal } : {}),
    })
    for (const sink of session.sinks) {
      try {
        sink({
          kind: 'exit',
          exitCode: exit.exitCode,
          ...(exit.signal !== undefined ? { signal: exit.signal } : {}),
        })
      } catch {
        /* ignore */
      }
    }
    session.sinks.clear()

    if (!retainForLateExit) {
      this.disposeSession(session)
      this.sessions.delete(sessionId)
      return
    }

    // Keep a naturally exited entry addressable long enough for a racing
    // output request to receive its exit status. Explicit close never takes
    // this path: it must disappear immediately and must not be reconnectable.
    const retire = setTimeout(() => {
      this.disposeSession(session)
      this.sessions.delete(sessionId)
    }, EXITED_RETENTION_MS)
    retire.unref?.()
    session.retireTimer = retire
  }

  private disposeSession(session: LiveSession): void {
    if (session.retireTimer !== undefined) clearTimeout(session.retireTimer)
    if (session.disposed) return
    session.disposed = true
    session.screen.dispose()
  }

  private requireInstanceControl(): TerminalInstanceControl {
    if (!this.instanceControl) {
      throw new Error('Terminal instances are managed on the hub')
    }
    return this.instanceControl
  }
}
