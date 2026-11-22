/**
 * `setup_wizard`: the one entrypoint of the onboarding flow. From ANY state —
 * nothing installed, a hub nobody signed in to, a hub half set up — it answers
 * where the install stands and the next step to take.
 *
 * The steps are not written here. Their order, titles, pages and actions come
 * from the onboarding manifest, which is generated from the public docs: the
 * manual path a person reads and the path an assistant walks are the same
 * steps in the same order because they are the same data. This file composes
 * that data with the judgement of each step (`onboarding/evaluators.ts`).
 *
 * Read-only. A step that could not be judged is `unknown` with its reason and
 * never `missing` (D315); nothing secret is read or returned. The next step is
 * the first one that is missing, else the first one suggested, else none.
 */
import { z } from 'zod'
import { hostOf, manifestOf } from '../onboarding/context.js'
import {
  STEP_EVALUATORS,
  benchmarkLines,
  hubCapacity,
  type StepJudgement,
  type StepStatus,
} from '../onboarding/evaluators.js'
import { gatherFacts, type OnboardingFacts } from '../onboarding/facts.js'
import { hardwareReportLink, type HardwareReportLink } from '../onboarding/hardware-report.js'
import {
  isManualText,
  isToolRendering,
  type OnboardingAction,
  type OnboardingManifest,
  type OnboardingPhase,
  type OnboardingStep,
  type UiLocation,
} from '../onboarding/manifest-schema.js'
import type { ManifestSource } from '../onboarding/manifest.js'
import type { McpContext } from './context.js'

export const WIZARD_TOOL = 'setup_wizard'

export const WizardArgsShape = {
  step: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .optional()
    .describe('A step id from a previous answer: also return that step with all its actions.'),
  remoteAccess: z
    .boolean()
    .optional()
    .describe(
      'Whether CamStack will be opened away from home. Ask the person; leave it out until they answered.',
    ),
} as const

export interface WizardArgs {
  readonly step?: string
  readonly remoteAccess?: boolean
}

export interface WizardStepView {
  readonly id: string
  readonly title: string
  readonly phase: OnboardingPhase
  /** The docs page that explains the step, as a full URL. */
  readonly page: string
  readonly status: StepStatus
  readonly detail: string
  readonly reason?: string
}

export interface WizardActionView {
  readonly id: string
  readonly title: string
  /** The tool to call; absent when the action has none or this server does not serve it. */
  readonly tool?: string
  readonly args?: { readonly [key: string]: unknown }
  /** What to do with the tool's answer, or why there is no tool. */
  readonly note?: string
  /** The same action done by hand. */
  readonly manual?: {
    readonly text: string
    readonly ui?: UiLocation
    readonly command?: string
    readonly page?: string
  }
}

export interface WizardStepDetail {
  readonly id: string
  readonly title: string
  readonly page: string
  readonly summary: string
  readonly status: StepStatus
  readonly detail: string
  /** The action to start from; the others are the rest of the step, in order. */
  readonly startWith: string | null
  readonly actions: readonly WizardActionView[]
}

export type CapacityVerdict =
  | {
      readonly kind: 'measured'
      /** Cameras the hub itself carries. */
      readonly hubCapacity: number
      readonly limitedBy: 'decode' | 'detection' | null
      readonly cameras: number | null
      readonly answer: 'hub-only' | 'hub-plus-agents' | null
    }
  | {
      readonly kind: 'provisional'
      readonly answer: 'hub-only' | 'hub-plus-agents' | 'not-a-hub'
      readonly cameras: number
      readonly reasons: readonly string[]
    }

export interface WizardResult {
  readonly status: 'ok'
  readonly manifest: {
    readonly source: ManifestSource
    readonly revision: number
    readonly note: string | null
  }
  readonly state: {
    /** The phase of the next step; `complete` when nothing is left. */
    readonly phase: OnboardingPhase | 'complete'
    readonly hub: string | null
    readonly tier: string | null
    /** Which saved login this acts as ("using saved session <user>@<hub>, scope <x>"); null for a token file or no session. */
    readonly actingAs: string | null
    /** What this install carries: measured once the node benchmark ran, provisional before. */
    readonly verdict: CapacityVerdict | null
  }
  readonly steps: readonly WizardStepView[]
  readonly nextStep: WizardStepDetail | null
  /** The step asked for with `step`; absent when none was asked or the id is not a step. */
  readonly requestedStep?: WizardStepDetail
  /** Set when this hardware is not in the measured tables: the link to share its results. */
  readonly hardwareReport: HardwareReportLink | null
  readonly notices: readonly string[]
  readonly unavailable: { readonly [stepId: string]: string }
}

const UNKNOWN_STEP = (id: string): StepJudgement => ({
  status: 'unknown',
  detail: 'this step is newer than this CLI',
  reason: `the docs describe a step '${id}' this camstack CLI cannot judge yet; update it (npm i -g camstack@latest)`,
})

function judge(step: OnboardingStep, facts: OnboardingFacts): StepJudgement {
  const evaluator = STEP_EVALUATORS[step.id]
  return evaluator === undefined ? UNKNOWN_STEP(step.id) : evaluator(facts)
}

