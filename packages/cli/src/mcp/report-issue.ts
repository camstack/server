/**
 * `report_issue`: drafts a GitHub issue for camstack/server from what this
 * install can tell, and files it only after the person read the whole text.
 *
 * Two steps through the mutation gate (D836), with one difference from the
 * other gated tools: the token is bound to the arguments AND to the exact
 * rendered text (a sha256 of title + body). The execute step files the text
 * the dry run showed, never a rebuild, so a re-run whose logs moved is a new
 * dry run with a new token, and an old token cannot file text nobody saw.
 *
 * Every string of the issue goes through the scrubber (`report-scrub.ts`)
 * before it is rendered; the Environment section is built from an allow list
 * (`report-environment.ts`). Filing uses the person's own `gh`; without it the
 * answer is a prefilled new-issue URL, cut to a safe length.
 */
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MUTATIONS_DISABLED_REASON } from '@camstack/develop'
import { z } from 'zod'
import type { McpContext } from './context.js'
import { parseSince } from './debug-logs.js'
import { withHub, type NoSessionResult, type RefusedResult } from './ops-hub.js'
import { adminRefusal } from './setup-assist-common.js'
import type { SupportDeps } from './support-deps.js'
import { collectEnvironment, renderEnvironment } from './report-environment.js'
import { collectLogs, REPORT_KINDS, type LogSection, type ReportKind } from './report-recipes.js'
import { createRedactor, describeRedactions, type RedactionCounts } from './report-scrub.js'

export const REPORT_ISSUE_TOOL = 'report_issue'
export const REPORT_REPO = 'camstack/server'
export const TITLE_MAX = 140
export const DEFAULT_SINCE_MINUTES = 30
export const MAX_SINCE_MINUTES = 24 * 60
/** GitHub refuses a new-issue URL much past 8 KB; stay well under it. */
export const URL_MAX_CHARS = 6_500

export const ReportKindSchema = z.enum(REPORT_KINDS)

export interface ReportIssueArgs {
  readonly kind: ReportKind
  readonly title: string
  readonly description: string
  readonly deviceId?: number
  readonly since?: string
}

export interface IssueDraft {
  readonly repo: string
  readonly title: string
  readonly body: string
  /** The whole text as the person reads it. */
  readonly markdown: string
  readonly redactions: RedactionCounts
  readonly redactionSummary: string
  readonly textSha: string
}

export const textShaOf = (title: string, body: string): string =>
  createHash('sha256').update(`${title}\n${body}`).digest('hex')

function renderSection(s: LogSection, scrub: (t: string) => string): string {
  const head = [`### ${scrub(s.title)}`, `_${scrub(s.source)}_`]
  if (s.lines === null) return [...head, `Not available: ${scrub(s.note ?? 'unknown')}`].join('\n')
  const body = s.lines.length === 0 ? ['(no lines)'] : s.lines.map((l) => scrub(l))
  const tail = [
    ...(s.truncated > 0 ? [`… ${String(s.truncated)} more not shown`] : []),
    ...(s.note !== null ? [`note: ${scrub(s.note)}`] : []),
  ]
  return [...head, '```text', ...body, ...tail, '```'].join('\n')
}

