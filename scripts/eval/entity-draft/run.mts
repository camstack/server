/**
 * Entity-draft benchmark runner (#375). The runner calls a model only when you
 * point it at one; `--dry-run` answers every case with its expected entity and
 * proves the whole pipeline offline.
 *
 *   npx tsx scripts/eval/entity-draft/run.mts --dry-run
 *   npx tsx scripts/eval/entity-draft/run.mts --openai-url http://localhost:1234/v1 --model qwen2.5-7b-instruct
 *   npx tsx scripts/eval/entity-draft/run.mts --hub --profile <profileId> [--server <host>]
 *
 * Options: --kinds automation,action  --limit N (per kind)  --repairs 2
 *          --max-tokens 1200  --timeout-ms 180000  --api-key <key>  --out <dir>
 * Writes <out>/<model>.json and <model>.md (default: test-output/entity-draft).
 */
import { parseArgs } from 'node:util'
import { DRAFT_KINDS, type DraftKind } from '../../../packages/types/src/automation/draft/draft-types.ts'
import {
  type Backend,
  DEFAULT_MAX_TOKENS,
  DEFAULT_OUT_DIR,
  DEFAULT_REPAIRS,
  dryRunBackend,
  hubBackend,
  loadCases,
  loadSite,
  openAiBackend,
  renderMarkdown,
  runEval,
  writeReport,
} from './lib.mts'

const { values } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    'openai-url': { type: 'string' },
    model: { type: 'string' },
    'api-key': { type: 'string' },
    hub: { type: 'boolean', default: false },
    profile: { type: 'string' },
    server: { type: 'string' },
    kinds: { type: 'string' },
    limit: { type: 'string' },
    repairs: { type: 'string' },
    'max-tokens': { type: 'string' },
    'timeout-ms': { type: 'string' },
    out: { type: 'string' },
  },
})

function fail(message: string): never {
  console.error(message)
  process.exit(2)
}

function isKind(value: string): value is DraftKind {
  return DRAFT_KINDS.some((k) => k === value)
}

function numberOption(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fail(`not a number: ${raw}`)
}

const maxTokens = numberOption(values['max-tokens'], DEFAULT_MAX_TOKENS)
const timeoutMs = numberOption(values['timeout-ms'], 180_000)
const repairs = numberOption(values.repairs, DEFAULT_REPAIRS)

function chooseBackend(): Backend {
  if (values['dry-run']) return dryRunBackend()
  const openAiUrl = values['openai-url']
  if (openAiUrl !== undefined) {
    const model = values.model ?? fail('--openai-url needs --model <id>')
    const apiKey = values['api-key'] ?? process.env['OPENAI_API_KEY']
    return openAiBackend({
      url: openAiUrl,
      model,
      maxTokens,
      timeoutMs,
      ...(apiKey === undefined ? {} : { apiKey }),
    })
  }
  if (values.hub) {
    const profileId = values.profile ?? fail('--hub needs --profile <profileId>')
    return hubBackend({
      profileId,
      maxTokens,
      timeoutMs,
      ...(values.server === undefined ? {} : { server: values.server }),
    })
  }
  return fail('choose a backend: --dry-run, --openai-url <url> --model <id>, or --hub --profile <id>')
}

const kinds = (values.kinds?.split(',') ?? [...DRAFT_KINDS]).map((k) =>
  isKind(k) ? k : fail(`unknown kind: ${k}`),
)
const limit = values.limit === undefined ? Infinity : numberOption(values.limit, Infinity)
const cases = kinds.flatMap((kind) => loadCases([kind]).slice(0, limit))
const backend = chooseBackend()

const report = await runEval(backend, loadSite(), cases, {
  repairs,
  dryRun: values['dry-run'],
  onCase: (r) => {
    const mark = r.matched ? 'ok  ' : r.validAfterRetry ? 'diff' : 'FAIL'
    console.error(`${mark} ${r.id} score=${r.score} rounds=${r.repairRounds} ${r.latencyMs}ms`)
  },
})
const files = await writeReport(report, values.out ?? DEFAULT_OUT_DIR)
process.stdout.write(renderMarkdown(report))
console.error(`wrote ${files.join(', ')}`)
