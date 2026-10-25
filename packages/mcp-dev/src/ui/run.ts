/**
 * UI tools: thin adapters over `scripts/ui/cli.ts`, the one UI catalogue and
 * checker of this repository (`docs/reference/ui-components.json`,
 * `npm run ui:find|show|tokens|check`). There is deliberately no second
 * catalogue here — a second generator drifts. `check` is a developer tool,
 * never a CI gate (operator decision 6, 2026-10-09).
 */
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'

export type UiCliCommand = 'find' | 'show' | 'tokens' | 'check'

export interface UiCliResult {
  readonly command: UiCliCommand
  readonly exitCode: number
  readonly output: string
}

const CLI_TIMEOUT_MS = 60_000

export function runUiCli(
  workspaceRoot: string,
  command: UiCliCommand,
  args: readonly string[],
): UiCliResult {
  const tsx = path.join(workspaceRoot, 'node_modules', '.bin', 'tsx')
  const res = spawnSync(tsx, [path.join('scripts', 'ui', 'cli.ts'), command, ...args], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
  })
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim()
  return { command, exitCode: res.status ?? 1, output }
}

/** A path handed to `check` must stay inside the workspace. */
export function resolveInsideRoot(workspaceRoot: string, candidate: string): string | null {
  const abs = path.resolve(workspaceRoot, candidate)
  const rel = path.relative(workspaceRoot, abs)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel === '' ? '.' : rel
}
