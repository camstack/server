/**
 * An invented node load series (`metricsProvider.getLoadSeries`): three
 * runner functions over the last hour at a 10 s cadence, with a four-minute
 * hole twenty minutes ago (the node was restarting) so the gap shading shows.
 */
import { MINUTE, NOW } from './_time'

const CADENCE_MS = 10_000
const WINDOW_MS = 60 * MINUTE
const HOLE_FROM = NOW - 24 * MINUTE
const HOLE_TO = NOW - 20 * MINUTE

const FUNCTIONS = [
  { key: 'pipeline-runner', kind: 'addon', cpu: 34, gc: 6, rssMiB: 820, procs: 3 },
  { key: 'stream-broker', kind: 'addon', cpu: 12, gc: 2, rssMiB: 410, procs: 1 },
  { key: '__root__', kind: 'root', cpu: 4, gc: 1, rssMiB: 260, procs: 1 },
] as const

const point = (f: (typeof FUNCTIONS)[number], atMs: number, i: number) => {
  const wobble = Math.sin(i / 11) * 0.35 + Math.sin(i / 3.7) * 0.12
  const main = Math.max(0, f.cpu * (1 + wobble))
  const gc = Math.max(0, f.gc * (1 + Math.sin(i / 5) * 0.5))
  const rss = (f.rssMiB + 40 * Math.sin(i / 17)) * 1024 * 1024
  return {
    atMs,
    samples: 1,
    cpuMainPercent: main,
    cpuMainPercentMin: main,
    cpuGcPercent: gc,
    cpuGcPercentMin: gc,
    cpuLifetimePercent: main + gc,
    cpuLifetimePercentMin: main + gc,
    memoryRssBytes: rss,
    memoryRssBytesMin: rss,
    processCount: f.procs,
    processCountMin: f.procs,
  }
}

export function loadSeries(nodeId: string) {
  const stamps: number[] = []
  for (let t = NOW - WINDOW_MS; t <= NOW; t += CADENCE_MS) {
    if (t >= HOLE_FROM && t < HOLE_TO) continue
    stamps.push(t)
  }
  return {
    nodeId,
    series: FUNCTIONS.map((f) => ({
      key: f.key,
      kind: f.kind,
      points: stamps.map((t, i) => point(f, t, i)),
    })),
    containerMemory: [],
    bucketMs: CADENCE_MS,
    cadenceMs: CADENCE_MS,
    retainedSamples: stamps.length,
    oldestAtMs: stamps[0] ?? null,
    durable: true,
  }
}