export async function buildIssueDraft(
  ctx: McpContext,
  client: Parameters<typeof collectEnvironment>[1],
  args: ReportIssueArgs,
  now: number,
): Promise<IssueDraft | RefusedResult> {
  const sinceMs = parseSince(args.since, now, DEFAULT_SINCE_MINUTES)
  if (sinceMs === null) {
    return {
      status: 'refused',
      reason: `since "${String(args.since)}" is not 30m, 2h, 1d or an ISO time`,
    }
  }
  const window = { sinceMs: Math.max(sinceMs, now - MAX_SINCE_MINUTES * 60_000), untilMs: now }
  const logs = await collectLogs(
    ctx,
    client,
    {
      kind: args.kind,
      ...(args.deviceId !== undefined ? { deviceId: args.deviceId } : {}),
      ...(args.since !== undefined ? { since: args.since } : {}),
    },
    window,
  )
  const env = await collectEnvironment(ctx, client, {
    ...(args.deviceId !== undefined ? { deviceId: args.deviceId } : {}),
    viewerAppVersion: logs.viewerAppVersion,
  })
  const redactor = createRedactor(env.knownNames)
  const scrub = redactor.scrub
  const title = scrub(args.title).replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX)
  const sections = [
    `## What happens`,
    `Kind: ${args.kind}`,
    scrub(args.description),
    scrub(renderEnvironment(env)),
    `## Logs (${args.kind}, last ${args.since ?? `${String(DEFAULT_SINCE_MINUTES)}m`})`,
    ...logs.sections.map((s) => renderSection(s, scrub)),
  ]
  const counts = redactor.counts()
  const summary = describeRedactions(counts)
  const footer = `_Drafted with the \`camstack mcp\` support toolset and read by the reporter before filing. ${summary}._`
  const body = [...sections, footer].join('\n\n')
  return {
    repo: REPORT_REPO,
    title,
    body,
    markdown: `# ${title}\n\n${body}`,
    redactions: counts,
    redactionSummary: summary,
    textSha: textShaOf(title, body),
  }
}

// ---------------------------------------------------------------------------
// the gate: a token bound to the arguments and to the text

const previewed = new WeakMap<object, Map<string, IssueDraft>>()

export function prefilledIssueUrl(draft: Pick<IssueDraft, 'title' | 'body' | 'repo'>): {
  readonly url: string
  readonly truncated: boolean
} {
  const base = `https://github.com/${draft.repo}/issues/new?title=${encodeURIComponent(draft.title)}&body=`
  const marker = '\n\n… (cut to fit a link: paste the full draft shown by the assistant)'
  if (base.length + encodeURIComponent(draft.body).length <= URL_MAX_CHARS) {
    return { url: `${base}${encodeURIComponent(draft.body)}`, truncated: false }
  }
  const lines = draft.body.split('\n')
  let kept = ''
  for (const line of lines) {
    const next = kept === '' ? line : `${kept}\n${line}`
    if (base.length + encodeURIComponent(next + marker).length > URL_MAX_CHARS) break
    kept = next
  }
  // The first line alone can be too long: cut it by characters, never mid-escape.
  if (kept === '') {
    const room = Math.max(0, URL_MAX_CHARS - base.length - encodeURIComponent(marker).length)
    kept = Array.from(draft.body).reduce(
      (acc, ch) => (encodeURIComponent(acc + ch).length <= room ? acc + ch : acc),
      '',
    )
  }
  return { url: `${base}${encodeURIComponent(kept + marker)}`, truncated: true }
}

export type CreateOutcome =
  | { readonly outcome: 'created'; readonly url: string; readonly repo: string }
  | {
      readonly outcome: 'link'
      readonly reason: string
      readonly repo: string
      readonly url: string
      readonly truncated: boolean
      readonly note: string
    }

