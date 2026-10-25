/**
 * Remote-assignment health loop (T7) — PURE evaluation.
 *
 * The per-camera pipeline watchdog (`pipeline-watchdog.ts`) is hub-only by
 * design: its signal taps + recovery are orchestrator-owned and hub-local, so
 * a camera dispatched to a REMOTE agent runner that accepts the attach but then
 * produces nothing is invisible to it (gap i). This module closes that gap: it
 * inspects a snapshot of the live assignments + per-camera fps telemetry
 * (`cameraFpsMap`, populated for EVERY node from `PipelineCameraMetricsSnapshot`
 * events) and returns the remote cameras that must be re-placed.
 *
 * The function is PURE — deterministic, no clock read (the caller passes `now`),
 * no I/O. The impure parts (detach + re-dispatch, bounded backoff, logging)
 * live in the orchestrator and consume the returned `RemoteHealthAction[]`.
 *
 * "Sustained" guard: rather than track a separate per-tick `lowSince` map, the
 * assignment-age grace window IS the sustained-broken guard — a remote camera
 * that is STILL at sub-`minFps` (or metrics-silent) `graceMs` after it was
 * assigned is genuinely broken, not merely cold-starting. The health sweep runs
 * on a periodic cadence and the caller's per-device backoff bounds churn, so no
 * finer continuity tracking is needed here.
 */
import type { PipelineAssignment } from '@camstack/types'

/** Per-camera fps telemetry snapshot (mirror of the orchestrator's `cameraFpsMap` value). */
export interface RemoteHealthFpsEntry {
  readonly fps: number
  readonly nodeId: string
  /** Unix ms of the last `PipelineCameraMetricsSnapshot` observed for this device. */
  readonly lastSeen: number
}

/** Tunable thresholds for the health evaluation. */
export interface RemoteHealthOpts {
  /** Cold-start protection: assignments younger than this are never flagged. */
  readonly graceMs: number
  /** Metrics silence beyond this (or no entry at all) → `stale-metrics`. */
  readonly staleMs: number
  /** Sustained fps below this on a metrics-fresh camera → `zero-fps`. */
  readonly minFps: number
}

/** All inputs the pure evaluation needs. */
export interface RemoteHealthInput {
  /** Live pipeline assignments keyed by deviceId. */
  readonly assignments: ReadonlyMap<number, PipelineAssignment>
  /** Per-camera fps telemetry keyed by deviceId. */
  readonly fpsMap: ReadonlyMap<number, RemoteHealthFpsEntry>
  /** Devices for which detection is actually expected (has an active runner config). */
  readonly activeDeviceIds: ReadonlySet<number>
  /** This node's id — assignments on it are covered by the local watchdog. */
  readonly localNodeId: string
  /** Wall-clock ms — passed in so the function stays pure. */
  readonly now: number
  readonly opts: RemoteHealthOpts
}

/** Why a remote camera is being flagged for re-placement. */
export type RemoteHealthReason = 'zero-fps' | 'stale-metrics'

/** A single re-placement instruction for one remote camera. */
export interface RemoteHealthAction {
  readonly deviceId: number
  readonly kind: 'replace'
  readonly why: RemoteHealthReason
}

/**
 * Default thresholds: 3-min grace (cold start), 2-min stale window (metrics
 * stopped entirely), 0.5 fps floor. A degraded foreign-handle camera runs
 * ~1 fps (above the bar); with T2's frame-source eligibility a remote
 * assignment is only legal on a frame-source node, so sustained sub-0.5 fps
 * means genuinely broken.
 */
export const DEFAULT_REMOTE_HEALTH_OPTS: RemoteHealthOpts = {
  graceMs: 3 * 60_000,
  staleMs: 2 * 60_000,
  minFps: 0.5,
}

/**
 * Evaluate every remote pipeline assignment and return the cameras that must be
 * re-placed. Rules (each assignment evaluated independently):
 *   1. LOCAL assignments (`agentNodeId === localNodeId`) are skipped — the hub
 *      watchdog owns them.
 *   2. Cameras not in `activeDeviceIds` are skipped — detection isn't expected.
 *   3. Assignments younger than `graceMs` are skipped — cold-start grace.
 *   4. No fps entry, or `now - lastSeen > staleMs` → `stale-metrics`.
 *   5. Otherwise `fps < minFps` → `zero-fps`.
 *   6. Otherwise healthy → no action.
 *
 * Deterministic ordering: iteration order of `assignments`.
 */
export function evaluateRemoteHealth(input: RemoteHealthInput): RemoteHealthAction[] {
  const { assignments, fpsMap, activeDeviceIds, localNodeId, now, opts } = input
  const actions: RemoteHealthAction[] = []

  for (const [deviceId, assignment] of assignments) {
    // 1. Local assignments are the local watchdog's responsibility.
    if (assignment.agentNodeId === localNodeId) continue
    // 2. Only cameras that are actually expected to be producing detections.
    if (!activeDeviceIds.has(deviceId)) continue
    // 3. Cold-start grace — give a freshly-placed remote camera time to warm up.
    if (now - assignment.assignedAt < opts.graceMs) continue

    const entry = fpsMap.get(deviceId)
    // 4. No telemetry ever arrived, or it has gone silent.
    if (!entry || now - entry.lastSeen > opts.staleMs) {
      actions.push({ deviceId, kind: 'replace', why: 'stale-metrics' })
      continue
    }
    // 5. Metrics are fresh but the camera produces (near-)nothing.
    if (entry.fps < opts.minFps) {
      actions.push({ deviceId, kind: 'replace', why: 'zero-fps' })
      continue
    }
    // 6. Healthy — no action.
  }

  return actions
}
