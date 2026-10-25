/**
 * The hub's address is not an environment variable.
 *
 * `CAMSTACK_HUB_PUBLIC_URL` (and its older alias `CAMSTACK_PUBLIC_ORIGIN`)
 * restated something the hub already knows: its interfaces, its listen port,
 * the operator's allowlist, its tunnel and mesh names — the `local-network`
 * capability, shown and edited on the admin Network page. A hub without the
 * variable (every Mac hub: the desktop app has no field for it) handed agents
 * `https://127.0.0.1:4443`, which names the agent, and every addon and model
 * pull to an agent failed. Every reader now asks `local-network`
 * (`getAddresses().roles`); nothing reads the variables.
 *
 * A container that still sets one gets a WARN on every boot naming it as
 * ignored, and the variable is removed from this process's environment before
 * any addon runner is forked — so no child can grow a new reader of it.
 */

/** Variables that used to name the hub's address; all ignored now. */
export const RETIRED_HUB_ADDRESS_ENVS = [
  'CAMSTACK_HUB_PUBLIC_URL',
  'CAMSTACK_PUBLIC_ORIGIN',
] as const

/**
 * Remove every retired address variable from `env` and return the warning to
 * log once a logger exists, or `undefined` when none was set.
 */
export function dropRetiredHubAddressEnv(env: NodeJS.ProcessEnv): string | undefined {
  const present = RETIRED_HUB_ADDRESS_ENVS.filter((name) => {
    const value = env[name]
    return value !== undefined && value.trim() !== ''
  })
  for (const name of RETIRED_HUB_ADDRESS_ENVS) delete env[name]
  if (present.length === 0) return undefined
  return (
    `${present.join(' and ')} ${present.length === 1 ? 'is' : 'are'} ignored — the hub address ` +
    'comes from Network (Settings → Network). Remove it from this container.'
  )
}
