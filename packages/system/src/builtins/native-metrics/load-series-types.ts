/** Shared shapes for the load series reader (hot ring + device-history cold tier). */

export interface RetainedProcess {
  readonly pid: number
  readonly addonId: string | null
  readonly classification: string
  readonly cpuPercent: number
  readonly memoryRssBytes: number
  readonly cpuMainPercent: number | null
  readonly cpuGcPercent: number | null
}

export interface RetainedSample {
  readonly atMs: number
  readonly processes: readonly RetainedProcess[]
}
