/**
 * The report lines of the two support read tools (`migrations_status`,
 * `media_storage_check`), for `report_issue`'s recipes. The lines are plain
 * text and go through the report scrubber like every other section.
 */
import type { McpContext } from './context.js'
import { mediaStorageCheck, type MediaStorageResult } from './support-media-storage.js'
import { migrationsStatus, type MigrationsStatusResult } from './support-migrations.js'

export const REPORT_TOOLS = ['migrations-status', 'media-storage'] as const
export type ReportTool = (typeof REPORT_TOOLS)[number]

export interface ToolLines {
  /** `null`: the read did not answer (see `note`). */
  readonly lines: readonly string[] | null
  readonly note: string | null
}

const gb = (bytes: number | null): string =>
  bytes === null ? 'unknown' : `${(bytes / 1e9).toFixed(1)} GB`

export function migrationLines(r: MigrationsStatusResult): string[] {
  const out: string[] = []
  if (r.counts) {
    const c = r.counts
    out.push(
      `ledger: ${String(c.applied)} applied, ${String(c.failed)} failed, ${String(c.blocked)} blocked, ${String(c.held)} held, ${String(c.running)} running, ${String(c.pending)} pending`,
    )
  }
  for (const o of r.owners ?? []) {
    if (o.failed + o.blocked + o.held + o.running + o.pending === 0) continue
    out.push(
      `owner ${o.owner}: ${String(o.applied)} applied, ${String(o.failed)} failed, ${String(o.blocked)} blocked, ${String(o.held)} held, ${String(o.pending)} pending`,
    )
  }
  for (const p of r.problems ?? []) {
    const chain =
      p.blocks.length > 0
        ? ` blocks ${p.blocks.join(', ')}${p.blocksTruncated > 0 ? ` (+${String(p.blocksTruncated)} more)` : ''}`
        : ''
    const by = p.blockedBy.length > 0 ? ` waiting on ${p.blockedBy.join(', ')}` : ''
    out.push(
      `${p.state} ${p.id} (attempts ${String(p.attempts)})${p.error ? `: ${p.error}` : ''}${p.reason ? ` [${p.reason}]` : ''}${by}${chain}`,
    )
  }
  if (r.problemsTruncated > 0) out.push(`… ${String(r.problemsTruncated)} more problems not shown`)
  if (r.refusedRunners === null) out.push('refused runners: unknown (addon list not read)')
  for (const a of r.refusedRunners ?? [])
    out.push(`runner refused: ${a.addonId}: ${a.reason ?? 'no reason reported'}`)
  if (r.refusedRunners?.length === 0) out.push('refused runners: none')
  for (const [part, why] of Object.entries(r.unavailable)) out.push(`not read (${part}): ${why}`)
  return out
}

export function mediaStorageLines(r: MediaStorageResult): string[] {
  const out: string[] = []
  if (r.census) {
    out.push(
      `media rows: ${String(r.census.totalRows)} total, ${String(r.census.unstampedRows)} without a location, ${r.census.unlistedRows === null ? 'unknown (not every location could be asked)' : String(r.census.unlistedRows)} on an unknown location`,
    )
  }
  for (const l of r.locations ?? []) {
    out.push(
      `location ${l.id} class=${l.class} mode=${l.mode}${l.nodeId ? ` node=${l.nodeId}` : ''} roots=${l.roots.length === 0 ? 'n/a' : l.roots.join(',')} volume=${l.volumeReadable ? 'readable' : 'unknown'} free=${gb(l.freeBytes)} held=${gb(l.heldBytes)} mediaRows=${l.mediaRows === null ? 'unknown' : String(l.mediaRows)}`,
    )
  }
  for (const f of r.findings) out.push(`${f.severity.toUpperCase()} ${f.code}: ${f.message}`)
  for (const c of r.sample?.cameras ?? []) {
    out.push(
      `device#${String(c.deviceId)}: ${String(c.checked)} tracks sampled, ${String(c.withThumbnail)} thumbnail, ${String(c.withKeyFrame)} keyFrame, ${String(c.missingThumbnail)} missing thumbnail, ${String(c.noMediaAtAll)} no media, ${String(c.unread)} unread`,
    )
    for (const m of c.missing) {
      out.push(
        `  no thumbnail: track ${m.trackId} ${m.className} ${m.firstSeen} kinds=${m.kinds === null ? 'unread' : JSON.stringify(m.kinds)}`,
      )
    }
  }
  if (r.sample && r.sample.nextCameraOffset !== null) {
    out.push(
      `… more cameras: ${String(r.sample.camerasTotal - r.sample.nextCameraOffset)} not sampled (cameraOffset ${String(r.sample.nextCameraOffset)})`,
    )
  }
  for (const [part, why] of Object.entries(r.unavailable)) out.push(`not read (${part}): ${why}`)
  return out
}

export async function toolLines(ctx: McpContext, tool: ReportTool): Promise<ToolLines> {
  if (tool === 'migrations-status') {
    const r = await migrationsStatus(ctx)
    if (r.status === 'ok') return { lines: migrationLines(r), note: null }
    return { lines: null, note: `not read: ${r.status === 'refused' ? r.reason : r.message}` }
  }
  const r = await mediaStorageCheck(ctx)
  if (r.status === 'ok') return { lines: mediaStorageLines(r), note: null }
  return { lines: null, note: `not read: ${r.status === 'refused' ? r.reason : r.message}` }
}
