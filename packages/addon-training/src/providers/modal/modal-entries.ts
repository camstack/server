/**
 * Modal provider entries — one credentials + defaults row per operator
 * account. Pure helpers so the store is unit-tested without BaseAddon.
 *
 * A pre-multi-entry config (flat tokenId/tokenSecret on the addon) migrates
 * to a single entry named {@link DEFAULT_MODAL_ENTRY_NAME}.
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

export type EntryMutationResult =
  | { readonly ok: true; readonly config: ModalEntriesConfig; readonly entryId: string }
  | { readonly ok: false; readonly reason: 'unknown-type' | 'unknown-entry' }

const DEFAULT_GPU = 'L4'
const DEFAULT_COST = 5
const DEFAULT_HOURS = 4
const DEFAULT_GRACE = 24

function legacyConfigured(config: ModalEntriesConfig): boolean {
  return (config.tokenId ?? '').trim() !== '' || (config.tokenSecret ?? '').trim() !== ''
}

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

/** Entries the operator sees — synthesises Default from legacy flat fields. */
export function effectiveModalEntries(config: ModalEntriesConfig): readonly ModalEntryRecord[] {
  if (config.entries.length > 0) return config.entries.map((e) => normalizeModalEntry(e))
  if (!legacyConfigured(config)) return []
  return [
    normalizeModalEntry({
      id: 'legacy-default',
      name: DEFAULT_MODAL_ENTRY_NAME,
      tokenId: config.tokenId,
      tokenSecret: config.tokenSecret,
      environment: config.environment,
      gpuType: config.gpuType,
      region: config.region,
      costCapUsd: config.costCapUsd,
      maxRuntimeHours: config.maxRuntimeHours,
      failedDatasetGraceHours: config.failedDatasetGraceHours,
    }),
  ]
}

export function findModalEntry(
  config: ModalEntriesConfig,
  entryId: string,
): ModalEntryRecord | null {
  return effectiveModalEntries(config).find((e) => e.id === entryId) ?? null
}

/** Persist a Default entry from legacy flat fields; clear the flat secrets. */
export function migrateLegacyModalConfig(
  config: ModalEntriesConfig,
  newId: () => string,
): ModalEntriesConfig {
  if (config.entries.length > 0) return config
  if (!legacyConfigured(config)) return config
  const entry: ModalEntryRecord = {
    id: newId(),
    name: DEFAULT_MODAL_ENTRY_NAME,
    tokenId: config.tokenId ?? '',
    tokenSecret: config.tokenSecret ?? '',
    environment: config.environment ?? '',
    gpuType: config.gpuType ?? DEFAULT_GPU,
    region: config.region ?? '',
    costCapUsd: config.costCapUsd ?? DEFAULT_COST,
    maxRuntimeHours: config.maxRuntimeHours ?? DEFAULT_HOURS,
    failedDatasetGraceHours: config.failedDatasetGraceHours ?? DEFAULT_GRACE,
  }
  return {
    entries: [entry],
    tokenId: '',
    tokenSecret: '',
    environment: '',
    gpuType: entry.gpuType,
    region: entry.region,
    costCapUsd: entry.costCapUsd,
    maxRuntimeHours: entry.maxRuntimeHours,
    failedDatasetGraceHours: entry.failedDatasetGraceHours,
  }
}

export function createModalEntry(
  config: ModalEntriesConfig,
  input: { readonly typeId: string; readonly name: string },
  newId: () => string,
): EntryMutationResult {
  if (input.typeId !== MODAL_TYPE_ID) return { ok: false, reason: 'unknown-type' }
  const base = migrateLegacyModalConfig(config, newId)
  const entry: ModalEntryRecord = {
    id: newId(),
    name: input.name.trim() === '' ? DEFAULT_MODAL_ENTRY_NAME : input.name.trim(),
    tokenId: '',
    tokenSecret: '',
    environment: '',
    gpuType: base.gpuType ?? DEFAULT_GPU,
    region: base.region ?? '',
    costCapUsd: base.costCapUsd ?? DEFAULT_COST,
    maxRuntimeHours: base.maxRuntimeHours ?? DEFAULT_HOURS,
    failedDatasetGraceHours: base.failedDatasetGraceHours ?? DEFAULT_GRACE,
  }
  return {
    ok: true,
    entryId: entry.id,
    config: { ...base, entries: [...base.entries, entry], tokenId: '', tokenSecret: '' },
  }
}

