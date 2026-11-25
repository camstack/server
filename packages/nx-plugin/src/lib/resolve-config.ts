import { loadSession, resolveFreshCredentials } from '@camstack/develop'
import type { CredentialInputs } from '@camstack/develop'

/**
 * Resolved deploy configuration. The credential is the `camstack login`
 * session and nothing else (D1101): no executor token, no `$CAMSTACK_TOKEN`,
 * no rc file. The address is the executor `server` option, `$CAMSTACK_SERVER`,
 * or the session's own hub.
 */
export interface ResolvedDeployConfig {
  readonly server: string
  readonly token: string
}

export interface ResolveInputs {
  readonly server?: string
  /** Override `process.env` for tests. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Override the session lookup for tests. */
  readonly loadSession?: CredentialInputs['loadSession']
}

/** Throws `MissingCredentialsError` (it names `camstack login`) when there is no session. */
export async function resolveDeployConfig(inputs: ResolveInputs): Promise<ResolvedDeployConfig> {
  const creds = await resolveFreshCredentials({
    ...(inputs.server !== undefined ? { server: inputs.server } : {}),
    ...(inputs.env !== undefined ? { env: inputs.env } : {}),
    loadSession: inputs.loadSession ?? ((server) => loadSession(server ?? '')),
  })
  if (creds.server === undefined) {
    throw new Error(
      'No hub address: pass `server`, set $CAMSTACK_SERVER, or run `camstack login <host>`.',
    )
  }
  return { server: creds.server.replace(/\/+$/, ''), token: creds.token }
}
