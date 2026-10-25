// ===========================================================================
// Metrics data types — all Zod-inferred from the capability definition.
// The legacy hand-authored interface was deleted in favor of single-source-
// of-truth types on metricsProviderCapability. Import any of these from
// '@camstack/types' the same as before.
// ===========================================================================

import type { z } from 'zod'
import type {
  CpuBreakdownSchema,
  MemoryInfoSchema,
  DiskIoSnapshotSchema,
  NetworkIoSnapshotSchema,
  MetricsGpuInfoSchema,
  ProcessResourceInfoSchema,
  PressureInfoSchema,
  SystemResourceSnapshotSchema,
  DiskSpaceInfoSchema,
  PidResourceStatsSchema,
  AddonInstanceSchema,
  NodeProcessSchema,
  LoadPointSchema,
  LoadFunctionSeriesSchema,
  ContainerMemorySnapshotSchema,
  ContainerMemoryPointSchema,
  NodeLoadSeriesSchema,
  GetLoadSeriesInputSchema,
} from '../capabilities/metrics-provider.cap.js'

export type CpuBreakdown = z.infer<typeof CpuBreakdownSchema>
export type MemoryInfo = z.infer<typeof MemoryInfoSchema>
export type DiskIoSnapshot = z.infer<typeof DiskIoSnapshotSchema>
export type NetworkIoSnapshot = z.infer<typeof NetworkIoSnapshotSchema>
export type MetricsGpuInfo = z.infer<typeof MetricsGpuInfoSchema>
export type ProcessResourceInfo = z.infer<typeof ProcessResourceInfoSchema>
export type PressureInfo = z.infer<typeof PressureInfoSchema>
export type SystemResourceSnapshot = z.infer<typeof SystemResourceSnapshotSchema>
export type DiskSpaceInfo = z.infer<typeof DiskSpaceInfoSchema>
export type PidResourceStats = z.infer<typeof PidResourceStatsSchema>
export type AddonInstance = z.infer<typeof AddonInstanceSchema>
export type NodeProcess = z.infer<typeof NodeProcessSchema>
export type LoadSeriesPoint = z.infer<typeof LoadPointSchema>
export type LoadFunctionSeries = z.infer<typeof LoadFunctionSeriesSchema>
export type ContainerMemorySnapshot = z.infer<typeof ContainerMemorySnapshotSchema>
export type ContainerMemoryPoint = z.infer<typeof ContainerMemoryPointSchema>
export type NodeLoadSeries = z.infer<typeof NodeLoadSeriesSchema>
export type GetLoadSeriesInput = z.infer<typeof GetLoadSeriesInputSchema>
