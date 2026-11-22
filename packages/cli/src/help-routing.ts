/**
 * Which command an argv names, and whether it asked for help. Every command
 * answers `--help`, whichever side of the name the flag lands on, and
 * `camstack help [cmd]` is the same ask: a help request is never "Unknown command".
 */
export const HELP_FLAGS: ReadonlySet<string> = new Set(['-h', '--help'])

export interface NamedCommand {
  readonly name: string
  readonly aliases?: readonly string[]
}

export type Invocation<C extends NamedCommand> =
  | { readonly kind: 'global-help' }
  | { readonly kind: 'command-help'; readonly command: C }
  | { readonly kind: 'unknown'; readonly name: string }
  | { readonly kind: 'run'; readonly command: C; readonly args: readonly string[] }

function find<C extends NamedCommand>(commands: readonly C[], name: string): C | undefined {
  return commands.find((c) => c.name === name || (c.aliases?.includes(name) ?? false))
}

export function resolveInvocation<C extends NamedCommand>(
  argv: readonly string[],
  commands: readonly C[],
): Invocation<C> {
  const first = argv[0] ?? ''
  if (argv.length === 0) return { kind: 'global-help' }
  // `camstack --help <cmd>` and `camstack help <cmd>`: the command is the next word.
  if (HELP_FLAGS.has(first) || first === 'help') {
    const named = argv.slice(1).find((a) => !HELP_FLAGS.has(a))
    if (named === undefined) return { kind: 'global-help' }
    const command = find(commands, named)
    return command ? { kind: 'command-help', command } : { kind: 'unknown', name: named }
  }
  const command = find(commands, first)
  if (!command) return { kind: 'unknown', name: first }
  const args = argv.slice(1)
  if (args.some((a) => HELP_FLAGS.has(a))) return { kind: 'command-help', command }
  return { kind: 'run', command, args }
}
