/**
 * Hot-tier container memory readings — adapter over {@link NodeLoadRing}.
 */

import type { ContainerMemoryPoint, ContainerMemorySnapshot } from '@camstack/types'
import { NodeLoadRing } from './node-load-ring.js'

export const CONTAINER_MEMORY_SAMPLES_PER_NODE = 180
export const CONTAINER_MEMORY_MAX_TOTAL_ROWS: number = CONTAINER_MEMORY_SAMPLES_PER_NODE * 16

export interface ContainerMemoryRingOptions {
  readonly samplesPerNode?: number
  readonly now?: () => number
}

export class ContainerMemoryRing {
  private readonly ring: NodeLoadRing<ContainerMemorySnapshot>

  constructor(options: ContainerMemoryRingOptions = {}) {
    this.ring = new NodeLoadRing<ContainerMemorySnapshot>({
      samplesPerNode: options.samplesPerNode ?? CONTAINER_MEMORY_SAMPLES_PER_NODE,
      maxTotalProcessRows: CONTAINER_MEMORY_MAX_TOTAL_ROWS,
      ...(options.now !== undefined ? { now: options.now } : {}),
    })
  }

  record(nodeId: string, atMs: number, snapshot: ContainerMemorySnapshot): boolean {
    return this.ring.record(nodeId, atMs, [snapshot])
  }

  read(nodeId: string, sinceMs?: number): readonly ContainerMemoryPoint[] {
    const series = this.ring.read(nodeId, sinceMs)
    const out: ContainerMemoryPoint[] = []
    for (const sample of series.samples) {
      const snapshot = sample.processes[0]
      if (snapshot === undefined) continue
      out.push({ ...snapshot, atMs: sample.atMs })
    }
    return out
  }
}

export function reduceContainerMemory(
  points: readonly ContainerMemoryPoint[],
  bucketMs: number,
  origin: number,
): readonly ContainerMemoryPoint[] {
  if (bucketMs <= 0 || points.length === 0) return points
  const buckets = new Map<number, ContainerMemoryPoint>()
  for (const point of points) {
    const start = origin + Math.floor((point.atMs - origin) / bucketMs) * bucketMs
    const held = buckets.get(start)
    if (held === undefined || point.currentBytes > held.currentBytes) {
      buckets.set(start, { ...point, atMs: start })
    }
  }
  return [...buckets.values()].toSorted((a, b) => a.atMs - b.atMs)
}

export function mergeContainerMemory(
  cold: readonly ContainerMemoryPoint[],
  hot: readonly ContainerMemoryPoint[],
): readonly ContainerMemoryPoint[] {
  const byAt = new Map<number, ContainerMemoryPoint>()
  for (const point of cold) byAt.set(point.atMs, point)
  for (const point of hot) byAt.set(point.atMs, point)
  return [...byAt.values()].toSorted((a, b) => a.atMs - b.atMs)
}
