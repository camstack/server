import { createServer, type Server, type ServerResponse } from 'node:http'
import type {
  IScopedLogger,
  TerminalOutputBatch,
  TerminalProfileInfo,
  TerminalSessionInfo,
} from '@camstack/types'
import {
  renderTerminalJpeg,
  TERMINAL_CAMERA_COLS,
  TERMINAL_CAMERA_FPS,
  TERMINAL_CAMERA_ROWS,
} from './terminal-frame-renderer.js'
import type { ScreenBuffer } from './terminal-session-manager.js'
import { createXtermScreen } from './xterm-screen.js'

const MJPEG_BOUNDARY = 'camstack-terminal-frame'
const SESSION_IDLE_MS = 30_000
const SNAPSHOT_STARTUP_WAIT_MS = 1_500
const SNAPSHOT_SETTLE_QUIET_MS = 300
const SNAPSHOT_SETTLE_BUDGET_MS = 3_000
const SNAPSHOT_SETTLE_MAX_PULLS = 20
const CLOSE_RETRY_BASE_MS = 50
const CLOSE_RETRY_MAX_MS = 1_000
const CLOSE_ATTEMPTS_PER_PASS = 3

interface RelayState {
  readonly instanceId: string
  readonly nodeId: string
  readonly profileId: string
  screen: ScreenBuffer
  sessionId: string | null
  cursor: number
  clients: number
  leases: number
  jpeg: Buffer | null
  renderedCursor: number
  framePromise: Promise<Buffer> | null
  openPromise: Promise<TerminalSessionInfo> | null
  idleTimer: ReturnType<typeof setTimeout> | null
  closing: boolean
  closePromise: Promise<void> | null
  closeRetryTimer: ReturnType<typeof setTimeout> | null
  closeAttempts: number
  closed: boolean
  responses: Set<ServerResponse>
}

export interface TerminalCameraApi {
  listProfiles(nodeId: string): Promise<readonly TerminalProfileInfo[]>
  openSession(
    nodeId: string,
    input: {
      readonly profileId: string
      readonly cols: number
      readonly rows: number
      readonly instanceId?: string
    },
  ): Promise<TerminalSessionInfo>
  pullOutput(
    nodeId: string,
    input: {
      readonly sessionId: string
      readonly afterSeq: number
      readonly waitMs?: number
      readonly waitForOutput?: boolean
    },
  ): Promise<TerminalOutputBatch>
  closeSession(nodeId: string, sessionId: string): Promise<void>
}

function relayKey(instanceId: string): string {
  return instanceId
}

function parseStreamPath(
  url: string | undefined,
): { instanceId: string; nodeId: string; profileId: string } | null {
  const path = (url ?? '').split('?')[0] ?? ''
  const parts = path.split('/').filter(Boolean)
  if (parts.length !== 4 || parts[0] !== 'stream') return null
  try {
    const instanceId = decodeURIComponent(parts[1] ?? '')
    const nodeId = decodeURIComponent(parts[2] ?? '')
    const profilePart = parts[3] ?? ''
    if (!profilePart.endsWith('.mjpeg')) return null
    const profileId = decodeURIComponent(profilePart.slice(0, -'.mjpeg'.length))
    return instanceId && nodeId && profileId ? { instanceId, nodeId, profileId } : null
  } catch {
    return null
  }
}

export class TerminalCameraRelay {
  private readonly states = new Map<string, RelayState>()
  private readonly responses = new Set<ServerResponse>()
  private server: Server | null = null
  private baseUrl = ''

  constructor(
    private readonly api: TerminalCameraApi,
    private readonly logger: IScopedLogger,
  ) {}

