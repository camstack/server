/**
 * Boot KPI parser — turn hub docker logs into the four operator numbers
 * (API serving, first/last camera keyframe, first recorder pin) plus the
 * archive-walk milestones. Pure: no SSH, no spawnHub.
 *
 * Log shapes accepted:
 *   • docker `-t` prefix: `2026-08-16T13:00:59.494Z <message>`
 *   • JSON body with `timestamp`/`time` + `message`/`msg`
 *
 * Message needles match what 1.2.125 actually prints (see
 * `docs/superpowers/plans/2026-08-16-boot-phase2.md`).
 */

export interface BootKpiTargets {
  readonly apiMs: number
  readonly firstPinMs: number
  readonly lastKeyframeMs: number
  readonly indexHydratedMs: number
}

/** Operator budgets — seconds, not minutes. */
export const BOOT_KPI_TARGETS: BootKpiTargets = {
  apiMs: 15_000,
  firstPinMs: 30_000,
  lastKeyframeMs: 90_000,
  indexHydratedMs: 120_000,
}

export interface ParseBootKpisOptions {
  /** Container StartedAt. When omitted, t0 is the `[entrypoint]` line. */
  readonly t0Iso?: string
}

export interface BootKpis {
  readonly t0Iso: string | null
  readonly apiMs: number | null
  readonly writePathMs: number | null
  readonly firstKeyframeMs: number | null
  readonly lastKeyframeMs: number | null
  readonly firstPinMs: number | null
  readonly walkDeferredMs: number | null
  readonly indexHydratedMs: number | null
}

const ISO_PREFIX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+(.*)$/
const NEEDLE = {
  entrypoint: '[entrypoint]',
  api: 'CamStack server listening',
  writePath: 'recorder addon started (continuous write path active)',
  keyframe: 'First keyframe',
  pin: 'recorder pinned broker source(s) for recording',
  walkDeferred: 'recorder: full-archive index walk deferred',
  indexHydrated: 'recorder: hydrated index from storage',
} as const

interface ParsedLine {
  readonly ms: number
  readonly iso: string
  readonly text: string
}

export function parseBootKpis(logText: string, options: ParseBootKpisOptions = {}): BootKpis {
  const lines = logText
    .split(/\r?\n/)
    .map(parseLine)
    .filter((l): l is ParsedLine => l !== null)
  const entry = lines.find((l) => l.text.includes(NEEDLE.entrypoint))
  const t0Iso = options.t0Iso ?? entry?.iso ?? lines[0]?.iso ?? null
  const t0 = t0Iso !== null ? Date.parse(t0Iso) : Number.NaN
  if (!Number.isFinite(t0)) {
    return emptyKpis(t0Iso)
  }

  const offset = (needle: string): number | null => {
    const hit = lines.find((l) => l.text.includes(needle))
    return hit === undefined ? null : hit.ms - t0
  }

  const keyframes = lines.filter((l) => l.text.includes(NEEDLE.keyframe))
  const firstKf = keyframes[0]
  const lastKf = keyframes[keyframes.length - 1]

  return {
    t0Iso,
    apiMs: offset(NEEDLE.api),
    writePathMs: offset(NEEDLE.writePath),
    firstKeyframeMs: firstKf === undefined ? null : firstKf.ms - t0,
    lastKeyframeMs: lastKf === undefined ? null : lastKf.ms - t0,
    firstPinMs: offset(NEEDLE.pin),
    walkDeferredMs: offset(NEEDLE.walkDeferred),
    indexHydratedMs: offset(NEEDLE.indexHydrated),
  }
}

function emptyKpis(t0Iso: string | null): BootKpis {
  return {
    t0Iso,
    apiMs: null,
    writePathMs: null,
    firstKeyframeMs: null,
    lastKeyframeMs: null,
    firstPinMs: null,
    walkDeferredMs: null,
    indexHydratedMs: null,
  }
}

function parseLine(raw: string): ParsedLine | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  const prefixed = ISO_PREFIX.exec(trimmed)
  if (prefixed) {
    const iso = prefixed[1]!
    const ms = Date.parse(iso)
    if (!Number.isFinite(ms)) return null
    return { ms, iso, text: prefixed[2]! }
  }
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>
      const iso = jsonIso(obj)
      const text = jsonText(obj)
      if (iso === null || text === null) return null
      const ms = Date.parse(iso)
      if (!Number.isFinite(ms)) return null
      return { ms, iso, text }
    } catch {
      return null
    }
  }
  return null
}

function jsonIso(obj: Record<string, unknown>): string | null {
  for (const key of ['timestamp', 'time', 'ts'] as const) {
    const value = obj[key]
    if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return value
  }
  return null
}

function jsonText(obj: Record<string, unknown>): string | null {
  for (const key of ['message', 'msg'] as const) {
    const value = obj[key]
    if (typeof value === 'string') return value
  }
  return null
}
