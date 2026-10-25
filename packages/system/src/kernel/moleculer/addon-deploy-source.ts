/**
 * Where an agent should fetch an addon's bytes from for a `$agent.deploy`.
 * `npm`: the agent runs its own AddonInstaller pull. `hub-http`: the agent
 * streams the staged tgz from the hub's one-time-token bundle route.
 */
export type AddonDeploySource =
  | { readonly kind: 'npm'; readonly version: string }
  | {
      readonly kind: 'hub-http'
      readonly url: string
      readonly token: string
      readonly sha256: string
      readonly bytes: number
    }

export function isAddonDeploySource(v: unknown): v is AddonDeploySource {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  if (o['kind'] === 'npm') return typeof o['version'] === 'string'
  if (o['kind'] === 'hub-http') {
    return (
      typeof o['url'] === 'string' &&
      typeof o['token'] === 'string' &&
      typeof o['sha256'] === 'string' &&
      typeof o['bytes'] === 'number'
    )
  }
  return false
}
