/**
 * `setup_feasibility`: before anything is installed, can THIS machine be the
 * hub for the cameras the operator has in mind? It composes the host check
 * with the sizing figures the docs publish, answers one verdict — hub only,
 * hub plus agents, not a hub — and remembers it so `setup_wizard` can tell the
 * step is done. Read-only apart from that one local file; no hub, no login.
 *
 * The verdict is PROVISIONAL by construction: the node benchmark replaces it
 * with a measured one after install. Hardware outside the measured tables also
 * gets the link to share its results.
 */
import { z } from 'zod'
import {
  CODECS,
  MAIN_STREAMS,
  RECORDING_MODES,
  assessFeasibility,
  type FeasibilityReport,
} from '../host-check/sizing.js'
import { hostOf, manifestOf, stateOf } from '../onboarding/context.js'
import { hardwareReportLink, type HardwareReportLink } from '../onboarding/hardware-report.js'
import type { ManifestSource } from '../onboarding/manifest.js'
import type { McpContext } from './context.js'

export const FEASIBILITY_TOOL = 'setup_feasibility'

export const FeasibilityArgsShape = {
  cameras: z.number().int().min(1).max(200).describe('How many cameras the install will hold.'),
  mainStream: z.enum(MAIN_STREAMS).describe('The resolution class of the main streams.'),
  codec: z.enum(CODECS),
  recording: z
    .enum(RECORDING_MODES)
    .describe('continuous: every camera all day; events: only around detections.'),
  retentionDays: z.number().int().min(1).max(3650).describe('Days of footage to keep.'),
  bitrateMbit: z
    .number()
    .positive()
    .max(100)
    .optional()
    .describe('The main-stream bitrate the cameras send, if known; sizes the disk exactly.'),
  recordingsPath: z
    .string()
    .min(1)
    .optional()
    .describe('A directory on the volume recordings will go to, to read its free space.'),
} as const
const FeasibilityArgsSchema = z.object(FeasibilityArgsShape)
export type FeasibilityArgs = z.infer<typeof FeasibilityArgsSchema>

export interface FeasibilityResult {
  readonly status: 'ok'
  readonly report: FeasibilityReport
  readonly imageTag: string | null
  /** Present when this hardware is not in the measured tables. */
  readonly hardwareReport: HardwareReportLink | null
  readonly manifest: { readonly source: ManifestSource; readonly revision: number }
  /** `false`: the verdict could not be saved locally, so setup_wizard will ask again. */
  readonly remembered: boolean
  readonly next: string
}

const NEXT: Readonly<Record<FeasibilityReport['verdict'], string>> = {
  'hub-only': 'Install the hub on this machine: call setup_install_guide.',
  'hub-plus-agents':
    'Install the hub on this machine with setup_install_guide, then add an agent with setup_add_node. Run the node benchmark after install: it measures what this machine really carries and may lift this verdict.',
  'not-a-hub':
    'Do not install the hub here. Run this check on a machine with more memory, or use this one as an agent of a hub installed elsewhere.',
}

export async function setupFeasibility(
  ctx: McpContext,
  args: FeasibilityArgs,
): Promise<FeasibilityResult> {
  const { manifest, source } = await manifestOf(ctx)()
  const host = hostOf(ctx)
  const check = host.check()
  const facts = host.facts(args.recordingsPath ?? null)
  const { recordingsPath: _path, ...request } = args
  const report = assessFeasibility(request, facts, check, manifest.sizing)
  const remembered = stateOf(ctx).write({
    ...stateOf(ctx).read(),
    feasibility: {
      atMs: Date.now(),
      verdict: report.verdict,
      cameras: request.cameras,
      hardwareClass: report.hardware.hardwareClass,
      measured: report.hardware.measured,
      cpuModel: report.hardware.cpuModel,
      accelerators: [...report.hardware.accelerators],
      reasons: [...report.reasons],
    },
  })
  return {
    status: 'ok',
    report,
    imageTag: check.imageTag,
    hardwareReport: report.hardware.measured
      ? null
      : hardwareReportLink(manifest.hardwareReport, {
          check: { ...check, cpu: { ...check.cpu, model: report.hardware.cpuModel } },
          ramGb: facts.ramGb,
          cores: facts.cores,
        }),
    manifest: { source, revision: manifest.revision },
    remembered,
    next: NEXT[report.verdict],
  }
}
