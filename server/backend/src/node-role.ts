export type NodeRole = 'hub' | 'agent'

export function resolveNodeRole(env: NodeJS.ProcessEnv): NodeRole {
  const raw = (env['CAMSTACK_ROLE'] ?? '').trim().toLowerCase()
  if (raw === '' || raw === 'hub') return 'hub'
  if (raw === 'agent') return 'agent'
  throw new Error(`Invalid CAMSTACK_ROLE "${raw}" — expected "hub" or "agent"`)
}
