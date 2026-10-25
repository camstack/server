/**
 * The only way the release tools run a process: an ALLOW-LIST of read-only
 * invocations of `git`, `gh` and `npm`, checked before anything is spawned.
 *
 * Release tools describe; they never publish, dispatch a workflow, push, tag,
 * deploy or deprecate. The allow-list is the structural guarantee — a deny-list
 * of "bad" subcommands rots the first time a new one appears.
 */
import type { ProcessResult, ProcessRunner } from '../models/eval.js'

export class DeniedCommandError extends Error {
  constructor(command: string, args: readonly string[], why: string) {
    super(`refused: ${command} ${args.join(' ')} — ${why}`)
    this.name = 'DeniedCommandError'
  }
}

const GIT_READ: ReadonlySet<string> = new Set([
  'rev-parse',
  'rev-list',
  'log',
  'describe',
  'diff',
  'status',
])
const GH_RUN_READ: ReadonlySet<string> = new Set(['list', 'view'])
/** Flags that make an otherwise read-only subcommand write somewhere. */
const WRITING_FLAG = /^--(output|ext-diff|exec|upload-pack)(=|$)/

/** Why a command is not allowed, or null when it is a permitted read. */
export function whyDenied(command: string, args: readonly string[]): string | null {
  const [first, second] = args
  if (args.some((a) => WRITING_FLAG.test(a))) return 'a flag that writes or executes'
  switch (command) {
    case 'git':
      return first !== undefined && GIT_READ.has(first)
        ? null
        : 'only git rev-parse|rev-list|log|describe|diff|status are allowed'
    case 'gh':
      return first === 'run' && second !== undefined && GH_RUN_READ.has(second)
        ? null
        : 'only `gh run list|view` is allowed (no workflow run, no rerun, no release)'
    case 'npm':
      return first === 'view'
        ? null
        : 'only `npm view` is allowed (no publish, deprecate, dist-tag)'
    default:
      return `${command} is not a release-tool command`
  }
}

export type ReleaseRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
) => Promise<ProcessResult>

export const RELEASE_COMMAND_TIMEOUT_MS = 30_000

/** Wrap a process runner so it can only run allow-listed reads. */
export function releaseRunner(base: ProcessRunner): ReleaseRunner {
  return (command, args, cwd) => {
    const why = whyDenied(command, args)
    if (why !== null) return Promise.reject(new DeniedCommandError(command, args, why))
    return base(command, args, { cwd, timeoutMs: RELEASE_COMMAND_TIMEOUT_MS })
  }
}
