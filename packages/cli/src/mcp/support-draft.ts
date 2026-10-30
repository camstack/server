/**
 * `support_draft_issue` and `support_draft_pr`: a filled template for the
 * public repository that owns the addon, built from the diagnose tools' facts
 * and scrubbed for a public place (secrets, private addresses, home paths).
 *
 * Both are gated. The dry run is the whole draft and the target repository.
 * Executing an issue runs the USER's own `gh` — `gh auth status` first, then
 * `gh issue create --repo … --title … --body-file <0600 temp file>` — and
 * nothing else: no token of ours, no GitHub API call with our credentials. When
 * `gh` is missing or not signed in, the draft and a ready command come back
 * instead. A pull request is only ever PLANNED: a branch, the files to touch
 * and the `gh pr create` command; this tool pushes no code.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  runGated,
  type DryRunOutcome,
  type GatedResult,
  type GatedToolSpec,
  type HubClient,
} from '@camstack/develop'
import { z } from 'zod'
import type { McpContext } from './context.js'
import { readQuery, reasonOf, type Read } from './ops-hub.js'
import {
  readProbe,
  supportDiagnoseAccelerator,
  type ExpectedAccelerator,
  type ProbeFact,
} from './support-accelerator.js'
import { supportDiagnoseCamera } from './support-camera.js'
import type { SupportDeps } from './support-deps.js'
import { scrubDeepForPublic, scrubForPublic } from './support-scrub.js'

export const DRAFT_ISSUE_TOOL = 'support_draft_issue'
export const DRAFT_PR_TOOL = 'support_draft_pr'

export const FALLBACK_REPO = 'camstack/server'
/** The package that owns the inference runtime, used for accelerator drafts. */
export const INFERENCE_PACKAGE = '@camstack/addon-pipeline'
const TITLE_MAX = 140
const DIAGNOSIS_MAX = 4_000

export const DRAFT_KINDS = ['accelerator', 'camera', 'benchmark', 'other'] as const
export const DraftKindSchema = z.enum(DRAFT_KINDS)
export type DraftKind = z.infer<typeof DraftKindSchema>

export const BenchmarkCellsSchema = z.record(
  z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/),
  z.object({ p50Ms: z.number().positive(), fps: z.number().positive() }),
)

export interface DraftArgs {
  readonly kind: DraftKind
  readonly title: string
  readonly summary: string
  readonly nodeId?: string
  readonly expected?: ExpectedAccelerator
  readonly brand?: string
  readonly model?: string
  readonly deviceId?: number
  readonly packageName?: string
  readonly column?: string
  readonly cells?: z.infer<typeof BenchmarkCellsSchema>
}

// ---------------------------------------------------------------------------
// the target repository

export interface RepoTarget {
  readonly repo: string
  readonly source: 'package-repository-field' | 'fallback'
  readonly packageName: string | null
  /** Why the fallback was used; null when the package named its repository. */
  readonly reason: string | null
}

