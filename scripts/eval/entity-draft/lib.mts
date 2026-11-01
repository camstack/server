/**
 * The entity-draft benchmark, as a library: backends, the per-case flow
 * (prompt → parse → validate → up to N repair rounds → compare), the metrics
 * and the report. `run.mts` is the command line over it; the spec drives it
 * with a fake backend. Nothing here calls a model on its own — a backend does.
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
// Deep imports, not the barrel: the types sources are CommonJS under tsx, and an
// ES module cannot see the names a CommonJS `export *` re-exports.
import { compareDraft } from '../../../packages/types/src/automation/draft/compare-draft.ts'
import {
  buildDraftPrompt,
  buildRepairPrompt,
  selectFewShots,
} from '../../../packages/types/src/automation/draft/draft-prompt.ts'
import { buildDraftJsonSchema } from '../../../packages/types/src/automation/draft/draft-schemas.ts'
import {
  DRAFT_KINDS,
  type DraftFewShot,
  type DraftKind,
  type DraftSite,
  DraftSiteSchema,
  type JsonSchema,
} from '../../../packages/types/src/automation/draft/draft-types.ts'
import { validateDraft } from '../../../packages/types/src/automation/draft/validate-draft.ts'
import { buildVocabularySlice } from '../../../packages/types/src/automation/draft/vocabulary-slice.ts'
import { LlmGenerateResultSchema } from '../../../packages/types/src/capabilities/llm-shared.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')
export const MATCH_THRESHOLD = 0.9
export const DEFAULT_REPAIRS = 2
export const DEFAULT_MAX_TOKENS = 1200
const HUB_SCRIPT = path.join(REPO_ROOT, 'scripts', 'hub', 'hub.mjs')

// ── fixtures ───────────────────────────────────────────────────────────────

const CaseSchema = z.object({
  id: z.string(),
  lang: z.enum(['it', 'en']),
  description: z.string(),
  entity: z.unknown(),
  mustHave: z.array(z.string()).default([]),
})
export type EvalCase = z.infer<typeof CaseSchema> & { readonly kind: DraftKind }

const FewShotFileSchema = z.array(
  z.object({ kind: z.enum(DRAFT_KINDS), description: z.string(), entity: z.unknown() }),
)

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(path.join(HERE, file), 'utf8'))
}

export function loadSite(): DraftSite {
  return DraftSiteSchema.parse(readJson('fixtures/site.json'))
}

export function loadCases(kinds: readonly DraftKind[] = DRAFT_KINDS): readonly EvalCase[] {
  return kinds.flatMap((kind) =>
    z
      .array(CaseSchema)
      .parse(readJson(`cases/${kind}.json`))
      .map((c) => ({ ...c, kind })),
  )
}

export function loadFewShots(kind: DraftKind): readonly DraftFewShot[] {
  return FewShotFileSchema.parse(readJson('fixtures/fewshots.json'))
    .filter((s) => s.kind === kind)
    .map(({ description, entity }) => ({ description, entity }))
}

// ── backends ───────────────────────────────────────────────────────────────

export interface GenerateRequest {
  readonly system: string
  readonly prompt: string
  readonly schema: JsonSchema
}
export interface GenerateResponse {
  readonly text: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly latencyMs: number
}
export interface Backend {
  readonly id: string
  generate(request: GenerateRequest, evalCase: EvalCase): Promise<GenerateResponse>
}

const OpenAiReplySchema = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
  usage: z
    .object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() })
    .optional(),
})

export interface OpenAiOptions {
  readonly url: string
  readonly model: string
  readonly apiKey?: string
  readonly maxTokens: number
  readonly timeoutMs: number
}

function chatUrl(url: string): string {
  const trimmed = url.replace(/\/+$/, '')
  if (trimmed.endsWith('/chat/completions')) return trimmed
  return `${trimmed}${trimmed.endsWith('/v1') ? '' : '/v1'}/chat/completions`
}

/** An OpenAI-compatible server (LM Studio, llama-server, vLLM): json_schema response_format, temperature 0. */
export function openAiBackend(options: OpenAiOptions): Backend {
  return {
    id: options.model,
    async generate(request) {
      const started = Date.now()
      const response = await fetch(chatUrl(options.url), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(options.apiKey === undefined ? {} : { authorization: `Bearer ${options.apiKey}` }),
        },
        body: JSON.stringify({
          model: options.model,
          temperature: 0,
          max_tokens: options.maxTokens,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.prompt },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'entity_draft', schema: request.schema },
          },
        }),
        signal: AbortSignal.timeout(options.timeoutMs),
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`)
      }
      const body = OpenAiReplySchema.parse(await response.json())
      return {
        text: body.choices[0]?.message.content ?? '',
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
        latencyMs: Date.now() - started,
      }
    },
  }
}

export interface HubOptions {
  readonly profileId: string
  readonly server?: string
  readonly maxTokens: number
  readonly timeoutMs: number
}

function runHub(args: readonly string[], stdin: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [HUB_SCRIPT, ...args],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) reject(new Error(`hub.mjs failed: ${stderr.trim() || error.message}`))
        else resolve(stdout)
      },
    )
    child.stdin?.end(stdin)
  })
}

/** The hub's own `llm.generate`, through a stored profile, as consumer `build-draft`. */
export function hubBackend(options: HubOptions): Backend {
  return {
    id: `hub-${options.profileId}`,
    async generate(request) {
      const started = Date.now()
      const input = {
        profileId: options.profileId,
        consumer: 'build-draft',
        system: request.system,
        prompt: request.prompt,
        jsonSchema: request.schema,
        maxTokens: options.maxTokens,
        temperature: 0,
        timeoutMs: options.timeoutMs,
      }
      const server = options.server === undefined ? [] : ['--server', options.server]
      const out = await runHub(
        [...server, 'POST', 'llm.generate', '-'],
        JSON.stringify(input),
        options.timeoutMs + 30_000,
      )
      const result = LlmGenerateResultSchema.parse(JSON.parse(out))
      if (!result.ok) throw new Error(`llm.generate refused: [${result.code}] ${result.message}`)
      return {
        text: result.text,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        latencyMs: Date.now() - started,
      }
    },
  }
}

/** The expected entity as the model's reply: proves the pipeline end to end, offline. */
export function dryRunBackend(): Backend {
  return {
    id: 'dry-run',
    async generate(_request, evalCase) {
      const started = Date.now()
      return {
        text: JSON.stringify(evalCase.entity),
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: Date.now() - started,
      }
    },
  }
}

// ── one case ───────────────────────────────────────────────────────────────

export interface CaseResult {
  readonly id: string
  readonly kind: DraftKind
  readonly lang: 'it' | 'en'
  readonly validFirstTry: boolean
  readonly validAfterRetry: boolean
  readonly repairRounds: number
  readonly score: number
  readonly mustHaveOk: boolean
  readonly matched: boolean
  readonly latencyMs: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly error?: string
  readonly issues: readonly string[]
  readonly reply: string
}

/** The first JSON object in a reply, tolerating code fences and prose around it. */
export function parseReply(text: string): { ok: true; value: unknown } | { ok: false; issue: string } {
  const unfenced = text.replace(/```(?:json)?/g, '')
  const start = unfenced.indexOf('{')
  const end = unfenced.lastIndexOf('}')
  if (start < 0 || end <= start) return { ok: false, issue: '(root): the reply holds no JSON object' }
  try {
    return { ok: true, value: JSON.parse(unfenced.slice(start, end + 1)) }
  } catch (error: unknown) {
    const why = error instanceof Error ? error.message : String(error)
    return { ok: false, issue: `(root): the reply is not valid JSON (${why})` }
  }
}

