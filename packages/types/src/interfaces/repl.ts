export interface ReplContext {
  scope: ReplScope
  variables: Record<string, unknown>
}

export type ReplScope =
  | { type: 'system' }
  | { type: 'provider'; providerId: string }
  | { type: 'device'; deviceId: number }
  | { type: 'addon'; addonId: string }

export interface ReplResult {
  output: string
  type: 'value' | 'error' | 'void'
  duration: number
}

export interface IReplEngine {
  execute(code: string, context: ReplContext): Promise<ReplResult>
  getCompletions(partial: string, context: ReplContext): Promise<string[]>
}
