export type ElementState = 'stopped' | 'starting' | 'running' | 'stopping' | 'error' | 'disabled'

export interface ElementStatus {
  state: ElementState
  error?: string
  startedAt?: number
  stoppedAt?: number
  restartCount: number
  uptime: number
}

export interface ILifecycleManaged {
  readonly id: string
  getStatus(): ElementStatus
  start(): Promise<void>
  stop(): Promise<void>
  restart(): Promise<void>
  enable(): Promise<void>
  disable(): Promise<void>
}
