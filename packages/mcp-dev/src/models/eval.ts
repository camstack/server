/**
 * `eval_model` — runs the repository's evaluation harness
 * (`scripts/eval/evaluate.py`, `evaluate_variants.py`) against an annotated
 * retrain export, inside a venv under `<workspace>/scratchpad/eval-venv`.
 *
 * CPU only, local only: it never touches the cluster. It does write — the
 * venv and a report under `scratchpad/eval/` — so it is a workspace write, not
 * a read. Every input path must live inside the workspace (drop the export and
 * the model files under `scratchpad/`), and no shell is involved: argv only.
 *
 * The venv is NOT created implicitly (a `pip install` of ~1 GB of wheels is
 * not a side effect to spring on anyone): without it the tool answers with the
 * exact commands, and `setupVenv: true` runs them.
 */
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import { ConfinementError, confine } from '../fs-confine.js'
import { toToolOutput } from '../ops/redact.js'

export const EVAL_TIMEOUT_MS: number = 45 * 60_000
const SETUP_TIMEOUT_MS = 20 * 60_000
const OUTPUT_TAIL_CHARS = 6_000

export interface ProcessResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly timeoutMs: number },
) => Promise<ProcessResult>

/** argv-only spawn; output kept as a bounded tail; killed on timeout. */
export const spawnRunner: ProcessRunner = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const keep = (current: string, chunk: Buffer): string =>
      (current + chunk.toString('utf8')).slice(-64_000)
    child.stdout.on('data', (c: Buffer) => (stdout = keep(stdout, c)))
    child.stderr.on('data', (c: Buffer) => (stderr = keep(stderr, c)))
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ exitCode: code ?? 1, stdout, stderr })
    })
  })

const VariantSchema = z.object({
  label: z.string().regex(/^[A-Za-z0-9._-]+$/),
  path: z.string().min(1),
  size: z.number().int().positive(),
})

export interface EvalVariant {
  label: string
  path: string
  size: number
}

export interface EvalArgs {
  exportPath: string
  baseline?: string
  baselineSize?: number
  candidate?: string
  candidateSize?: number
  baselineModelId?: string
  holdoutCameras?: number[]
  since?: string
  variants?: EvalVariant[]
  baselineLabel?: string
  includeIncomplete?: boolean
  setupVenv?: boolean
}

export const EvalArgsSchema: z.ZodType<EvalArgs> = z.object({
  /** The annotated export: a tar or an extracted directory, inside the workspace. */
  exportPath: z.string().min(1),
  /** Two-model comparison (evaluate.py)… */
  baseline: z.string().optional(),
  baselineSize: z.number().int().positive().optional(),
  candidate: z.string().optional(),
  candidateSize: z.number().int().positive().optional(),
  baselineModelId: z.string().optional(),
  holdoutCameras: z.array(z.number().int()).optional(),
  since: z.string().optional(),
  /** …or N variants (evaluate_variants.py). */
  variants: z.array(VariantSchema).min(2).max(8).optional(),
  baselineLabel: z.string().optional(),
  includeIncomplete: z.boolean().optional(),
  /** Create the venv and install scripts/eval/requirements.txt first. */
  setupVenv: z.boolean().optional(),
})

export interface EvalDeps {
  readonly run: ProcessRunner
  readonly now?: () => Date
}

export type EvalResult =
  | { readonly status: 'needs-setup'; readonly why: string; readonly commands: readonly string[] }
  | { readonly status: 'refused'; readonly reason: string }
  | {
      readonly status: 'done' | 'failed'
      readonly exitCode: number
      readonly script: string
      readonly summary: string
      readonly reportPath?: string
      readonly report?: unknown
    }

function venvPaths(root: string): { venv: string; python: string; pip: string } {
  const venv = path.join(root, 'scratchpad', 'eval-venv')
  return { venv, python: path.join(venv, 'bin', 'python'), pip: path.join(venv, 'bin', 'pip') }
}

function tail(text: string): string {
  return text.length > OUTPUT_TAIL_CHARS ? `…${text.slice(-OUTPUT_TAIL_CHARS)}` : text
}

function modeOf(args: EvalArgs): 'pair' | 'variants' | string {
  const pair = [args.baseline, args.baselineSize, args.candidate, args.candidateSize]
  const anyPair = pair.some((v) => v !== undefined)
  const fullPair = pair.every((v) => v !== undefined)
  if (args.variants && anyPair) return 'give either baseline/candidate or variants, not both'
  if (args.variants) return 'variants'
  if (fullPair) return 'pair'
  return 'give baseline+baselineSize+candidate+candidateSize, or variants (2+)'
}