const PackageNameRe = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/
const GithubRepoRe = /github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/#?].*)?$/
const ShorthandRe = /^(?:github:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/

const RegistryDocSchema = z.looseObject({
  repository: z.union([z.string(), z.looseObject({ url: z.string() })]).optional(),
})

/** `owner/name` from an npm `repository` value, or null when it is not a GitHub repository. */
export function githubRepoOf(value: string): string | null {
  const url = GithubRepoRe.exec(value)
  if (url?.[1] && url[2]) return `${url[1]}/${url[2]}`
  const short = ShorthandRe.exec(value)
  if (short?.[1] && short[2]) return `${short[1]}/${short[2]}`
  return null
}

function fallback(packageName: string | null, reason: string): RepoTarget {
  return { repo: FALLBACK_REPO, source: 'fallback', packageName, reason }
}

export async function resolveRepo(
  ctx: McpContext,
  packageName: string | undefined,
): Promise<RepoTarget> {
  if (packageName === undefined)
    return fallback(null, 'no package named; the main repository is the default')
  if (!PackageNameRe.test(packageName))
    return fallback(null, `"${packageName}" is not a valid npm package name`)
  const url = `https://registry.npmjs.org/${packageName.replace('/', '%2F')}/latest`
  let doc: unknown
  try {
    const response = await ctx.fetch(url)
    if (!response.ok)
      return fallback(
        packageName,
        `the npm registry answered ${response.status} for ${packageName}`,
      )
    doc = await response.json()
  } catch (err) {
    return fallback(packageName, `the npm registry could not be read: ${reasonOf(err)}`)
  }
  const parsed = RegistryDocSchema.safeParse(doc)
  const field = parsed.success ? parsed.data.repository : undefined
  const raw = typeof field === 'string' ? field : field?.url
  const repo = raw === undefined ? null : githubRepoOf(raw)
  if (repo === null) return fallback(packageName, `${packageName} declares no GitHub repository`)
  return {
    repo,
    source: 'package-repository-field',
    packageName,
    reason: null,
  }
}

// ---------------------------------------------------------------------------
// the facts

export interface DraftFacts {
  readonly environment: { readonly [key: string]: string }
  readonly diagnosis: unknown
  readonly packageName: string | undefined
  readonly unavailable: { readonly [part: string]: string }
}

const ServerStatusSchema = z.looseObject({ runningVersion: z.string() })

async function serverVersion(client: HubClient, nodeId: string | undefined): Promise<Read<string>> {
  const status = await readQuery(
    client,
    'serverManagement.getServerPackageStatus',
    nodeId !== undefined ? { nodeId } : {},
    ServerStatusSchema,
  )
  return status.ok ? { ok: true, value: status.value.runningVersion } : status
}

function probeLines(probe: ProbeFact): { readonly [key: string]: string } {
  return {
    'node platform': `${probe.platform}/${probe.arch}`,
    'node cpu': probe.cpuModel,
    'node gpu': probe.gpu ?? 'none reported',
    'node npu': probe.npu ?? 'none reported',
  }
}

function packageOf(args: DraftArgs, diagnosis: unknown): string | undefined {
  if (args.packageName !== undefined) return args.packageName
  if (args.kind === 'accelerator') return INFERENCE_PACKAGE
  if (typeof diagnosis === 'object' && diagnosis !== null && 'provider' in diagnosis) {
    const provider = diagnosis.provider
    if (typeof provider === 'object' && provider !== null && 'packageName' in provider) {
      const name = provider.packageName
      if (typeof name === 'string') return name
    }
  }
  return undefined
}

export async function collectFacts(ctx: McpContext, args: DraftArgs): Promise<DraftFacts> {
  const environment: { [key: string]: string } = {
    'camstack CLI': ctx.cliVersion,
  }
  const unavailable: { [part: string]: string } = {}
  let diagnosis: unknown = null
  const outcome = await ctx.hub()
  if (!outcome.ok) {
    unavailable['hub'] = outcome.message
    return {
      environment,
      diagnosis,
      packageName: packageOf(args, null),
      unavailable,
    }
  }
  const { client } = outcome.connection
  const version = await serverVersion(client, args.nodeId)
  if (version.ok) environment['camstack server'] = version.value
  else unavailable['serverVersion'] = version.reason
  if (args.nodeId !== undefined) {
    const probe = await readProbe(client, args.nodeId)
    if (probe.ok) Object.assign(environment, probeLines(probe.value))
    else unavailable['nodeProbe'] = probe.reason
  }
  if (args.kind === 'accelerator' && args.nodeId !== undefined && args.expected !== undefined) {
    diagnosis = await supportDiagnoseAccelerator(ctx, {
      nodeId: args.nodeId,
      expected: args.expected,
    })
  } else if (args.kind === 'camera') {
    diagnosis = await supportDiagnoseCamera(ctx, {
      ...(args.brand !== undefined ? { brand: args.brand } : {}),
      ...(args.model !== undefined ? { model: args.model } : {}),
      ...(args.deviceId !== undefined ? { deviceId: args.deviceId } : {}),
    })
  }
  return {
    environment,
    diagnosis,
    packageName: packageOf(args, diagnosis),
    unavailable,
  }
}

// ---------------------------------------------------------------------------
// the text

const FOOTER =
  '_Drafted with the `camstack mcp` support toolset. Secrets and private addresses are removed before this text is shown._'

function cleanTitle(raw: string): string {
  return scrubForPublic(raw).replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX)
}

function environmentBlock(facts: DraftFacts): string {
  const lines = Object.entries(facts.environment).map(([k, v]) => `- ${k}: ${scrubForPublic(v)}`)
  const missing = Object.entries(facts.unavailable).map(
    ([k, v]) => `- ${k}: not available (${scrubForPublic(v)})`,
  )
  return ['## Environment', ...lines, ...missing].join('\n')
}