  async start(): Promise<void> {
    if (this.server) return
    const server = createServer((req, res) => {
      const target = parseStreamPath(req.url)
      if (req.method !== 'GET' || target === null) {
        res.writeHead(404).end()
        return
      }
      void this.serve(target.instanceId, target.nodeId, target.profileId, res)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (typeof address !== 'object' || address === null) {
      server.close()
      throw new Error('terminal camera relay did not bind a TCP port')
    }
    this.server = server
    this.baseUrl = `http://127.0.0.1:${String(address.port)}`
  }

  streamUrl(instanceId: string, nodeId: string, profileId: string): string {
    if (!this.baseUrl) throw new Error('terminal camera relay is not started')
    return `${this.baseUrl}/stream/${encodeURIComponent(instanceId)}/${encodeURIComponent(
      nodeId,
    )}/${encodeURIComponent(profileId)}.mjpeg`
  }

  async listProfiles(nodeId: string) {
    return this.api.listProfiles(nodeId)
  }

  private state(instanceId: string, nodeId: string, profileId: string): RelayState {
    const key = relayKey(instanceId)
    const existing = this.states.get(key)
    if (existing) return existing
    const created: RelayState = {
      instanceId,
      nodeId,
      profileId,
      screen: createXtermScreen(TERMINAL_CAMERA_COLS, TERMINAL_CAMERA_ROWS),
      sessionId: null,
      cursor: 0,
      clients: 0,
      leases: 0,
      jpeg: null,
      renderedCursor: -1,
      framePromise: null,
      openPromise: null,
      idleTimer: null,
      closing: false,
      closePromise: null,
      closeRetryTimer: null,
      closeAttempts: 0,
      closed: false,
      responses: new Set(),
    }
    this.states.set(key, created)
    return created
  }

  private async ensureSession(state: RelayState): Promise<string> {
    if (state.closed || state.closing) {
      throw new Error('terminal camera relay is waiting for prior session cleanup')
    }
    if (state.sessionId) return state.sessionId
    if (state.openPromise) {
      const opened = await state.openPromise
      if (state.closed || state.closing) {
        throw new Error('terminal camera relay state closed while opening its session')
      }
      return opened.sessionId
    }
    const opening = this.api.openSession(state.nodeId, {
      profileId: state.profileId,
      cols: TERMINAL_CAMERA_COLS,
      rows: TERMINAL_CAMERA_ROWS,
      instanceId: state.instanceId,
    })
    state.openPromise = opening
    try {
      const opened = await opening
      state.openPromise = null
      if (state.closed || state.closing) {
        // closeState deliberately retained this state while the open RPC was
        // pending. Bind the just-opened id so its normal retrying cleanup owns
        // it; never leave a late resolution as an untracked PTY.
        state.sessionId = opened.sessionId
        await this.closeState(state)
        throw new Error('terminal camera relay state closed while opening its session')
      }
      state.sessionId = opened.sessionId
      state.cursor = 0
      return opened.sessionId
    } catch (error) {
      // A close may have claimed this state while the remote open was in
      // flight. If that open rejects, there is no PTY to retry-close; finalize
      // the held cleanup state so a later enable/open can create normally.
      if (state.closing && !state.sessionId) this.finishClose(state)
      throw error
    } finally {
      if (state.openPromise === opening) state.openPromise = null
    }
  }

  /** Replay one output batch into the relay screen; true = the session exited. */
  private applyBatch(state: RelayState, batch: TerminalOutputBatch): boolean {
    if (batch.reset) {
      state.screen.dispose()
      state.screen = createXtermScreen(TERMINAL_CAMERA_COLS, TERMINAL_CAMERA_ROWS)
      if (batch.snapshot) state.screen.write(batch.snapshot)
    }
    let exited = false
    for (const event of batch.events) {
      if (event.kind === 'data') {
        state.screen.write(event.data)
      } else {
        state.sessionId = null
        exited = true
      }
    }
    state.cursor = exited ? 0 : batch.cursor
    return exited
  }

  private async nextFrame(
    state: RelayState,
    forceRender = false,
    waitForInitialOutput = false,
  ): Promise<Buffer> {
    if (state.framePromise) {
      await state.framePromise
      return forceRender
        ? this.nextFrame(state, true, waitForInitialOutput)
        : (state.jpeg ?? this.nextFrame(state, false, waitForInitialOutput))
    }
    const render = async (): Promise<Buffer> => {
      const openingSession = state.sessionId === null
      const initialPull = openingSession && waitForInitialOutput
      const sessionId = await this.ensureSession(state)
      let batch
      try {
        batch = await this.api.pullOutput(state.nodeId, {
          sessionId,
          afterSeq: state.cursor,
          ...(initialPull ? { waitMs: SNAPSHOT_STARTUP_WAIT_MS, waitForOutput: true } : {}),
        })
      } catch (error) {
        if (state.sessionId === sessionId) {
          let closed = false
          await this.api
            .closeSession(state.nodeId, sessionId)
            .then(() => {
              closed = true
            })
            .catch((closeError: unknown) => {
              this.logger.warn('terminal camera session cleanup after output failure failed', {
                meta: {
                  nodeId: state.nodeId,
                  sessionId,
                  error: closeError instanceof Error ? closeError.message : String(closeError),
                },
              })
            })
          // Retain a session whose close request failed so closeState can retry
          // it during this snapshot's finally path instead of orphaning it.
          if (closed) state.sessionId = null
        }
        state.cursor = 0
        throw error
      }
      let exited = this.applyBatch(state, batch)
      // The startup pull wakes on the FIRST output event — usually the
      // program's clear-screen, long before it has painted a full screen.
      // Rendering that instant produces an empty frame that the snapshot
      // wrapper then caches, so keep draining until the output goes quiet for
      // a beat (or the budget runs out) before rendering.
      if (initialPull && !exited) {
        const deadline = Date.now() + SNAPSHOT_SETTLE_BUDGET_MS
        for (
          let pulls = 0;
          pulls < SNAPSHOT_SETTLE_MAX_PULLS && Date.now() < deadline;
          pulls += 1
        ) {
          let settle
          try {
            settle = await this.api.pullOutput(state.nodeId, {
              sessionId,
              afterSeq: state.cursor,
              waitMs: SNAPSHOT_SETTLE_QUIET_MS,
              waitForOutput: true,
            })
          } catch {
            // Render what already accumulated; the caller's close path still
            // owns the session teardown.
            break
          }
          const active = settle.reset || settle.events.some((event) => event.kind === 'data')
          exited = this.applyBatch(state, settle)
          if (exited || !active) break
        }
      }
      await state.screen.flush()
      if (forceRender || state.jpeg === null || state.renderedCursor !== state.cursor) {
        state.jpeg = await renderTerminalJpeg(state.screen.styledLines())
        state.renderedCursor = state.cursor
      }
      return state.jpeg
    }
    state.framePromise = render().finally(() => {
      state.framePromise = null
    })
    return state.framePromise
  }

  private async serve(
    instanceId: string,
    nodeId: string,
    profileId: string,
    res: ServerResponse,
  ): Promise<void> {
    this.responses.add(res)
    const state = this.state(instanceId, nodeId, profileId)
    if (state.idleTimer) clearTimeout(state.idleTimer)
    state.idleTimer = null
    state.clients += 1
    state.responses.add(res)
    try {
      const first = await this.nextFrame(state, false, true)
      res.writeHead(200, {
        'content-type': `multipart/x-mixed-replace; boundary=${MJPEG_BOUNDARY}`,
        'cache-control': 'no-store',
        connection: 'keep-alive',
      })
      let closed = false
      res.on('close', () => {
        closed = true
      })
      let frame = first
      while (!closed) {
        res.write(
          `--${MJPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${String(frame.byteLength)}\r\n\r\n`,
        )
        res.write(frame)
        res.write('\r\n')
        await new Promise<void>((resolve) => setTimeout(resolve, 1000 / TERMINAL_CAMERA_FPS))
        if (!closed) frame = await this.nextFrame(state)
      }
    } catch (error) {
      this.logger.warn('terminal camera stream failed', {
        meta: {
          nodeId,
          profileId,
          error: error instanceof Error ? error.message : String(error),
        },
      })
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('terminal camera unavailable')
    } finally {
      this.responses.delete(res)
      state.responses.delete(res)
      state.clients = Math.max(0, state.clients - 1)
      if (state.clients === 0 && state.leases === 0) this.scheduleIdleClose(state)
    }
  }

  private scheduleIdleClose(state: RelayState): void {
    if (state.closed || state.closing || state.clients > 0 || state.leases > 0) return
    if (state.idleTimer) clearTimeout(state.idleTimer)
    state.idleTimer = setTimeout(() => {
      void this.closeState(state)
    }, SESSION_IDLE_MS)
    state.idleTimer.unref?.()
  }

  private async closeState(state: RelayState): Promise<void> {
    if (state.closed) return
    if (state.clients > 0 || state.leases > 0) return
    if (state.closePromise) {
      await state.closePromise
      return
    }
    if (state.openPromise && !state.sessionId) {
      // Keep the state indexed until the pending open resolves. ensureSession
      // will bind its id and route it through the same retrying close path.
      state.closing = true
      if (state.idleTimer) clearTimeout(state.idleTimer)
      state.idleTimer = null
      return
    }
    // A retry is already scheduled after a bounded failed pass. Keeping the
    // state closed prevents any consumer from opening a replacement session.
    if (state.closing && !state.sessionId) return
    state.closing = true
    if (state.idleTimer) clearTimeout(state.idleTimer)
    state.idleTimer = null
    state.closePromise = this.closeWithRetries(state).finally(() => {
      state.closePromise = null
    })
    await state.closePromise
  }

  private async closeWithRetries(state: RelayState): Promise<void> {
    const sessionId = state.sessionId
    if (!sessionId) {
      this.finishClose(state)
      return
    }
    for (let attempt = 0; attempt < CLOSE_ATTEMPTS_PER_PASS; attempt += 1) {
      try {
        await this.api.closeSession(state.nodeId, sessionId)
        if (state.sessionId === sessionId) this.finishClose(state)
        return
      } catch (error) {
        state.closeAttempts += 1
        this.logger.warn('terminal camera session close failed', {
          meta: {
            nodeId: state.nodeId,
            sessionId,
            attempt: state.closeAttempts,
            error: error instanceof Error ? error.message : String(error),
          },
        })
        if (attempt + 1 < CLOSE_ATTEMPTS_PER_PASS) {
          await new Promise<void>((resolve) =>
            setTimeout(resolve, this.closeRetryDelay(state.closeAttempts)),
          )
        }
      }
    }
    this.scheduleCloseRetry(state)
  }

  private scheduleCloseRetry(state: RelayState): void {
    if (state.closeRetryTimer || !state.sessionId) return
    state.closeRetryTimer = setTimeout(() => {
      state.closeRetryTimer = null
      state.closing = false
      void this.closeState(state)
    }, this.closeRetryDelay(state.closeAttempts))
    state.closeRetryTimer.unref?.()
  }

  private closeRetryDelay(attempt: number): number {
    return Math.min(CLOSE_RETRY_BASE_MS * 2 ** Math.min(attempt - 1, 5), CLOSE_RETRY_MAX_MS)
  }

  private finishClose(state: RelayState): void {
    if (state.closed) return
    state.closed = true
    if (state.closeRetryTimer) clearTimeout(state.closeRetryTimer)
    state.closeRetryTimer = null
    state.sessionId = null
    state.closeAttempts = 0
    state.closing = false
    if (this.states.get(relayKey(state.instanceId)) === state) {
      this.states.delete(relayKey(state.instanceId))
    }
    state.screen.dispose()
  }

  /**
   * Capture one fresh JPEG using the same xterm renderer as the MJPEG relay.
   * A snapshot-only caller owns a short lease and tears the state down as soon
   * as the image is rendered, so snapshots never leave a monitor PTY running.
   */
  async snapshot(instanceId: string, nodeId: string, profileId: string): Promise<Buffer> {
    const state = this.state(instanceId, nodeId, profileId)
    if (state.idleTimer) clearTimeout(state.idleTimer)
    state.idleTimer = null
    state.leases += 1
    try {
      return await this.nextFrame(state, true, true)
    } finally {
      state.leases = Math.max(0, state.leases - 1)
      if (state.clients === 0 && state.leases === 0) {
        await this.closeState(state)
      }
    }
  }

  /** Stop a withdrawn/offline camera's relay, including active HTTP readers. */
  async closeInstance(instanceId: string): Promise<void> {
    const state = this.states.get(relayKey(instanceId))
    if (!state) return
    for (const response of state.responses) response.destroy()
    state.responses.clear()
    state.clients = 0
    state.leases = 0
    await this.closeState(state)
    if (state.openPromise) {
      await state.openPromise.catch(() => {})
      await this.closeState(state)
    }
  }

  async dispose(): Promise<void> {
    for (const response of this.responses) response.destroy()
    this.responses.clear()
    for (const state of [...this.states.values()]) {
      if (state.idleTimer) clearTimeout(state.idleTimer)
      state.clients = 0
      state.leases = 0
      await this.closeState(state)
      if (state.openPromise) {
        await state.openPromise.catch(() => {})
        await this.closeState(state)
      }
    }
    if (this.server) {
      const server = this.server
      this.server = null
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    this.baseUrl = ''
  }
}
