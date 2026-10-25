/**
 * Usage-accounting seam (spec §6). Implemented by the UsageStore (Task 13);
 * faked in the provider suite. Every generate/generateVision call — success OR
 * failure — writes exactly one row. Token counts only (no costUsd in v1).
 */
import type { LlmErrorCode, LlmGenerateErr, LlmProfileKind, LlmUsageRollup } from '@camstack/types'

export interface UsageRowInput {
  readonly ts: number
  readonly consumer: string
  readonly profileId?: string
  readonly kind?: LlmProfileKind
  readonly model?: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly latencyMs: number
  readonly ok: boolean
  readonly errorCode?: LlmErrorCode
  readonly imageCount: number
}

export interface UsageFilter {
  readonly since?: number
  readonly until?: number
  readonly consumer?: string
  readonly profileId?: string
}

export interface UsageRecorder {
  record(row: UsageRowInput): Promise<void>
  rollup(filter: UsageFilter): Promise<LlmUsageRollup[]>
}

/** Budget enforcement is v2 — the gate ships as a pre-dispatch hook (spec §6). */
export interface BudgetGate {
  check(consumer: string): Promise<LlmGenerateErr | null>
}

export const allowAllBudgetGate: BudgetGate = { check: async () => null }
