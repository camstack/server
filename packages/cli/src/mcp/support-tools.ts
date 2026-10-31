/**
 * `support` toolset: benchmarks, accelerator and camera diagnosis, and drafts
 * of the issue or pull request that follows. Reads are plain; the benchmark run
 * (it loads a node) and both drafts go through the mutation gate, two steps.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { text } from './tool-result.js'
import { z } from 'zod'
import type { McpContext, ToolTextResult } from './context.js'
import { supportDiagnoseAccelerator, ExpectedAcceleratorSchema } from './support-accelerator.js'
import {
  BENCHMARK_RUN_TOOL,
  MAX_MODELS,
  MAX_WARM_RUNS,
  supportBenchmarkRun,
  supportBenchmarkStatus,
} from './support-benchmark.js'
import { supportDiagnoseCamera } from './support-camera.js'
import { defaultSupportDeps, type SupportDeps } from './support-deps.js'
import {
  BenchmarkCellsSchema,
  DRAFT_ISSUE_TOOL,
  DRAFT_PR_TOOL,
  DraftKindSchema,
  supportDraftIssue,
  supportDraftPr,
  type DraftArgs,
} from './support-draft.js'

const ModelId = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/)

const DraftShape = {
  kind: DraftKindSchema,
  title: z.string().min(3).max(300),
  summary: z.string().min(3).max(4000),
  nodeId: z.string().max(100).optional(),
  expected: ExpectedAcceleratorSchema.optional(),
  brand: z.string().max(100).optional(),
  model: z.string().max(100).optional(),
  deviceId: z.number().int().optional(),
  packageName: z.string().max(214).optional(),
  column: z.string().max(100).optional(),
  cells: BenchmarkCellsSchema.optional(),
  confirm_token: z.string().optional(),
}

type DraftInput = {
  [K in keyof typeof DraftShape]: z.infer<(typeof DraftShape)[K]>
}

function draftArgs(input: DraftInput): DraftArgs {
  return {
    kind: input.kind,
    title: input.title,
    summary: input.summary,
    ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
    ...(input.expected !== undefined ? { expected: input.expected } : {}),
    ...(input.brand !== undefined ? { brand: input.brand } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
    ...(input.packageName !== undefined ? { packageName: input.packageName } : {}),
    ...(input.column !== undefined ? { column: input.column } : {}),
    ...(input.cells !== undefined ? { cells: input.cells } : {}),
  }
}

export function registerSupportTools(
  server: McpServer,
  ctx: McpContext,
  deps: SupportDeps = defaultSupportDeps,
): void {
  server.tool(
    'support_benchmark_status',
    "The hub's own node-benchmark state: the active or last run and the per-device latency cells it stored. Read-only. The Auto-tune latency table is filled with support_benchmark_run. Needs an admin `camstack login`.",
    { nodeId: z.string().max(100).optional() },
    async ({ nodeId }): Promise<ToolTextResult> =>
      text(await supportBenchmarkStatus(ctx, nodeId !== undefined ? { nodeId } : {})),
  )
  server.tool(
    BENCHMARK_RUN_TOOL,
    'Measure detector latency on a node x device (cold run, then warm median per model, via runPipelineTest) and return it next to the Auto-tune table cell for the same hardware, plus how to contribute it. LOADS THE NODE: the detection pool restarts between models. Pick the node and deviceKey from ops_accelerators. Two steps: call without confirm_token for the plan and a one-shot token, then again with the SAME arguments and that token. Needs an admin `camstack login`.',
    {
      nodeId: z.string().min(1).max(100),
      deviceKey: z.string().min(1).max(60),
      models: z.array(ModelId).min(1).max(MAX_MODELS).optional(),
      warmRuns: z.number().int().min(1).max(MAX_WARM_RUNS).optional(),
      confirm_token: z.string().optional(),
    },
    async ({ nodeId, deviceKey, models, warmRuns, confirm_token }): Promise<ToolTextResult> =>
      text(
        await supportBenchmarkRun(
          ctx,
          deps,
          {
            nodeId,
            deviceKey,
            ...(models !== undefined ? { models } : {}),
            ...(warmRuns !== undefined ? { warmRuns } : {}),
          },
          confirm_token,
        ),
      ),
  )
  server.tool(
    'support_diagnose_accelerator',
    "A node should have an accelerator (Intel iGPU/NPU, AMD WebGPU/VAAPI/NPU, Coral USB/PCIe, Apple Neural Engine, NVIDIA) and the hub does not offer it. Reads what the platform probe saw and what the node's inference runtime offers, and answers ok | misconfigured (with fix steps: passthrough, driver, image tag, opt-in) | unsupported (which addon would need extending) | unknown (a read failed). A Coral is never auto-picked: the answer says how to opt in. Read-only.",
    { nodeId: z.string().min(1).max(100), expected: ExpectedAcceleratorSchema },
    async ({ nodeId, expected }): Promise<ToolTextResult> =>
      text(await supportDiagnoseAccelerator(ctx, { nodeId, expected })),
  )
  server.tool(
    'support_diagnose_camera',
    'A camera brand or model, or an existing device that fails: which provider addons could serve it (installed, then published), and a verdict use-provider | generic-fallback (ONVIF / RTSP) | unsupported | unknown, with the next steps. Give a brand and/or model, or a deviceId. Read-only.',
    {
      brand: z.string().max(100).optional(),
      model: z.string().max(100).optional(),
      deviceId: z.number().int().optional(),
    },
    async ({ brand, model, deviceId }): Promise<ToolTextResult> =>
      text(
        await supportDiagnoseCamera(ctx, {
          ...(brand !== undefined ? { brand } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(deviceId !== undefined ? { deviceId } : {}),
        }),
      ),
  )
  server.tool(
    DRAFT_ISSUE_TOOL,
    "Draft a GitHub issue for the public repository that owns the addon (the package's `repository` field; camstack/server when it names none): title, an environment block (server and CLI version, node platform, accelerator or camera facts from the diagnose tools), secrets and private addresses removed. Two steps: the dry run is the full draft and the target; the confirmed call runs YOUR own `gh issue create` (only if `gh auth status` succeeds, otherwise it returns the draft and a ready command). Never uses a token of ours.",
    DraftShape,
    async (input): Promise<ToolTextResult> =>
      text(await supportDraftIssue(ctx, deps, draftArgs(input), input.confirm_token)),
  )
  server.tool(
    DRAFT_PR_TOOL,
    'Plan a pull request for the public repository that owns the addon: branch, files to change, steps and the `gh pr create` command, with a scrubbed body. For kind "benchmark" give column and cells from support_benchmark_run. Two steps like every gated tool; it pushes no code and calls no GitHub API, you run the plan with your own git and gh.',
    DraftShape,
    async (input): Promise<ToolTextResult> =>
      text(await supportDraftPr(ctx, draftArgs(input), input.confirm_token)),
  )
}
