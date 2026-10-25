import { randomUUID } from 'node:crypto'
import type { IScopedLogger, IEventBus } from '@camstack/types'

export type ElementState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error' | 'disabled'

export interface ElementStatus {
  state: ElementState
  error?: string
  startedAt?: number
  stoppedAt?: number
  restartCount: number
  uptime: number
}

const VALID_TRANSITIONS: Readonly<Record<ElementState, readonly ElementState[]>> = {
  stopped: ['starting', 'disabled'],
  starting: ['running', 'error', 'stopping'],
  running: ['stopping', 'error'],
  stopping: ['stopped', 'error'],
  error: ['starting', 'stopped', 'disabled'],
  disabled: ['stopped'],
}

export class LifecycleStateMachine {
  private _state: ElementState = 'stopped'
  private _error?: string
  private _startedAt?: number
  private _stoppedAt?: number
  private _restartCount = 0
  private _hasStartedOnce = false

  constructor(
    private readonly elementId: string,
    private readonly elementType: 'provider' | 'device' | 'addon' | 'process',
    private readonly eventBus: IEventBus,
    private readonly logger: IScopedLogger,
  ) {}

  get state(): ElementState {
    return this._state
  }

  getStatus(): ElementStatus {
    return {
      state: this._state,
      error: this._error,
      startedAt: this._startedAt,
      stoppedAt: this._stoppedAt,
      restartCount: this._restartCount,
      uptime: this._state === 'running' && this._startedAt ? Date.now() - this._startedAt : 0,
    }
  }

  transition(to: ElementState, error?: string): boolean {
    const from = this._state

    if (!this.isValidTransition(from, to)) {
      this.logger.warn('Invalid state transition', { meta: { from, to } })
      return false
    }

    this._state = to
    this._error = error

    if (to === 'running') {
      if (this._hasStartedOnce) {
        this._restartCount++
      }
      this._hasStartedOnce = true
      this._startedAt = Date.now()
      this._stoppedAt = undefined
    }

    if (to === 'stopped' || to === 'error' || to === 'disabled') {
      this._stoppedAt = Date.now()
    }

    this.logger.info('State transition', { meta: { from, to, error } })

    this.eventBus.emit({
      id: randomUUID(),
      timestamp: new Date(),
      source: { type: this.elementType, id: this.elementId },
      category: `${this.elementType}.state.${to}`,
      data: { from, to, error, elementId: this.elementId },
    })

    return true
  }

  incrementRestartCount(): void {
    this._restartCount++
  }

  private isValidTransition(from: ElementState, to: ElementState): boolean {
    return VALID_TRANSITIONS[from]?.includes(to) ?? false
  }
}