export function deleteModalEntry(config: ModalEntriesConfig, entryId: string): EntryMutationResult {
  const current = effectiveModalEntries(config)
  if (!current.some((e) => e.id === entryId)) return { ok: false, reason: 'unknown-entry' }
  const entries = current.filter((e) => e.id !== entryId)
  return {
    ok: true,
    entryId,
    config: {
      entries,
      tokenId: '',
      tokenSecret: '',
      environment: config.environment ?? '',
      gpuType: config.gpuType ?? DEFAULT_GPU,
      region: config.region ?? '',
      costCapUsd: config.costCapUsd ?? DEFAULT_COST,
      maxRuntimeHours: config.maxRuntimeHours ?? DEFAULT_HOURS,
      failedDatasetGraceHours: config.failedDatasetGraceHours ?? DEFAULT_GRACE,
    },
  }
}

/** Patch one entry. Empty/`undefined` `tokenSecret` means KEEP; clear is handled by the addon write. */
export interface ModalEntryPatch {
  readonly name?: string
  readonly tokenId?: string
  /** `undefined` or `''` → keep existing secret. Non-empty → replace. */
  readonly tokenSecret?: string
  /** When true, the addon write must put `SECRET_CLEAR` on this entry's secret. */
  readonly clearTokenSecret?: boolean
  readonly environment?: string
  readonly gpuType?: string
  readonly region?: string
  readonly costCapUsd?: number
  readonly maxRuntimeHours?: number
  readonly failedDatasetGraceHours?: number
}

export function updateModalEntry(
  config: ModalEntriesConfig,
  entryId: string,
  patch: ModalEntryPatch,
): EntryMutationResult {
  const current = [...effectiveModalEntries(config)]
  const index = current.findIndex((e) => e.id === entryId)
  if (index < 0) return { ok: false, reason: 'unknown-entry' }
  const prev = current[index]!
  const secret =
    patch.tokenSecret !== undefined && patch.tokenSecret !== ''
      ? patch.tokenSecret
      : prev.tokenSecret
  const next: ModalEntryRecord = {
    id: prev.id,
    name: patch.name !== undefined ? patch.name : prev.name,
    tokenId: patch.tokenId !== undefined ? patch.tokenId : prev.tokenId,
    tokenSecret: secret,
    environment: patch.environment !== undefined ? patch.environment : prev.environment,
    gpuType: patch.gpuType !== undefined ? patch.gpuType : prev.gpuType,
    region: patch.region !== undefined ? patch.region : prev.region,
    costCapUsd: patch.costCapUsd !== undefined ? patch.costCapUsd : prev.costCapUsd,
    maxRuntimeHours:
      patch.maxRuntimeHours !== undefined ? patch.maxRuntimeHours : prev.maxRuntimeHours,
    failedDatasetGraceHours:
      patch.failedDatasetGraceHours !== undefined
        ? patch.failedDatasetGraceHours
        : prev.failedDatasetGraceHours,
  }
  current[index] = next
  return {
    ok: true,
    entryId,
    config: {
      entries: current,
      tokenId: '',
      tokenSecret: '',
      environment: config.environment ?? '',
      gpuType: config.gpuType ?? DEFAULT_GPU,
      region: config.region ?? '',
      costCapUsd: config.costCapUsd ?? DEFAULT_COST,
      maxRuntimeHours: config.maxRuntimeHours ?? DEFAULT_HOURS,
      failedDatasetGraceHours: config.failedDatasetGraceHours ?? DEFAULT_GRACE,
    },
  }
}

/**
 * Mint a stable id for every persisted entry that lacks one. Operator-typed
 * empty ids (legacy settings UI) must never stay empty — createEntry always
 * generates; this heals rows that bypassed it.
 */
export function ensureModalEntryIds(
  config: ModalEntriesConfig,
  newId: () => string,
): ModalEntriesConfig {
  let changed = false
  const entries = config.entries.map((entry) => {
    if (entry.id.trim() !== '') return entry
    changed = true
    return { ...entry, id: newId() }
  })
  return changed ? { ...config, entries } : config
}
