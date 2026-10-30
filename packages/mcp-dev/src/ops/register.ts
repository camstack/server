/** The `ops` toolset: read-only hub tools, registered on the MCP server. */
import type { ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZodRawShapeCompat } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import { z } from 'zod'
import { text, textError } from '@camstack/develop'
import { auditTracksTool } from './track-audit.js'
import { keyframePresence, modelPinCensus, retrainCensus } from './censuses.js'
import { birthDecisions, eventDensity } from './density.js'
import { capProviders, opsStatus, recentTracks, topology, trackDetail } from './curated.js'
import type { OpsHub } from './hub.js'
import { QueryRefusedError } from './hub.js'
import { hubLogs, listLogProviders } from './logs.js'
import { lokiQuery } from './loki.js'
import { toToolOutput } from '@camstack/develop'

export type RegisterTool = <Args extends ZodRawShapeCompat>(
  name: string,
  description: string,
  schema: Args,
  cb: ToolCallback<Args>,
) => void

export type ToolResult =
  | { content: { type: 'text'; text: string }[] }
  | { content: { type: 'text'; text: string }[]; isError: true }

/** Resolve the hub lazily: a missing credential is a tool error, never a startup crash. */
export type HubProvider = () => OpsHub

/** Resolves once the hub connection (session renewal included) is usable. */
export type HubReady = () => Promise<void>

function describeError(err: unknown): string {
  if (err instanceof QueryRefusedError) return `refused: ${err.message}`
  return err instanceof Error ? err.message : String(err)
}

async function guardedRun(ready: HubReady, run: () => Promise<unknown>): Promise<ToolResult> {
  try {
    await ready()
    return text(await run())
  } catch (err) {
    return textError(describeError(err))
  }
}

