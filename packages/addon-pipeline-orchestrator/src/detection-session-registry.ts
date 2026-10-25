import type { MotionTriggeredBy } from '@camstack/types'

/**
 * Ephemeral registry of ACTIVE detection sessions (session-time dispatch,
 * Phase 3). A session exists only while detection is actually attached on a
 * node — created on a motion event, torn down after cooldown. Never persisted;
 * rebuildable from runner truth. Distinct from the standing `assignments` map
 * (which, post-cutover, holds only `always-on` standing cameras).
 */
export interface DetectionSession {
  readonly deviceId: number
  readonly nodeId: string
  /**
   * Inference device pool this session was dispatched onto (Phase 4
   * multi-device), e.g. `openvino:npu`, `edgetpu:usb:1`. Absent ⇒ the node's
   * single default accelerator. Used by the per-node device balancer to spread
   * concurrent sessions across accelerators by active-session count.
   */
  readonly deviceKey?: string
  readonly startedAt: number
  /** What opened this session (D672). Fixed at open; a refire never changes it. */
  readonly triggeredBy: MotionTriggeredBy
  teardownTimer: ReturnType<typeof setTimeout> | null
}

/** A session opened or closed — the in-process edge the blind monitor counts motion from (D907). */
export interface DetectionSessionEdge {
  readonly edge: 'open' | 'close'
  readonly deviceId: number
  readonly at: number
}

export class DetectionSessionRegistry {
  private readonly sessions = new Map<number, DetectionSession>()

  /**
   * @param onChange called after every register / deregister / clear with the
   *   running set — feeds the placement statistics (D748). Never on a no-op.
   */
  constructor(
    private readonly onChange: (sessions: readonly DetectionSession[]) => void = () => {},
    /** Called on a session OPENING (not a re-register of a live one) and on every close. */
    private readonly onEdge: (edge: DetectionSessionEdge) => void = () => {},
  ) {}

  register(
    deviceId: number,
    nodeId: string,
    startedAt: number,
    triggeredBy: MotionTriggeredBy,
    deviceKey?: string,
  ): DetectionSession {
    const existing = this.sessions.get(deviceId)
    if (existing?.teardownTimer) clearTimeout(existing.teardownTimer)
    const session: DetectionSession = {
      deviceId,
      nodeId,
      startedAt,
      // First trigger wins: a re-register of a live session keeps what opened it.
      triggeredBy: existing?.triggeredBy ?? triggeredBy,
      teardownTimer: null,
      ...(deviceKey ? { deviceKey } : {}),
    }
    this.sessions.set(deviceId, session)
    if (existing === undefined) this.onEdge({ edge: 'open', deviceId, at: startedAt })
    this.onChange(this.list())
    return session
  }

  get(deviceId: number): DetectionSession | undefined {
    return this.sessions.get(deviceId)
  }

  has(deviceId: number): boolean {
    return this.sessions.has(deviceId)
  }

  deregister(deviceId: number): DetectionSession | undefined {
    const session = this.sessions.get(deviceId)
    if (!session) return undefined
    if (session.teardownTimer) clearTimeout(session.teardownTimer)
    this.sessions.delete(deviceId)
    this.onEdge({ edge: 'close', deviceId, at: Date.now() })
    this.onChange(this.list())
    return session
  }

  setTeardownTimer(deviceId: number, timer: ReturnType<typeof setTimeout>): void {
    const session = this.sessions.get(deviceId)
    if (!session) {
      clearTimeout(timer)
      return
    }
    if (session.teardownTimer) clearTimeout(session.teardownTimer)
    session.teardownTimer = timer
  }

  clearTeardownTimer(deviceId: number): void {
    const session = this.sessions.get(deviceId)
    if (!session?.teardownTimer) return
    clearTimeout(session.teardownTimer)
    session.teardownTimer = null
  }

  list(): readonly DetectionSession[] {
    return [...this.sessions.values()]
  }

  clear(): void {
    for (const session of this.sessions.values()) {
      if (session.teardownTimer) clearTimeout(session.teardownTimer)
    }
    const hadSessions = this.sessions.size > 0
    const closed = [...this.sessions.keys()]
    this.sessions.clear()
    const at = Date.now()
    for (const deviceId of closed) this.onEdge({ edge: 'close', deviceId, at })
    if (hadSessions) this.onChange([])
  }
}
