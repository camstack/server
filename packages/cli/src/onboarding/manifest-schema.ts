/**
 * The onboarding manifest: the get-started flow as the public docs publish it
 * (D1077). The docs pages are the one place the flow is written; their build
 * emits this document, the CLI bundles one snapshot of it and prefers a newer
 * one read live from the docs site.
 *
 * The shape is versioned by its URL (`/onboarding/v1/`): a breaking change is a
 * new URL, never a new meaning for an existing key. Unknown keys are dropped,
 * so a newer `v1` document with additions still parses here.
 */
import { z } from 'zod'

export const ONBOARDING_SCHEMA_VERSION = 1

export const ONBOARDING_PHASES = ['before-install', 'install', 'make-it-work', 'finish'] as const
export const OnboardingPhaseSchema = z.enum(ONBOARDING_PHASES)
export type OnboardingPhase = z.infer<typeof OnboardingPhaseSchema>

const JsonArgsSchema = z.record(z.string(), z.unknown())

/** What an assistant does: one MCP tool, or the reason no tool exists. */
export const AgentRenderingSchema = z.union([
  z.object({
    tool: z.string().min(1),
    args: JsonArgsSchema.optional(),
    /** What to do with the answer, in one sentence. */
    next: z.string().min(1).optional(),
  }),
  z.object({ none: z.string().min(1) }),
])
export type AgentRendering = z.infer<typeof AgentRenderingSchema>

/** Where the admin UI holds a page: its route and the sidebar labels that lead to it. */
export const UiLocationSchema = z.object({
  route: z.string().startsWith('/'),
  nav: z.array(z.string().min(1)).min(1).max(3),
})
export type UiLocation = z.infer<typeof UiLocationSchema>

/** What a person does by hand: a page of the admin UI, a command, or the reason there is nothing. */
export const ManualRenderingSchema = z.union([
  z.object({
    text: z.string().min(1),
    ui: UiLocationSchema.optional(),
    command: z.string().min(1).optional(),
    /** A docs page with the long form of this action. */
    page: z.string().startsWith('/docs/').optional(),
  }),
  z.object({ none: z.string().min(1) }),
])
export type ManualRendering = z.infer<typeof ManualRenderingSchema>

/** One thing to do, written once with both of its renderings. */
export const OnboardingActionSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  agent: AgentRenderingSchema,
  manual: ManualRenderingSchema,
})
export type OnboardingAction = z.infer<typeof OnboardingActionSchema>

export const OnboardingStepSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  phase: OnboardingPhaseSchema,
  /** The docs page (with its anchor) that explains the step. */
  page: z.string().startsWith('/docs/'),
  summary: z.string().min(1),
  actions: z.array(OnboardingActionSchema).min(1),
})
export type OnboardingStep = z.infer<typeof OnboardingStepSchema>

export const CORE_ADDON_NEEDS = ['seeded', 'required', 'remote', 'suggested'] as const
export const CoreAddonNeedSchema = z.enum(CORE_ADDON_NEEDS)
export type CoreAddonNeed = z.infer<typeof CoreAddonNeedSchema>

/** An addon by id, with the package that ships it (several ids can share one). */
export const CoreAddonRefSchema = z.object({
  id: z.string().min(1),
  package: z.string().startsWith('@camstack/'),
})
export type CoreAddonRef = z.infer<typeof CoreAddonRefSchema>

/**
 * One function a working install needs, and the addons that provide it.
 * `seeded`: ships with the hub, only its health is judged. `required`: nothing
 * works without one. `remote`: required once the hub is used away from home.
 * `suggested`: never blocks the flow.
 */
export const CoreAddonGroupSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string().min(1),
  need: CoreAddonNeedSchema,
  why: z.string().min(1),
  /** For a `seeded` group all of them are needed, otherwise any one satisfies it. */
  addons: z.array(CoreAddonRefSchema).min(1),
  page: z.string().startsWith('/docs/'),
  /** Where the instance of the addon is created, when it needs one. */
  ui: UiLocationSchema.optional(),
})
export type CoreAddonGroup = z.infer<typeof CoreAddonGroupSchema>

const RangeSchema = z.tuple([z.number().positive(), z.number().positive()])

/** The measured sizing figures of the planning page. Nothing here is an estimate of ours. */
export const SizingSchema = z.object({
  hubBaselineRamGb: RangeSchema,
  hubBaselineCores: RangeSchema,
  perCameraRamGb: z.number().positive(),
  perCameraCores: z.number().positive(),
  /** The measured hub's typical and busy (95th percentile) cores; their ratio scales an estimate. */
  measuredHubCoresTypical: z.number().positive(),
  measuredHubCoresBusy: z.number().positive(),
  minHubRamGb: z.number().positive(),
  tightHubRamGb: z.number().positive(),
  agentRamGb: RangeSchema,
  gbPerDayPerMbit: z.number().positive(),
  /** Median main-stream bitrate in Mbit/s by `<resolution>-<codec>`; a missing key means not measured. */
  bitrateMbit: z.record(z.string(), z.number().positive()),
  /** GB a day of an events-only camera, quiet scene to busy scene. */
  eventsOnlyGbPerDay: RangeSchema,
  /** The hardware classes the figures were measured on; anything else is unmeasured. */
  measuredOn: z.array(z.string().min(1)).min(1),
  page: z.string().startsWith('/docs/'),
})
export type Sizing = z.infer<typeof SizingSchema>

/** Where a host outside the measured tables is reported. */
export const HardwareReportSchema = z.object({
  issuesUrl: z.string().url(),
  template: z.string().min(1).optional(),
  labels: z.array(z.string().min(1)).default([]),
  text: z.string().min(1),
  page: z.string().startsWith('/docs/'),
})
export type HardwareReport = z.infer<typeof HardwareReportSchema>

export const OnboardingManifestSchema = z.object({
  schema: z.literal(ONBOARDING_SCHEMA_VERSION),
  /** Bumped by the docs on every change of the flow; the higher one wins. */
  revision: z.number().int().positive(),
  /** Digest of everything but `revision` and itself: what the docs guard compares. */
  contentHash: z.string().min(8),
  /** The oldest CLI that knows every step id of this revision. */
  minCli: z.string().min(1).optional(),
  docsBaseUrl: z.string().url(),
  steps: z.array(OnboardingStepSchema).min(1),
  coreAddons: z.array(CoreAddonGroupSchema).min(1),
  sizing: SizingSchema,
  hardwareReport: HardwareReportSchema,
})
export type OnboardingManifest = z.infer<typeof OnboardingManifestSchema>

export function isToolRendering(
  agent: AgentRendering,
): agent is Extract<AgentRendering, { tool: string }> {
  return 'tool' in agent
}

export function isManualText(
  manual: ManualRendering,
): manual is Extract<ManualRendering, { text: string }> {
  return 'text' in manual
}