export function registerOpsTools(
  tool: RegisterTool,
  getHub: HubProvider,
  ready: HubReady = async () => undefined,
): void {
  const guarded = (run: () => Promise<unknown>): Promise<ToolResult> => guardedRun(ready, run)
  tool(
    'ops_status',
    'Which hub, which credential source and tier the ops tools use (never the token)',
    {},
    () => guarded(async () => opsStatus(getHub())),
  )

  tool(
    'hub_query',
    'Call a generated tRPC QUERY method on the hub (GET). Mutations, unknown paths and secret-bearing methods are refused; admin-tier methods need an admin credential. Output is redacted and bounded.',
    { path: z.string(), input: z.record(z.string(), z.unknown()).optional() },
    ({ path, input }) => guarded(async () => toToolOutput(await getHub().query(path, input))),
  )

  tool(
    'topology',
    'Nodes, agents, versions and pids (admin credential for the full list)',
    {},
    () => guarded(() => topology(getHub())),
  )

  tool(
    'cap_providers',
    'Providers of a capability, which is active, and the registry view (does a deploy show up as re-registered?)',
    { cap: z.string() },
    ({ cap }) => guarded(() => capProviders(getHub(), cap)),
  )

  tool(
    'recent_tracks',
    'Recent tracks of one camera (slim): ids, class, state, timing',
    {
      deviceId: z.number().int(),
      hours: z.number().positive().max(72).optional(),
      limit: z.number().int().positive().max(200).optional(),
      cursor: z.string().optional(),
      className: z.string().optional(),
    },
    (args) => guarded(() => recentTracks(getHub(), args)),
  )

  tool(
    'track',
    'One track in full plus its media index (kinds, sizes, timestamps; no bytes)',
    { deviceId: z.number().int(), trackId: z.string() },
    ({ deviceId, trackId }) => guarded(() => trackDetail(getHub(), deviceId, trackId)),
  )

  tool(
    'birth_decisions',
    'Birth-decision ledger (D409): confirmed / suppressed / exhausted-fallback verdicts, per class, with birth-latency percentiles',
    {
      deviceId: z.number().int().optional(),
      hours: z.number().positive().max(168).optional(),
      verdict: z.enum(['confirmed', 'suppressed', 'exhausted-fallback']).optional(),
      limit: z.number().int().positive().max(1000).optional(),
    },
    (args) => guarded(() => birthDecisions(getHub(), args)),
  )

  tool(
    'event_density',
    'Motion / object / audio event counts per time bucket for one camera, with totals and the busiest buckets',
    {
      deviceId: z.number().int(),
      hours: z.number().positive().max(168).optional(),
      bucketMinutes: z.number().int().positive().max(1440).optional(),
    },
    (args) => guarded(() => eventDensity(getHub(), args)),
  )

  tool(
    'audit_tracks',
    'Per-track deep audit over a window (media contract, best shot, early loss, fragments, face/plate expectations). Read-only; each track costs 2-4 reads, bounded by maxTracks.',
    {
      hours: z.number().positive().max(24).optional(),
      deviceIds: z.array(z.number().int()).optional(),
      faceDevices: z.array(z.number().int()).optional(),
      plateDevices: z.array(z.number().int()).optional(),
      maxTracks: z.number().int().positive().max(500).optional(),
    },
    ({ hours, deviceIds, faceDevices, plateDevices, maxTracks }) =>
      guarded(() =>
        auditTracksTool(getHub(), {
          hours: hours ?? 4,
          maxTracks: maxTracks ?? 100,
          ...(deviceIds ? { deviceIds } : {}),
          ...(faceDevices ? { faceDevices } : {}),
          ...(plateDevices ? { plateDevices } : {}),
        }),
      ),
  )

  tool(
    'log_providers',
    'The configured log-destination providers (plus the in-RAM ring) that hub_logs can query',
    {},
    () =>
      guarded(async () => {
        const providers = await listLogProviders(getHub())
        return { sources: ['ring', ...providers.map((p) => p.addonId)], providers }
      }),
  )

  tool(
    'hub_logs',
    'Hub logs from the log source YOU choose: provider "ring" or a log-destination addonId. Without provider it lists the choices and queries nothing.',
    {
      provider: z.string().optional(),
      level: z.enum(['debug', 'info', 'warn', 'error']).optional(),
      sinceMinutes: z.number().positive().max(10_080).optional(),
      limit: z.number().int().positive().max(500).optional(),
      deviceId: z.number().int().optional(),
      addonId: z.string().optional(),
      nodeId: z.string().optional(),
    },
    (args) => guarded(() => hubLogs(getHub(), args)),
  )

  tool(
    'loki_query',
    'LogQL against the Loki the hub ships to — only when a Loki log-destination provider is configured (and unauthenticated)',
    {
      logql: z.string(),
      sinceMinutes: z.number().positive().max(10_080).optional(),
      limit: z.number().int().positive().max(1000).optional(),
    },
    (args) => guarded(() => lokiQuery(getHub(), args)),
  )

  tool(
    'model_pin_census',
    'Is any of these model ids pinned anywhere in the cluster? A failed read is an error, never "not pinned". Needs an admin login.',
    { modelIds: z.array(z.string()).min(1) },
    ({ modelIds }) => guarded(() => modelPinCensus(getHub(), modelIds)),
  )

  tool(
    'retrain_census',
    'Retrain corpus and custom-model registry census (is there anything to train on?). Needs an admin login.',
    { maxFrameReads: z.number().int().positive().max(500).optional() },
    (args) => guarded(() => retrainCensus(getHub(), args)),
  )

  tool(
    'keyframe_presence',
    'Per-camera keyFrame / thumbnail / zero-media presence over a window, sampled per camera',
    {
      hours: z.number().positive().max(48).optional(),
      minDurationSec: z.number().positive().optional(),
      maxTracksPerCamera: z.number().int().positive().max(500).optional(),
    },
    (args) => guarded(() => keyframePresence(getHub(), args)),
  )
}
