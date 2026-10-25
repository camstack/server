import type { IScopedLogger } from './logging.js'

/**
 * Progress update sent from a task handler back to the hub.
 */
export interface TaskProgress {
  readonly percent?: number
  readonly message?: string
  readonly data?: unknown
}

/**
 * Context provided to a task handler when executing a task.
 */
export interface TaskContext {
  /** ID of the agent executing this task */
  readonly taskId: string
  /** ID of the agent executing this task */
  readonly agentId: string
  /** Pre-scoped logger for the task */
  readonly logger: IScopedLogger
  /** Send progress updates back to hub */
  reportProgress(progress: TaskProgress): void
  /** Check if the task has been cancelled */
  isCancelled(): boolean
}

/**
 * Security level for a task handler. Dangerous tasks (e.g., terminal.exec)
 * require explicit admin approval per agent.
 */
export type TaskHandlerSecurity = 'safe' | 'dangerous'

/**
 * Pluggable task handler interface. Any addon can register task handlers
 * that the hub can dispatch to agents.
 */
export interface ITaskHandler {
  /** Unique task type identifier (e.g., 'pipeline.decode', 'system.info') */
  readonly taskType: string
  /** Human-readable description */
  readonly description: string
  /** Security level — dangerous tasks need explicit admin approval */
  readonly security?: TaskHandlerSecurity
  /** Execute the task and return a result */
  handle(payload: unknown, context: TaskContext): Promise<unknown>
  /** Optional cleanup when a running task is cancelled */
  cancel?(): Promise<void>
}
