import type { ExportOptions } from '@camstack/types'

/** Defaults every export spec needs on {@link ExportOptions}. */
export const DEFAULT_EXPORT_JOB_OPTIONS: ExportOptions = {
  speed: 1,
  includeAudio: false,
  maxLifeMs: 604_800_000,
  deleteAfterDownload: false,
}

export function mergeExportJobOptions(patch: Partial<ExportOptions> = {}): ExportOptions {
  return { ...DEFAULT_EXPORT_JOB_OPTIONS, ...patch }
}
