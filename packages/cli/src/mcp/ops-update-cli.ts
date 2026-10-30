/**
 * The CLI/MCP itself in the update tools: running version against the
 * registry, and the one command that could update it. A running stdio MCP
 * cannot hot-swap itself, so an update always ends with "restart the MCP in
 * your client". The install method is detected, never guessed: anything that
 * is not plainly a global npm install is answered with instructions only.
 */
import { execFile } from 'node:child_process'
import type { FetchFn } from './context.js'
import { latestOnNpm } from './setup-tools.js'

export const CLI_PACKAGE = 'camstack'

export type CliInstallMethod = 'npm-global' | 'npx' | 'unknown'

export interface CliInstall {
  readonly method: CliInstallMethod
  /** The command to run, never with sudo; `null` when it cannot be told safely. */
  readonly command: readonly string[] | null
  /** What to tell the operator when no command is run. */
  readonly instructions: string
}

const NPM_GLOBAL =
  /[\\/]lib[\\/]node_modules[\\/]camstack[\\/]|[\\/]npm[\\/]node_modules[\\/]camstack[\\/]/
const OTHER_MANAGER =
  /[\\/]\.bun[\\/]|[\\/]pnpm[\\/]|[\\/]\.yarn[\\/]|[\\/]yarn[\\/]|[\\/]\.volta[\\/]/

/** `entryPath` is the resolved path of the running CLI entry (process.argv[1]). */
export function detectCliInstall(entryPath: string): CliInstall {
  const manual = `Update it with the package manager it was installed with, for example \`npm install -g ${CLI_PACKAGE}@latest\` (no sudo: fix the npm prefix permissions instead).`
  if (/[\\/]_npx[\\/]/.test(entryPath)) {
    return {
      method: 'npx',
      command: null,
      instructions: `The CLI runs through npx: there is nothing installed to update. Start it as \`npx ${CLI_PACKAGE}@latest mcp\` (or clear the npx cache), then restart the MCP in your client.`,
    }
  }
  if (OTHER_MANAGER.test(entryPath) || !NPM_GLOBAL.test(entryPath)) {
    return { method: 'unknown', command: null, instructions: manual }
  }
  return {
    method: 'npm-global',
    command: ['npm', 'install', '-g', `${CLI_PACKAGE}@latest`],
    instructions: `npm install -g ${CLI_PACKAGE}@latest`,
  }
}

export interface CommandResult {
  readonly ok: boolean
  readonly output: string
}

export type RunCommand = (file: string, args: readonly string[]) => Promise<CommandResult>

export const runCommand: RunCommand = (file, args) =>
  new Promise((resolve) => {
    execFile(file, [...args], { timeout: 5 * 60_000 }, (err, stdout, stderr) => {
      const out = `${stdout}${stderr}`.trim().slice(-600)
      resolve({
        ok: err === null,
        output: err ? `${err.message} ${out}`.trim() : out,
      })
    })
  })

export interface CliVersionVerdict {
  readonly installed: string
  readonly latest: string | null
  /** `null`: the registry could not be read; lag or an outage is not "up to date". */
  readonly updateAvailable: boolean | null
  readonly error?: string
  readonly install: CliInstall
}

function parts(v: string): readonly number[] {
  return v
    .split('-')[0]!
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0)
}

/** True when `a` is strictly older than `b` (numeric major.minor.patch). */
export function isOlder(a: string, b: string): boolean {
  const x = parts(a)
  const y = parts(b)
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d < 0
  }
  return false
}

export async function cliVerdict(
  installed: string,
  fetchFn: FetchFn,
  entryPath: string,
): Promise<CliVersionVerdict> {
  const latest = await latestOnNpm(CLI_PACKAGE, fetchFn)
  return {
    installed,
    latest: latest.latest,
    updateAvailable: latest.latest === null ? null : isOlder(installed, latest.latest),
    ...(latest.error !== undefined ? { error: latest.error } : {}),
    install: detectCliInstall(entryPath),
  }
}