export interface RunOptions {
  readonly repairs: number
}

export async function runCase(
  backend: Backend,
  site: DraftSite,
  evalCase: EvalCase,
  options: RunOptions,
): Promise<CaseResult> {
  const slice = buildVocabularySlice(site, evalCase.description)
  const schema = buildDraftJsonSchema(evalCase.kind, slice)
  const fewShots = selectFewShots(evalCase.description, loadFewShots(evalCase.kind))
  const prompt = buildDraftPrompt(evalCase.kind, slice, evalCase.description, fewShots)
  let current = prompt.user
  let latencyMs = 0
  let inputTokens = 0
  let outputTokens = 0
  let validFirstTry = false
  let valid = false
  let rounds = 0
  let issues: readonly string[] = []
  let reply = ''
  let draft: unknown
  try {
    for (let round = 0; round <= options.repairs; round += 1) {
      const response = await backend.generate(
        { system: prompt.system, prompt: current, schema },
        evalCase,
      )
      latencyMs += response.latencyMs
      inputTokens += response.inputTokens
      outputTokens += response.outputTokens
      reply = response.text
      const parsed = parseReply(response.text)
      const verdict = parsed.ok
        ? validateDraft(evalCase.kind, parsed.value, site)
        : ({ ok: false, issues: [parsed.issue] } as const)
      if (verdict.ok) {
        valid = true
        validFirstTry = round === 0
        draft = verdict.draft
        issues = []
        rounds = round
        break
      }
      issues = verdict.issues
      rounds = round
      current = `${prompt.user}\n\nYour previous answer:\n${response.text}\n\n${buildRepairPrompt(verdict.issues)}`
    }
  } catch (error: unknown) {
    return failed(evalCase, error instanceof Error ? error.message : String(error), {
      latencyMs,
      inputTokens,
      outputTokens,
    })
  }
  const score = valid ? compareDraft(evalCase.kind, draft, evalCase.entity) : 0
  const text = valid ? JSON.stringify(draft) : ''
  const mustHaveOk = evalCase.mustHave.every((m) => text.includes(m))
  return {
    id: evalCase.id,
    kind: evalCase.kind,
    lang: evalCase.lang,
    validFirstTry,
    validAfterRetry: valid,
    repairRounds: rounds,
    score,
    mustHaveOk,
    matched: valid && score >= MATCH_THRESHOLD && mustHaveOk,
    latencyMs,
    inputTokens,
    outputTokens,
    issues,
    reply,
  }
}

