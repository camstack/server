import { normalizeHubAddress } from '@dominevo/develop'

/**
 * The hub `dominevo login` was told about, canonical, or `undefined` to
 * discover. `login <host>` and `--server <host>` are the same thing; naming two
 * different hubs is an error. `$DOMINEVO_SERVER`, then `$DOMINEVO_HUB_URL`, are
 * the fallback. Every form goes through the one shared normaliser.
 */
export function resolveLoginServer(
  flag: string | undefined,
  positionals: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (positionals.length > 1) {
    throw new Error(`login takes one hub address, got: ${positionals.join(' ')}`)
  }
  const flagged = flag === undefined ? undefined : normalizeHubAddress(flag)
  const positional = positionals[0] === undefined ? undefined : normalizeHubAddress(positionals[0])
  if (flagged && positional && flagged !== positional) {
    throw new Error(
      `login got two different hubs: ${positional} (argument) and ${flagged} (--server).`,
    )
  }
  const fromEnv = env['DOMINEVO_SERVER']?.trim() || env['DOMINEVO_HUB_URL']?.trim()
  return flagged ?? positional ?? (fromEnv ? normalizeHubAddress(fromEnv) : undefined)
}
