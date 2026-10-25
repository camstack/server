export interface ReplScope {
  readonly type: 'system' | 'provider' | 'device' | 'addon'
  readonly providerId?: string
  readonly deviceId?: number
  readonly addonId?: string
}

export interface ReplSessionContext {
  readonly scope: ReplScope
  /** Pre-populated variables available in the REPL session */
  readonly variables: Record<string, unknown>
}

import type { ReplResult } from '@camstack/types'
export type { ReplResult }

export interface IReplEngine {
  execute(code: string, context: ReplSessionContext): Promise<ReplResult>
  getCompletions(partial: string, context: ReplSessionContext): Promise<string[]>
}

/**
 * Context provider that the server kernel implements.
 * The REPL engine calls this to build the sandbox for each scope type.
 *
 * Methods may return a Promise so the kernel can warm up async
 * resources (e.g. `SystemManager.init()`) before exposing them — the
 * engine awaits each before evaluating user code.
 */
export interface IReplContextProvider {
  getSystemSandbox(): Record<string, unknown> | Promise<Record<string, unknown>>
  getDeviceSandbox(deviceId: number): Record<string, unknown> | Promise<Record<string, unknown>>
  getProviderSandbox(providerId: string): Record<string, unknown> | Promise<Record<string, unknown>>
  getAddonSandbox(addonId: string): Record<string, unknown> | Promise<Record<string, unknown>>
}
