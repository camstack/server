/**
 * Registration of the assisted-setup tools (planning#412) and `debug_report`.
 * Reads go on the `ops` toolset, applies on `configure` (dry run by default,
 * a one-shot `confirm_token` bound to the exact arguments applies — D836).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpContext, ToolTextResult } from './context.js'
import { clientLogs, VIEWER_LEVELS } from './client-logs.js'
import { debugReport, DEBUG_ISSUES } from './debug-report.js'
import { text } from './tool-result.js'
import { setupBenchmark } from './setup-benchmark.js'
import {
  LocationChangeSchema,
  MAX_LOCATION_CHANGES,
  SETUP_LOCATIONS_TOOL,
  setupLocations,
  setupLocationsApply,
} from './setup-locations.js'
import { SETUP_PIPELINE_TOOL, setupPipeline, setupPipelineApply } from './setup-pipeline.js'
import {
  MAX_RECORDING_CHANGES,
  RecordingChangeInputSchema,
  SETUP_RECORDING_TOOL,
  setupRecording,
  setupRecordingApply,
} from './setup-recording.js'
import {
  MAX_SLOT_CHANGES,
  SETUP_STREAMS_TOOL,
  SlotChangeSchema,
  setupStreams,
  setupStreamsApply,
} from './setup-streams.js'

const TWO_STEP =
  'Two steps: call without confirm_token for a dry-run diff and a one-shot token, then call again with the SAME arguments and that token. Needs an admin `camstack login`.'

export function registerSetupReadTools(server: McpServer, ctx: McpContext): void {
  server.tool(
    'setup_locations',
    'Read-only. Storage locations by class (mode, occupancy, drain), the volumes they sit on, and a proposal. An occupancy that could not be measured is null, never 0. Apply with configure_setup_locations.',
    {},
    async (): Promise<ToolTextResult> => text(await setupLocations(ctx)),
  )
  server.tool(
    'setup_recording',
    'Read-only. Per-camera recording config, derived mode and retention, and a proposal for cameras that record nothing. A camera whose config cannot be read has config null. Apply with configure_setup_recording.',
    {},
    async (): Promise<ToolTextResult> => text(await setupRecording(ctx)),
  )
  server.tool(
    'setup_streams',
    "Read-only. Per camera: native and derived streams, profile slots (high/low), recording profiles, with live fps / bitrate / IDR / subscribers (null when unreadable), and a proposal. Apply with configure_setup_streams (each slot change restarts that camera's detection).",
    { deviceId: z.number().int().nonnegative().optional() },
    async ({ deviceId }): Promise<ToolTextResult> =>
      text(await setupStreams(ctx, deviceId !== undefined ? { deviceId } : {})),
  )
  server.tool(
    'setup_benchmark',
    'Read-only. Node benchmark status plus accelerators, and which devices still lack a measured latency. The writer is support_benchmark_run.',
    { nodeId: z.string().min(1).optional() },
    async ({ nodeId }): Promise<ToolTextResult> =>
      text(await setupBenchmark(ctx, nodeId !== undefined ? { nodeId } : {})),
  )
  server.tool(
    'setup_pipeline',
    'Read-only. Nodes, detection placements, unassigned cameras and the auto-tune plan (with its planHash). Apply with configure_setup_pipeline.',
    {
      headroom: z.number().positive().max(1).optional(),
      minSessionsPerDevice: z.number().int().nonnegative().optional(),
    },
    async ({ headroom, minSessionsPerDevice }): Promise<ToolTextResult> =>
      text(
        await setupPipeline(ctx, {
          ...(headroom !== undefined ? { headroom } : {}),
          ...(minSessionsPerDevice !== undefined ? { minSessionsPerDevice } : {}),
        }),
      ),
  )
  server.tool(
    'client_logs',
    "Read-only. The viewer app's own log lines as the hub ingested them, oldest first: filter by since, deviceId, the viewer scope and level, and (hubs from this release tag them) user / platform / appVersion / sessionId. match says whether the lines were found by tag or, on an older hub, by the `[app:` text. A failed read is lines null with a reason, never an empty list. Needs an admin `camstack login`.",
    {
      since: z
        .string()
        .min(1)
        .optional()
        .describe('30m, 2h, 1d or an ISO time; default 30m, at most 24h'),
      deviceId: z.number().int().nonnegative().optional(),
      scope: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe('viewer scope, e.g. live, playback, scrub'),
      level: z.enum(VIEWER_LEVELS).optional().describe('viewer level floor'),
      user: z.string().min(1).max(128).optional(),
      platform: z.string().min(1).max(64).optional(),
      appVersion: z.string().min(1).max(64).optional(),
      sessionId: z.string().min(1).max(64).optional(),
      limit: z.number().int().positive().max(200).optional(),
    },
    async (args): Promise<ToolTextResult> =>
      text(
        await clientLogs(ctx, {
          ...(args.since !== undefined ? { since: args.since } : {}),
          ...(args.deviceId !== undefined ? { deviceId: args.deviceId } : {}),
          ...(args.scope !== undefined ? { scope: args.scope } : {}),
          ...(args.level !== undefined ? { level: args.level } : {}),
          ...(args.user !== undefined ? { user: args.user } : {}),
          ...(args.platform !== undefined ? { platform: args.platform } : {}),
          ...(args.appVersion !== undefined ? { appVersion: args.appVersion } : {}),
          ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
          ...(args.limit !== undefined ? { limit: args.limit } : {}),
        }),
      ),
  )
  server.tool(
    'debug_report',
    'Read-only support bundle for one problem: server and addon versions on every node; for a camera its streams (profile slots, derived streams with fps / bitrate / IDR / subscribers), churn in the window (slot changes, detection restarts, derived-encoder respawns) from logs tagged with the deviceId, recent tracks with media presence per kind (thumbnail / keyFrame) and the thumbnail URL shape the viewer requests. A read that failed is null with a reason, never 0. Secrets scrubbed. Needs an admin `camstack login`.',
    {
      deviceId: z.number().int().nonnegative().optional(),
      issue: z.enum(DEBUG_ISSUES).optional().describe('stream | detections | ui'),
      since: z
        .string()
        .min(1)
        .optional()
        .describe('30m, 2h, 1d or an ISO time; default 30m, at most 24h'),
    },
    async ({ deviceId, issue, since }): Promise<ToolTextResult> =>
      text(
        await debugReport(ctx, {
          ...(deviceId !== undefined ? { deviceId } : {}),
          ...(issue !== undefined ? { issue } : {}),
          ...(since !== undefined ? { since } : {}),
        }),
      ),
  )
}

export function registerSetupApplyTools(server: McpServer, ctx: McpContext): void {
  server.tool(
    SETUP_LOCATIONS_TOOL,
    `Change the mode of storage locations (active | readonly | drain | disabled). Refuses a change that leaves a class with no writable location. ${TWO_STEP}`,
    {
      changes: z.array(LocationChangeSchema).min(1).max(MAX_LOCATION_CHANGES),
      confirm_token: z.string().optional(),
    },
    async ({ changes, confirm_token }): Promise<ToolTextResult> =>
      text(await setupLocationsApply(ctx, { changes }, confirm_token)),
  )
  server.tool(
    SETUP_RECORDING_TOOL,
    `Set per-camera recording configs (validated against the strict recording schema). ${TWO_STEP}`,
    {
      changes: z.array(RecordingChangeInputSchema).min(1).max(MAX_RECORDING_CHANGES),
      confirm_token: z.string().optional(),
    },
    async ({ changes, confirm_token }): Promise<ToolTextResult> =>
      text(await setupRecordingApply(ctx, { changes }, confirm_token)),
  )
  server.tool(
    SETUP_STREAMS_TOOL,
    `Assign or clear a camera's high/low profile slot (camStreamId null clears). Each change restarts that camera's detection. ${TWO_STEP}`,
    {
      changes: z.array(SlotChangeSchema).min(1).max(MAX_SLOT_CHANGES),
      confirm_token: z.string().optional(),
    },
    async ({ changes, confirm_token }): Promise<ToolTextResult> =>
      text(await setupStreamsApply(ctx, { changes }, confirm_token)),
  )
  server.tool(
    SETUP_PIPELINE_TOOL,
    `Apply the auto-tune plan returned by setup_pipeline; refused when the plan changed since (planHash). ${TWO_STEP}`,
    {
      planHash: z.string().min(1),
      headroom: z.number().positive().max(1).optional(),
      minSessionsPerDevice: z.number().int().nonnegative().optional(),
      confirm_token: z.string().optional(),
    },
    async ({ planHash, headroom, minSessionsPerDevice, confirm_token }): Promise<ToolTextResult> =>
      text(
        await setupPipelineApply(
          ctx,
          {
            planHash,
            ...(headroom !== undefined ? { headroom } : {}),
            ...(minSessionsPerDevice !== undefined ? { minSessionsPerDevice } : {}),
          },
          confirm_token,
        ),
      ),
  )
}
