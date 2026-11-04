/**
 * Modal provider entries — one credentials + defaults row per operator
 * account. Pure helpers so the store is unit-tested without BaseAddon.
 */
import type { SecretClearInstruction } from '@camstack/types'

export const MODAL_TYPE_ID = 'modal'
export const DEFAULT_MODAL_ENTRY_NAME = 'Default'
export const MODAL_ICON_ASSET = 'assets/training-modal/icon.svg'

export interface ModalEntryRecord {
  readonly id: string
  readonly name: string
  readonly tokenId: string
  /**
   * At rest: a string (resolved) or absent. On write: may be
   * {@link SecretClearInstruction} until the keychain transform runs (D787).
   */
  readonly tokenSecret: string | SecretClearInstruction
  readonly environment: string
  readonly gpuType: string
  readonly region: string
  readonly costCapUsd: number
  readonly maxRuntimeHours: number
  readonly failedDatasetGraceHours: number
}

/** Persisted addon settings: entries plus optional legacy flat fields. */
export interface ModalEntriesConfig {
  readonly entries: readonly ModalEntryRecord[]
  readonly tokenId?: string
  readonly tokenSecret?: string
  readonly environment?: string
  readonly gpuType?: string
  readonly region?: string
  readonly costCapUsd?: number
  readonly maxRuntimeHours?: number
  readonly failedDatasetGraceHours?: number
}

const DEFAULT_GPU = 'L4'
const DEFAULT_COST = 5
const DEFAULT_HOURS = 4
const DEFAULT_GRACE = 24

/**
 * Keychain / secretStatePaths may omit an empty `tokenSecret` from a stored
 * row (writing `''` is KEEP, not "store empty"). Readers must never see
 * `undefined` and then call `.trim()`.
 */
function secretAsString(value: string | SecretClearInstruction | undefined): string {
  return typeof value === 'string' ? value : ''
}

export function normalizeModalEntry(
  entry: Partial<ModalEntryRecord> & { readonly id: string },
): ModalEntryRecord {
  return {
    id: entry.id,
    name: entry.name ?? DEFAULT_MODAL_ENTRY_NAME,
    tokenId: entry.tokenId ?? '',
    tokenSecret: secretAsString(entry.tokenSecret),
    environment: entry.environment ?? '',
    gpuType: entry.gpuType ?? DEFAULT_GPU,
    region: entry.region ?? '',
    costCapUsd: entry.costCapUsd ?? DEFAULT_COST,
    maxRuntimeHours: entry.maxRuntimeHours ?? DEFAULT_HOURS,
    failedDatasetGraceHours: entry.failedDatasetGraceHours ?? DEFAULT_GRACE,
  }
}