function failed(
  evalCase: EvalCase,
  error: string,
  spent: { latencyMs: number; inputTokens: number; outputTokens: number },
): CaseResult {
  return {
    id: evalCase.id,
    kind: evalCase.kind,
    lang: evalCase.lang,
    validFirstTry: false,
    validAfterRetry: false,
    repairRounds: 0,
    score: 0,
    mustHaveOk: false,
    matched: false,
    ...spent,
    error,
    issues: [error],
    reply: '',
  }
}

// ── metrics and report ─────────────────────────────────────────────────────

export interface Metrics {
  readonly cases: number
  readonly validFirstTry: number
  readonly validAfterRetry: number
  readonly semanticMatch: number
  readonly latencyP50Ms: number
  readonly latencyP95Ms: number
  readonly inputTokens: number
  readonly outputTokens: number
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, index)] ?? 0
}

export function metricsOf(results: readonly CaseResult[]): Metrics {
  const n = results.length
  const share = (count: number): number => (n === 0 ? 0 : count / n)
  const latencies = results.map((r) => r.latencyMs).toSorted((a, b) => a - b)
  return {
    cases: n,
    validFirstTry: share(results.filter((r) => r.validFirstTry).length),
    validAfterRetry: share(results.filter((r) => r.validAfterRetry).length),
    semanticMatch: share(results.filter((r) => r.matched).length),
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    inputTokens: results.reduce((s, r) => s + r.inputTokens, 0),
    outputTokens: results.reduce((s, r) => s + r.outputTokens, 0),
  }
}

export interface Report {
  readonly model: string
  readonly dryRun: boolean
  readonly overall: Metrics
  readonly byKind: Readonly<Record<string, Metrics>>
  readonly byLang: Readonly<Record<string, Metrics>>
  readonly results: readonly CaseResult[]
}

export async function runEval(
  backend: Backend,
  site: DraftSite,
  cases: readonly EvalCase[],
  options: RunOptions & { readonly dryRun?: boolean; readonly onCase?: (r: CaseResult) => void },
): Promise<Report> {
  const results: CaseResult[] = []
  for (const evalCase of cases) {
    const result = await runCase(backend, site, evalCase, options)
    results.push(result)
    options.onCase?.(result)
  }
  const group = (key: (r: CaseResult) => string): Record<string, Metrics> =>
    Object.fromEntries(
      [...new Set(results.map(key))].map((k) => [k, metricsOf(results.filter((r) => key(r) === k))]),
    )
  return {
    model: backend.id,
    dryRun: options.dryRun === true,
    overall: metricsOf(results),
    byKind: group((r) => r.kind),
    byLang: group((r) => r.lang),
    results,
  }
}

const pct = (v: number): string => `${(v * 100).toFixed(0)}%`

export function renderMarkdown(report: Report): string {
  const row = (label: string, m: Metrics): string =>
    `| ${label} | ${m.cases} | ${pct(m.validFirstTry)} | ${pct(m.validAfterRetry)} | ${pct(m.semanticMatch)} | ${m.latencyP50Ms} | ${m.latencyP95Ms} | ${m.inputTokens} / ${m.outputTokens} |`
  const lines = [
    `# Entity draft benchmark — ${report.model}${report.dryRun ? ' (dry run)' : ''}`,
    '',
    '| set | cases | valid 1st try | valid after retry | semantic match | p50 ms | p95 ms | tokens in / out |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...Object.entries(report.byKind).map(([k, m]) => row(k, m)),
    ...Object.entries(report.byLang).map(([k, m]) => row(`lang ${k}`, m)),
    row('**all**', report.overall),
  ]
  const misses = report.results.filter((r) => !r.matched)
  if (misses.length > 0) {
    lines.push('', '## Misses', '')
    for (const r of misses) {
      const why = r.error ?? (r.validAfterRetry ? `score ${r.score}` : (r.issues[0] ?? 'invalid'))
      lines.push(`- ${r.id}: ${why}`)
    }
  }
  return `${lines.join('\n')}\n`
}

export async function writeReport(report: Report, outDir: string): Promise<readonly string[]> {
  await mkdir(outDir, { recursive: true })
  const stem = path.join(outDir, report.model.replace(/[^A-Za-z0-9._-]+/g, '_'))
  await writeFile(`${stem}.json`, `${JSON.stringify(report, null, 2)}\n`)
  await writeFile(`${stem}.md`, renderMarkdown(report))
  return [`${stem}.json`, `${stem}.md`]
}

export const DEFAULT_OUT_DIR = path.join(REPO_ROOT, 'test-output', 'entity-draft')
