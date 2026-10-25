/**
 * API-shared types — types that originated in @camstack/system, @camstack/system,
 * or server internals and are now canonical here so the generated API type file
 * has zero external dependencies beyond @camstack/types.
 */

import type { ProviderStatus } from './device-provider.js'
import type { ElementStatus } from './lifecycle.js'
import type { CameraPhase } from './stream-broker.js'
import type { PipelinePhaseMode } from '../device/device-profile.js'
import type { AddonPageDeclaration } from './addon.js'

// ---------------------------------------------------------------------------
// From @camstack/system — backup
// ---------------------------------------------------------------------------

export interface BackupManifest {
  readonly id: string
  readonly timestamp: number
  readonly label?: string
  readonly locations: readonly string[]
  readonly sizeMB: number
  readonly path: string
}

// ---------------------------------------------------------------------------
// From @camstack/system — provider
// ---------------------------------------------------------------------------

export interface ProviderListItem {
  id: string
  type: string
  name: string
  status: ProviderStatus
  started: boolean
  lifecycle: ElementStatus
}

// ---------------------------------------------------------------------------
// From @camstack/system — addon installer
// ---------------------------------------------------------------------------

export interface InstalledPackage {
  readonly name: string
  readonly version: string
  readonly dir: string
  readonly installSource?: 'npm' | 'local' | 'upload' | 'bundled'
}

export interface PackageVersionInfo {
  readonly version: string
  readonly publishedAt: string
  readonly deprecated?: string
  readonly distTags: readonly string[]
}

export type AutoUpdateChannel = 'off' | 'latest' | 'beta' | 'inherit'

// ---------------------------------------------------------------------------
// From server — addon pages
// ---------------------------------------------------------------------------

/** A page declaration enriched with its source addon ID */
export interface AddonPageInfo {
  readonly addonId: string
  readonly page: AddonPageDeclaration
  readonly bundleUrl: string
}

// Benchmark types (BenchmarkPhase / BenchmarkProgress / BenchmarkResult /
// HistoryEntry) moved to `@camstack/addon-benchmark` (2026-04-14). The core
// types package no longer carries benchmark-specific shapes — the canonical
// schemas live next to the addon's customActions catalog.

// ---------------------------------------------------------------------------
// From server — pipeline executor
// ---------------------------------------------------------------------------

export interface PipelineProgressEvent {
  readonly step: 'downloading' | 'loading-engine' | 'inferring' | 'complete'
  readonly addonId: string
  readonly modelId: string
  readonly ms?: number
  readonly message?: string
}

// ---------------------------------------------------------------------------
// From server — orchestrator
// ---------------------------------------------------------------------------

export interface OrchestratorMetrics {
  readonly activeCameras: number
  readonly throttledCameras: number
  readonly avgInferenceTimeMs: number
  readonly queueDepth: number
}

export interface CameraMetrics {
  readonly detectionMode: PipelinePhaseMode
  readonly configuredFps: number
  readonly actualFps: number
  readonly queueDepth: number
  readonly avgInferenceTimeMs: number
  readonly droppedFrames: number
  readonly phase: CameraPhase
}

// ---------------------------------------------------------------------------
// From server — update
// ---------------------------------------------------------------------------

export interface PackageUpdate {
  readonly name: string
  readonly currentVersion: string
  readonly latestVersion: string
  readonly category: 'addon' | 'core'
  readonly requiresRestart: boolean
}

export interface UpdateResult {
  readonly success: boolean
  readonly version: string
  readonly requiresRestart: boolean
  readonly error?: string
}

// ---------------------------------------------------------------------------
// From server — benchmark router
// ---------------------------------------------------------------------------

export interface DetectorDetails {
  id: string
  name: string
  models: Array<{ id: string; name: string; inputSize?: { width: number; height: number } }>
  runtimes: Array<{ value: string; label: string }>
  backends: Array<{ value: string; label: string }>
  defaultConfig: Record<string, unknown> | null
}
