/**
 * camstack CLI subprocess wrapper.
 *
 * Resolves `packages/cli/dist/cli.js` and invokes it via `node` so suites
 * can drive the same install / deploy / login verbs an operator would
 * use, without polluting their global npm install.
 *
 * The wrapper is intentionally minimal — exit code, captured stdout,
 * captured stderr. Suites that need to drive the CLI's prompt flow
 * (login auth-key paste, etc.) should stitch in a `stdin` writer.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const REPO_ROOT = resolve(__dirname, '..', '..')
const CLI_ENTRY = resolve(REPO_ROOT, 'packages/cli/dist/cli.js')

export interface CamstackCliResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface RunCamstackCliOptions {
  /** Override the cwd. Default: REPO_ROOT. */
  cwd?: string
  /** Extra env merged on top of process.env. */
  env?: Record<string, string>
  /** Optional stdin payload. Default: closed. */
  stdin?: string
  /** Hard timeout. Default: 30s — `deploy` may build the addon first. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 30_000

export async function runCamstackCli(
  args: readonly string[],
  options: RunCamstackCliOptions = {},
): Promise<CamstackCliResult> {
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(
      `camstack CLI not built at ${CLI_ENTRY}. Run \`npm run build -w packages/cli\` first.`,
    )
  }

  return await new Promise<CamstackCliResult>((resolveCli, reject) => {
    const proc = spawn('node', [CLI_ENTRY, ...args], {
      cwd: options.cwd ?? REPO_ROOT,
      env: { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let killedByTimeout = false

    proc.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8')
    })
    proc.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8')
    })

    const timer = setTimeout(() => {
      killedByTimeout = true
      proc.kill('SIGKILL')
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    proc.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })

    proc.once('exit', (code) => {
      clearTimeout(timer)
      if (killedByTimeout) {
        reject(
          new Error(
            `camstack CLI timed out after ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms. ` +
              `args=${JSON.stringify(args)}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        )
        return
      }
      resolveCli({ exitCode: code ?? -1, stdout, stderr })
    })

    if (options.stdin !== undefined) {
      proc.stdin.write(options.stdin)
    }
    proc.stdin.end()
  })
}