export async function evalModel(root: string, args: EvalArgs, deps: EvalDeps): Promise<EvalResult> {
  const mode = modeOf(args)
  if (mode !== 'pair' && mode !== 'variants') return { status: 'refused', reason: mode }

  // Every path is confined BEFORE anything is created or run.
  let inputs: { readonly script: string; readonly argv: readonly string[] }
  try {
    inputs = buildInputs(root, args, mode)
  } catch (err) {
    if (err instanceof ConfinementError) return { status: 'refused', reason: err.message }
    throw err
  }

  const { venv, python, pip } = venvPaths(root)
  const requirements = path.join(root, 'scripts', 'eval', 'requirements.txt')
  const setup = [`python3 -m venv ${venv}`, `${pip} install -r ${requirements}`]
  if (!fs.existsSync(python)) {
    if (args.setupVenv !== true) {
      return {
        status: 'needs-setup',
        why: 'the evaluation venv does not exist yet; creating it downloads onnxruntime and openvino wheels',
        commands: [...setup, 'or call eval_model again with setupVenv:true'],
      }
    }
    const made = await deps.run('python3', ['-m', 'venv', venv], {
      cwd: root,
      timeoutMs: SETUP_TIMEOUT_MS,
    })
    if (made.exitCode !== 0) {
      return { status: 'refused', reason: `python3 -m venv failed: ${tail(made.stderr)}` }
    }
    const installed = await deps.run(pip, ['install', '-r', requirements], {
      cwd: root,
      timeoutMs: SETUP_TIMEOUT_MS,
    })
    if (installed.exitCode !== 0) {
      return { status: 'refused', reason: `pip install failed: ${tail(installed.stderr)}` }
    }
  }

  const stamp = (deps.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, '-')
  const outDir = confine(root, path.join('scratchpad', 'eval', stamp))
  fs.mkdirSync(outDir, { recursive: true })
  const reportPath = path.join(outDir, 'report.json')

  const script = inputs.script
  const argv: string[] = [...inputs.argv, '--out', reportPath]
  if (args.includeIncomplete) argv.push('--include-incomplete')

  const result = await deps.run(python, [path.join(root, 'scripts', 'eval', script), ...argv], {
    cwd: root,
    timeoutMs: EVAL_TIMEOUT_MS,
  })
  const summary = tail(result.stdout.trim() || result.stderr.trim())
  if (result.exitCode !== 0) {
    return {
      status: 'failed',
      exitCode: result.exitCode,
      script,
      summary: tail(`${result.stdout}\n${result.stderr}`),
    }
  }
  let report: unknown
  try {
    report = toToolOutput(JSON.parse(fs.readFileSync(reportPath, 'utf8')))
  } catch {
    report = undefined
  }
  return {
    status: 'done',
    exitCode: 0,
    script,
    summary,
    reportPath: path.relative(root, reportPath),
    ...(report !== undefined ? { report } : {}),
  }
}

function buildInputs(
  root: string,
  args: EvalArgs,
  mode: 'pair' | 'variants',
): { readonly script: string; readonly argv: readonly string[] } {
  const argv: string[] = ['--export', confine(root, args.exportPath)]
  if (mode === 'pair') {
    argv.push(
      '--baseline',
      confine(root, args.baseline ?? ''),
      '--baseline-size',
      String(args.baselineSize),
      '--candidate',
      confine(root, args.candidate ?? ''),
      '--candidate-size',
      String(args.candidateSize),
    )
    if (args.baselineModelId) argv.push('--baseline-model-id', args.baselineModelId)
    if (args.holdoutCameras?.length) argv.push('--holdout-cameras', args.holdoutCameras.join(','))
    if (args.since) argv.push('--since', args.since)
    return { script: 'evaluate.py', argv }
  }
  for (const v of args.variants ?? []) {
    argv.push('--model', `${v.label}=${confine(root, v.path)}@${v.size}`)
  }
  if (args.baselineLabel) argv.push('--baseline', args.baselineLabel)
  argv.push('--cache', confine(root, path.join('scratchpad', 'eval', 'cache')))
  return { script: 'evaluate_variants.py', argv }
}
