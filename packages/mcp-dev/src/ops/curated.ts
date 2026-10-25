/** Curated read tools: each one is a fixed, named set of gated queries. */
import { toToolOutput } from './redact.js'
import type { OpsHub } from './hub.js'
import { RecentTracksPageSchema, TrackSchema, parseWire } from './wire.js'

const HOUR_MS = 3_600_000

export function opsStatus(hub: OpsHub): {
  server: string
  tier: string
  credentialSource: string
  adminReads: string
  adminHint: string | null
} {
  return {
    server: hub.server,
    tier: hub.tier,
    credentialSource: hub.source,
    adminReads:
      hub.tier === 'admin' ? 'available (admin session)' : 'refused — this credential is not admin',
    adminHint: hub.adminHint,
  }
}

/**
 * Nodes, agents, versions and pids. `nodes.topology` is admin-tier; with a
 * protected credential the answer says so and carries `system.info` instead of
 * pretending the cluster has one node.
 */
export async function topology(hub: OpsHub): Promise<unknown> {
  if (hub.tier === 'admin') return toToolOutput(await hub.query('nodes.topology'))
  const note = `nodes.topology is admin-tier and this credential is not admin, so the node list is NOT available. Log in with an admin account for it (camstack login).${hub.adminHint ? ` ${hub.adminHint}` : ''}`
  try {
    return toToolOutput({ complete: false, note, system: await hub.query('system.info') })
  } catch (err) {
    // The `camstack login` session is scoped to addons only: say what was refused, not "no nodes".
    const reason = err instanceof Error ? err.message : String(err)
    return toToolOutput({ complete: false, note, systemInfoRefused: reason })
  }
}

/**
 * Who provides a capability: the providers and the active one(s)
 * (`addons.listCapabilityProviders`, protected), plus the registry's own view of
 * the capability when the credential is admin (`capabilities.getCapability`).
 * "Deploy ≠ capabilities re-registered" is answered by the second half.
 */
export async function capProviders(hub: OpsHub, capName: string): Promise<unknown> {
  const providers = await hub.query('addons.listCapabilityProviders', { capName })
  const registry =
    hub.tier === 'admin'
      ? await hub.query('capabilities.getCapability', { name: capName })
      : { skipped: 'registry view is admin-tier' }
  return toToolOutput({ capName, providers, registry })
}

export interface RecentTracksArgs {
  readonly deviceId: number
  readonly hours?: number
  readonly limit?: number
  readonly cursor?: string
  readonly className?: string
}

/** A page of recent tracks for one camera, slim projection (no heavy trajectories). */
export async function recentTracks(
  hub: OpsHub,
  args: RecentTracksArgs,
  now: number = Date.now(),
): Promise<unknown> {
  const hours = args.hours ?? 1
  const raw = await hub.query('pipelineAnalytics.listRecentTracks', {
    deviceIds: [args.deviceId],
    since: now - hours * HOUR_MS,
    until: now,
    limit: args.limit ?? 50,
    projection: 'slim',
    ...(args.cursor ? { cursor: args.cursor } : {}),
    ...(args.className ? { classes: [args.className] } : {}),
  })
  const page = parseWire(RecentTracksPageSchema, raw, 'pipelineAnalytics.listRecentTracks')
  return toToolOutput({
    window: { hours, until: now },
    count: page.tracks.length,
    nextCursor: page.nextCursor ?? null,
    tracks: page.tracks.map((t) => ({
      trackId: t.trackId,
      className: t.className,
      state: t.state,
      active: t.active,
      source: t.source,
      firstSeen: t.firstSeen,
      lastSeen: t.lastSeen,
      durationMs: t.lastSeen - t.firstSeen,
    })),
  })
}

/** One track in full, plus its media index (kinds, sizes, timestamps — no bytes). */
export async function trackDetail(
  hub: OpsHub,
  deviceId: number,
  trackId: string,
): Promise<unknown> {
  const raw = await hub.query('pipelineAnalytics.getTrack', { deviceId, trackId })
  if (raw === null) return { found: false, deviceId, trackId }
  const track = parseWire(TrackSchema, raw, 'pipelineAnalytics.getTrack')
  const media = await hub.query('pipelineAnalytics.listTrackMedia', { trackId, deviceId })
  return toToolOutput({ track: raw, durationMs: track.lastSeen - track.firstSeen, media })
}