async function createIssue(deps: SupportDeps, draft: IssueDraft): Promise<CreateOutcome> {
  const link = (reason: string): CreateOutcome => {
    const { url, truncated } = prefilledIssueUrl(draft)
    return {
      outcome: 'link',
      reason,
      repo: draft.repo,
      url,
      truncated,
      note: truncated
        ? 'Open the link and paste the full draft over the cut body; nothing was filed.'
        : 'Open the link, review and press Submit; nothing was filed.',
    }
  }
  const auth = await deps.runner('gh', ['auth', 'status'])
  if (auth.code !== 0) return link('gh is missing or not signed in')
  const dir = await mkdtemp(join(tmpdir(), 'camstack-report-'))
  try {
    const bodyFile = join(dir, 'issue-body.md')
    await writeFile(bodyFile, draft.body, { mode: 0o600 })
    const made = await deps.runner('gh', [
      'issue',
      'create',
      '-R',
      draft.repo,
      '--title',
      draft.title,
      '--body-file',
      bodyFile,
    ])
    if (made.code !== 0) return link('gh could not create the issue')
    const url =
      made.stdout
        .split('\n')
        .map((l) => l.trim())
        .findLast((l) => l.startsWith('https://')) ?? ''
    return { outcome: 'created', url, repo: draft.repo }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export interface ReportDryRun {
  readonly action: string
  readonly targetRepo: string
  readonly markdown: string
  readonly redacted: string
  /** A list, not an object keyed by kind: the output scrub hides values under keys named token / secret. */
  readonly redactions: readonly { readonly kind: string; readonly count: number }[]
  readonly instructions: string
}

export type ReportResult =
  | { readonly status: 'refused'; readonly reason: string }
  | NoSessionResult
  | {
      readonly status: 'dry-run'
      readonly confirm_token: string
      readonly expiresAt: string
      readonly dryRun: ReportDryRun
      readonly next: string
    }
  | { readonly status: 'executed'; readonly result: CreateOutcome }

const SHOW_FIRST =
  'SHOW the markdown above to the user in full and WAIT for an explicit yes. Do not file on your own. If they want a change, call report_issue again with the edited title or description: that is a new draft with a new confirm_token.'

export async function reportIssue(
  ctx: McpContext,
  deps: SupportDeps,
  args: ReportIssueArgs,
  confirmToken: string | undefined,
  now: number = Date.now(),
): Promise<ReportResult | RefusedResult> {
  const gate = ctx.gate
  if (!gate.enabled) {
    gate.record(REPORT_ISSUE_TOOL, 'refused', args, 'mutations disabled')
    return { status: 'refused', reason: MUTATIONS_DISABLED_REASON }
  }
  if (confirmToken === undefined) {
    const outcome = await withHub(ctx, async (connection) => {
      const refused = adminRefusal(connection, 'report_issue (logs, nodes)')
      if (refused) return refused
      return buildIssueDraft(ctx, connection.client, args, now)
    })
    if ('status' in outcome) return outcome
    const issued = gate.issue(REPORT_ISSUE_TOOL, { args, textSha: outcome.textSha })
    const byToken = previewed.get(gate) ?? new Map<string, IssueDraft>()
    byToken.set(issued.confirmToken, outcome)
    previewed.set(gate, byToken)
    gate.record(
      REPORT_ISSUE_TOOL,
      'dry-run',
      args,
      `token issued for text ${outcome.textSha.slice(0, 12)}`,
    )
    return {
      status: 'dry-run',
      confirm_token: issued.confirmToken,
      expiresAt: new Date(issued.expiresAt).toISOString(),
      dryRun: {
        action: `open a GitHub issue on ${outcome.repo} with your own gh sign-in (or return a prefilled link)`,
        targetRepo: outcome.repo,
        markdown: outcome.markdown,
        redacted: outcome.redactionSummary,
        redactions: Object.entries(outcome.redactions).map(([kind, count]) => ({ kind, count })),
        instructions: SHOW_FIRST,
      },
      next: `Nothing was filed. After the user said yes, call ${REPORT_ISSUE_TOOL} again with the SAME arguments and confirm_token. The token is single-use and bound to this exact text.`,
    }
  }
  const byToken = previewed.get(gate)
  const draft = byToken?.get(confirmToken)
  byToken?.delete(confirmToken)
  const decision = gate.confirm(
    REPORT_ISSUE_TOOL,
    { args, textSha: draft?.textSha ?? '' },
    confirmToken,
  )
  if (!decision.ok || draft === undefined) {
    const reason = decision.ok
      ? 'the previewed draft is gone — call the tool again for a fresh draft'
      : decision.reason
    gate.record(REPORT_ISSUE_TOOL, 'refused', args, reason)
    return { status: 'refused', reason }
  }
  gate.record(REPORT_ISSUE_TOOL, 'execute', args, 'confirmed — filing the text the user read')
  const result = await createIssue(deps, draft)
  gate.record(REPORT_ISSUE_TOOL, 'executed', args, result.outcome)
  return { status: 'executed', result }
}