function actionView(
  action: OnboardingAction,
  docs: string,
  served: ReadonlySet<string> | null,
): WizardActionView {
  const manual = isManualText(action.manual)
    ? {
        manual: {
          text: action.manual.text,
          ...(action.manual.ui === undefined ? {} : { ui: action.manual.ui }),
          ...(action.manual.command === undefined ? {} : { command: action.manual.command }),
          ...(action.manual.page === undefined ? {} : { page: `${docs}${action.manual.page}` }),
        },
      }
    : {}
  const base = { id: action.id, title: action.title }
  if (!isToolRendering(action.agent)) return { ...base, note: action.agent.none, ...manual }
  if (served !== null && !served.has(action.agent.tool)) {
    return {
      ...base,
      note: `${action.agent.tool} is not served by this server (its toolset is switched off, or this CLI is older than the docs): the person does this by hand.`,
      ...manual,
    }
  }
  return {
    ...base,
    tool: action.agent.tool,
    ...(action.agent.args === undefined ? {} : { args: action.agent.args }),
    ...(action.agent.next === undefined ? {} : { note: action.agent.next }),
    ...manual,
  }
}

function stepDetail(
  step: OnboardingStep,
  judgement: StepJudgement,
  docs: string,
  served: ReadonlySet<string> | null,
): WizardStepDetail {
  const focus = judgement.focusAction
  return {
    id: step.id,
    title: step.title,
    page: `${docs}${step.page}`,
    summary: step.summary,
    status: judgement.status,
    detail: judgement.detail,
    startWith: step.actions.some((a) => a.id === focus) ? (focus ?? null) : null,
    actions: step.actions.map((a) => actionView(a, docs, served)),
  }
}

function verdictOf(facts: OnboardingFacts): CapacityVerdict | null {
  if (facts.session.ok) {
    const hub = facts.session.hub
    const measured = hubCapacity(hub)
    if (measured !== null && measured.capacity !== null) {
      const cameras = hub.cameras.ok ? hub.cameras.value.length : null
      return {
        kind: 'measured',
        hubCapacity: measured.capacity,
        limitedBy: measured.limitedBy,
        cameras,
        answer:
          cameras === null ? null : cameras > measured.capacity ? 'hub-plus-agents' : 'hub-only',
      }
    }
  }
  const r = facts.remembered
  return r === null
    ? null
    : {
        kind: 'provisional',
        answer: r.verdict,
        cameras: r.cameras,
        reasons: r.reasons,
      }
}

/** The share link, for a machine the feasibility check found outside the measured tables. */
function reportOf(
  ctx: McpContext,
  manifest: OnboardingManifest,
  facts: OnboardingFacts,
): HardwareReportLink | null {
  if (facts.remembered === null || facts.remembered.measured) return null
  const host = hostOf(ctx)
  const check = host.check()
  const machine = host.facts(null)
  const benchmark =
    facts.session.ok && facts.session.hub.capacity.ok
      ? benchmarkLines(facts.session.hub.capacity.value)
      : []
  return hardwareReportLink(manifest.hardwareReport, {
    check: {
      ...check,
      cpu: { ...check.cpu, model: facts.remembered.cpuModel },
    },
    ramGb: machine.ramGb,
    cores: machine.cores,
    ...(benchmark.length > 0 ? { benchmark } : {}),
  })
}

export async function setupWizard(ctx: McpContext, args: WizardArgs = {}): Promise<WizardResult> {
  const { manifest, source, note } = await manifestOf(ctx)()
  const facts = await gatherFacts(ctx, manifest, args.remoteAccess ?? null)
  const served = ctx.registeredTools === undefined ? null : await ctx.registeredTools()
  const docs = manifest.docsBaseUrl
  const judged = manifest.steps.map((step) => ({
    step,
    judgement: judge(step, facts),
  }))

  const next =
    judged.find((j) => j.judgement.status === 'missing') ??
    judged.find((j) => j.judgement.status === 'suggested') ??
    null
  const requested =
    args.step === undefined ? undefined : judged.find((j) => j.step.id === args.step)
  const unavailable: { [stepId: string]: string } = {}
  for (const { step, judgement } of judged) {
    if (judgement.status === 'unknown' && judgement.reason !== undefined) {
      unavailable[step.id] = judgement.reason
    }
  }
  const hardwareReport = reportOf(ctx, manifest, facts)
  const verdict = verdictOf(facts)
  const notices = [
    ...(note === null ? [] : [`Steps come from the copy bundled in this CLI: ${note}.`]),
    ...(args.step !== undefined && requested === undefined
      ? [
          `'${args.step}' is not a step; the step ids are: ${manifest.steps.map((s) => s.id).join(', ')}.`,
        ]
      : []),
    ...(verdict?.kind === 'provisional'
      ? [
          'The capacity verdict is an estimate from before the install. The node benchmark (detection step) measures decoding and detection on the machine and replaces it.',
        ]
      : []),
    ...(hardwareReport === null
      ? []
      : [
          `${hardwareReport.text} Offer the person this link; they read it and submit it themselves.`,
        ]),
  ]
  return {
    status: 'ok',
    manifest: { source, revision: manifest.revision, note },
    state: {
      phase: next === null ? 'complete' : next.step.phase,
      hub: facts.session.ok ? facts.session.hub.server : null,
      tier: facts.session.ok ? facts.session.hub.tier : null,
      actingAs: facts.session.ok ? (facts.session.hub.actingAs ?? null) : null,
      verdict,
    },
    steps: judged.map(
      ({ step, judgement }): WizardStepView => ({
        id: step.id,
        title: step.title,
        phase: step.phase,
        page: `${docs}${step.page}`,
        status: judgement.status,
        detail: judgement.detail,
        ...(judgement.reason === undefined ? {} : { reason: judgement.reason }),
      }),
    ),
    nextStep: next === null ? null : stepDetail(next.step, next.judgement, docs, served),
    ...(requested === undefined
      ? {}
      : {
          requestedStep: stepDetail(requested.step, requested.judgement, docs, served),
        }),
    hardwareReport,
    notices,
    unavailable,
  }
}
