import type { ElementState } from './lifecycle.js'

export interface ProcessStats {
  pid: number
  cpu: number
  memory: number
  uptime: number
  restartCount: number
}

export interface ProcessConfig {
  id: string
  label: string
  command?: string
  modulePath?: string
  args?: string[]
  env?: Record<string, string>
  autoRestart: boolean
  maxRestarts?: number
  healthCheck?: {
    intervalMs: number
    timeoutMs: number
    failureThreshold: number
  }
}

export interface ManagedProcessStatus {
  id: string
  label: string
  state: ElementState
  pid?: number
  stats?: ProcessStats
  lastCrashAt?: number
  lastCrashError?: string
  restartCount: number
  nextRestartAt?: number
}

/** Minimal interface for ProcessManagerService used by addons */
export interface IProcessManager {
  register(config: ProcessConfig): unknown
  start(id: string): Promise<void>
  stop(id: string): Promise<void>
}
