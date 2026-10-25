/**
 * The ONE definition of "does this line match a history read" (D898).
 *
 * Used by every reader — the rotated-file reader in its worker, the Loki
 * reader after LogQL has narrowed the stream, and the hub's in-memory tail —
 * so the same query cannot mean three different things on three sources.
 *
 * It is deliberately free of value imports: the file reader runs it inside a
 * bare worker thread.
 */
import type { LogLevel, LogReadQuery } from '@camstack/types'

const LEVEL_RANK: Readonly<Record<LogLevel, number>> = { debug: 0, info: 1, warn: 2, error: 3 }

/** A structurally-typed line: a parsed file row, a ring entry or a Loki line. */
export interface ReadableLine {
  readonly timestamp: number
  readonly level: string
  readonly message: string
  readonly scope?: string | undefined
  readonly tags?: Readonly<Record<string, unknown>> | undefined
  readonly meta?: Readonly<Record<string, unknown>> | undefined
}

export function levelRank(level: string): number {
  return level === 'debug' || level === 'info' || level === 'warn' || level === 'error'
    ? LEVEL_RANK[level]
    : LEVEL_RANK.info
}

/** `provider@1.2.3` / `audio-codec::native-device-ops` → the manifest id. */
export function bareAddonOf(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let bare = raw.split('@')[0] ?? raw
  const colon = bare.indexOf('::')
  if (colon >= 0) bare = bare.slice(0, colon)
  return bare
}

/** The node a line is attributed to for the `nodeId` filter and the block index. */
export function originNodeOf(tags: Readonly<Record<string, unknown>> | undefined): string | null {
  const agentId = tags?.['agentId']
  if (typeof agentId === 'string' && agentId.length > 0) return agentId
  const nodeId = tags?.['nodeId']
  if (typeof nodeId === 'string' && nodeId.length > 0) {
    const slash = nodeId.indexOf('/')
    return slash === -1 ? nodeId : nodeId.slice(0, slash)
  }
  return null
}

function nodeMatches(tags: Readonly<Record<string, unknown>> | undefined, want: string): boolean {
  if (tags === undefined) return false
  const agentId = tags['agentId']
  const nodeId = tags['nodeId']
  if (agentId === want || nodeId === want) return true
  return typeof nodeId === 'string' && nodeId.startsWith(`${want}/`)
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

/** Case-insensitive substring over message, scope, every tag value and every meta value. */
export function lineContainsText(line: ReadableLine, needleLower: string): boolean {
  if (line.message.toLowerCase().includes(needleLower)) return true
  if (line.scope !== undefined && line.scope.toLowerCase().includes(needleLower)) return true
  for (const bag of [line.tags, line.meta]) {
    if (bag === undefined) continue
    for (const value of Object.values(bag)) {
      if (value === undefined || value === null) continue
      if (stringifyValue(value).toLowerCase().includes(needleLower)) return true
    }
  }
  return false
}

/** The filter half of a {@link LogReadQuery}, normalised once per read. */
export interface CompiledLogFilter {
  readonly deviceId: number | null
  readonly addonId: string | null
  readonly nodeId: string | null
  readonly tags: Readonly<Record<string, string | number>>
  readonly levelFloor: number
  readonly textLower: string | null
  readonly since: number | null
  readonly until: number | null
}

export function compileLogFilter(query: LogReadQuery): CompiledLogFilter {
  const text = query.text?.trim() ?? ''
  return {
    deviceId: query.deviceId ?? null,
    addonId: query.fromAddonId !== undefined ? bareAddonOf(query.fromAddonId) : null,
    nodeId: query.fromNodeId ?? null,
    tags: query.tags ?? {},
    levelFloor: query.level !== undefined ? LEVEL_RANK[query.level] : 0,
    textLower: text.length > 0 ? text.toLowerCase() : null,
    since: query.since ?? null,
    until: query.until ?? null,
  }
}

/** Exact match of one line against the whole filter. */
export function lineMatches(line: ReadableLine, filter: CompiledLogFilter): boolean {
  if (levelRank(line.level) < filter.levelFloor) return false
  if (filter.since !== null && line.timestamp < filter.since) return false
  if (filter.until !== null && line.timestamp > filter.until) return false
  const tags = line.tags
  if (filter.deviceId !== null && tags?.['deviceId'] !== filter.deviceId) return false
  if (filter.addonId !== null && bareAddonOf(tags?.['addonId']) !== filter.addonId) return false
  if (filter.nodeId !== null && !nodeMatches(tags, filter.nodeId)) return false
  for (const [key, want] of Object.entries(filter.tags)) {
    const have = tags?.[key]
    // A numeric tag compares as a number: `deviceId: 101` never matches `"101"`
    // on one source and matches on another.
    if (have !== want && !(typeof have === 'number' && String(have) === String(want))) return false
  }
  if (filter.textLower !== null && !lineContainsText(line, filter.textLower)) return false
  return true
}

/** True when the filter constrains nothing — every line matches. */
export function filterIsEmpty(filter: CompiledLogFilter): boolean {
  return (
    filter.deviceId === null &&
    filter.addonId === null &&
    filter.nodeId === null &&
    Object.keys(filter.tags).length === 0 &&
    filter.levelFloor === 0 &&
    filter.textLower === null &&
    filter.since === null &&
    filter.until === null
  )
}