function diagnosisBlock(diagnosis: unknown): string {
  if (diagnosis === null || diagnosis === undefined) return ''
  const json = JSON.stringify(scrubDeepForPublic(diagnosis), null, 2) ?? 'null'
  const shown = json.length > DIAGNOSIS_MAX ? `${json.slice(0, DIAGNOSIS_MAX)}\n… (cut)` : json
  return ['## Diagnosis', '```json', shown, '```'].join('\n')
}

function cellsBlock(args: DraftArgs): string {
  if (args.cells === undefined) return ''
  const rows = Object.entries(args.cells)
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .map(([model, cell]) => `| ${scrubForPublic(model)} | ${cell.p50Ms} | ${cell.fps} |`)
  return [
    `## Measured latency${args.column !== undefined ? ` (${scrubForPublic(args.column)})` : ''}`,
    '| model | p50 ms | fps |',
    '| --- | --- | --- |',
    ...rows,
  ].join('\n')
}

export interface Draft {
  readonly target: RepoTarget
  readonly title: string
  readonly body: string
}

export async function buildDraft(
  ctx: McpContext,
  args: DraftArgs,
  heading: string,
): Promise<Draft> {
  const facts = await collectFacts(ctx, args)
  const target = await resolveRepo(ctx, facts.packageName)
  const sections = [
    `## ${heading}`,
    scrubForPublic(args.summary),
    environmentBlock(facts),
    diagnosisBlock(facts.diagnosis),
    cellsBlock(args),
    FOOTER,
  ].filter((s) => s !== '')
  return { target, title: cleanTitle(args.title), body: sections.join('\n\n') }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function issueCommand(draft: Draft, bodyFile: string): string {
  return `gh issue create --repo ${draft.target.repo} --title ${shellQuote(draft.title)} --body-file ${bodyFile}`
}

// ---------------------------------------------------------------------------
// support_draft_issue

export const ISSUE_BODY_FILE = './camstack-issue.md'

export interface IssueDryRun {
  readonly action: string
  readonly targetRepo: string
  readonly targetSource: RepoTarget['source']
  readonly targetReason: string | null
  readonly title: string
  readonly body: string
  readonly command: string
  readonly willRun: string
}

async function issueDraft(ctx: McpContext, args: DraftArgs): Promise<Draft> {
  return buildDraft(ctx, args, 'What happens')
}

export type IssueOutcome =
  | { readonly outcome: 'created'; readonly url: string; readonly repo: string }
  | {
      readonly outcome: 'gh-unavailable' | 'gh-failed'
      readonly reason: string
      readonly repo: string
      readonly title: string
      readonly body: string
      readonly command: string
      readonly saveBodyAs: string
    }

export interface IssueSpecDeps {
  readonly ctx: McpContext
  readonly deps: SupportDeps
}

export function issueSpec({ ctx, deps }: IssueSpecDeps): GatedToolSpec<DraftArgs> {
  return {
    tool: DRAFT_ISSUE_TOOL,
    async dryRun(args): Promise<DryRunOutcome> {
      const draft = await issueDraft(ctx, args)
      const describe: IssueDryRun = {
        action: 'open a GitHub issue',
        targetRepo: draft.target.repo,
        targetSource: draft.target.source,
        targetReason: draft.target.reason,
        title: draft.title,
        body: draft.body,
        command: issueCommand(draft, ISSUE_BODY_FILE),
        willRun: `gh auth status, then gh issue create with your own gh sign-in; if gh is missing or signed out, the draft and this command are returned instead`,
      }
      return { confirmable: true, describe }
    },
    async execute(args): Promise<IssueOutcome> {
      const draft = await issueDraft(ctx, args)
      const refusal = (outcome: 'gh-unavailable' | 'gh-failed', reason: string): IssueOutcome => ({
        outcome,
        reason: scrubForPublic(reason).slice(0, 300),
        repo: draft.target.repo,
        title: draft.title,
        body: draft.body,
        command: issueCommand(draft, ISSUE_BODY_FILE),
        saveBodyAs: ISSUE_BODY_FILE,
      })
      const auth = await deps.runner('gh', ['auth', 'status'])
      if (auth.code !== 0) {
        return refusal('gh-unavailable', auth.stderr === '' ? 'gh auth status failed' : auth.stderr)
      }
      const dir = await mkdtemp(join(tmpdir(), 'camstack-support-'))
      try {
        const bodyFile = join(dir, 'issue-body.md')
        await writeFile(bodyFile, draft.body, { mode: 0o600 })
        const made = await deps.runner('gh', [
          'issue',
          'create',
          '--repo',
          draft.target.repo,
          '--title',
          draft.title,
          '--body-file',
          bodyFile,
        ])
        if (made.code !== 0) return refusal('gh-failed', made.stderr)
        const url =
          made.stdout
            .split('\n')
            .map((l) => l.trim())
            .findLast((l) => l.startsWith('https://')) ?? ''
        return { outcome: 'created', url, repo: draft.target.repo }
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    },
  }
}

// ---------------------------------------------------------------------------
// support_draft_pr

export const PR_BODY_FILE = './camstack-pr.md'

export interface PrPlan {
  readonly action: string
  readonly targetRepo: string
  readonly targetSource: RepoTarget['source']
  readonly title: string
  readonly body: string
  readonly branch: string
  readonly files: readonly string[]
  readonly steps: readonly string[]
  readonly command: string
  readonly note: string
}

const BENCHMARK_FILES: readonly string[] = [
  'docs/benchmarks/detector-latency.json',
  'packages/types/src/pipeline/auto-tune/detector-performance.ts',
]

function slug(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return s === '' ? 'change' : s
}

function prProblem(args: DraftArgs): string | null {
  if (args.kind !== 'benchmark') return null
  if (
    args.column === undefined ||
    args.cells === undefined ||
    Object.keys(args.cells).length === 0
  ) {
    return 'kind "benchmark" needs `column` ("<hardwareClass>/<accelerator>") and `cells` (modelId -> { p50Ms, fps }) from support_benchmark_run'
  }
  return null
}

function planFor(args: DraftArgs, draft: Draft): PrPlan {
  const benchmark = args.kind === 'benchmark'
  const branch = benchmark
    ? `benchmark/${slug(args.column ?? 'column')}`
    : `support/${slug(args.title)}`
  const files = benchmark
    ? BENCHMARK_FILES
    : [
        `the source of ${draft.target.source === 'package-repository-field' ? (draft.target.packageName ?? 'the addon') : 'the addon'}`,
      ]
  const steps = [
    `gh repo fork ${draft.target.repo} --clone, then cd into the clone.`,
    `git switch -c ${branch}`,
    ...(benchmark
      ? [
          `Merge the measured cells into docs/benchmarks/detector-latency.json under "${args.column ?? ''}" (set "measured": true on the column when every kept cell was measured on the box) and mirror the same cells into DETECTOR_PERF in packages/types/src/pipeline/auto-tune/detector-performance.ts.`,
          'npx vitest run packages/types/src/pipeline/auto-tune/__tests__/detector-performance.spec.ts (it fails until the two files agree).',
        ]
      : ['Make the change with a spec that fails first, then passes.']),
    `git commit -am ${shellQuote(benchmark ? `docs: measured detector latency for ${args.column ?? ''}` : `fix: ${draft.title}`)}`,
    `git push -u origin ${branch}`,
    `Save the body below as ${PR_BODY_FILE}, then run the command.`,
  ]
  return {
    action: 'plan a pull request (nothing is pushed by this tool)',
    targetRepo: draft.target.repo,
    targetSource: draft.target.source,
    title: draft.title,
    body: draft.body,
    branch,
    files,
    steps,
    command: `gh pr create --repo ${draft.target.repo} --head <your-github-user>:${branch} --title ${shellQuote(draft.title)} --body-file ${PR_BODY_FILE}`,
    note: 'This tool pushes no code and calls no GitHub API; you run these steps with your own git and gh.',
  }
}

export function prSpec(ctx: McpContext): GatedToolSpec<DraftArgs> {
  const build = async (args: DraftArgs): Promise<PrPlan> =>
    planFor(args, await buildDraft(ctx, args, 'What this changes'))
  return {
    tool: DRAFT_PR_TOOL,
    async dryRun(args): Promise<DryRunOutcome> {
      const problem = prProblem(args)
      if (problem !== null) return { confirmable: false, describe: { problem } }
      return { confirmable: true, describe: await build(args) }
    },
    execute: (args) => build(args),
  }
}

// ---------------------------------------------------------------------------
// entry points

export async function supportDraftIssue(
  ctx: McpContext,
  deps: SupportDeps,
  args: DraftArgs,
  confirmToken: string | undefined,
): Promise<GatedResult> {
  return runGated(ctx.gate, issueSpec({ ctx, deps }), args, confirmToken)
}

export async function supportDraftPr(
  ctx: McpContext,
  args: DraftArgs,
  confirmToken: string | undefined,
): Promise<GatedResult> {
  return runGated(ctx.gate, prSpec(ctx), args, confirmToken)
}
