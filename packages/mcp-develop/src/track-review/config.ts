/**
 * How the MCP finds its hub: three environment variables, no flags, no files
 * of its own. TLS verification is never disabled — a self-signed hub is trusted
 * by naming its CA (`CAMSTACK_HUB_CA_FILE`), not by switching checking off.
 */
import { createHubClient, readTokenFile, resolveHubTls, resolveHubUrl } from '@camstack/develop'
import { createReviewHub, type ReviewHub } from './hub-api.js'

type Env = Readonly<Record<string, string | undefined>>

export class HubConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HubConfigError'
  }
}

export function resolveReviewHub(env: Env = process.env): ReviewHub {
  const resolved = resolveHubUrl({ env })
  if (resolved === undefined) {
    throw new HubConfigError('Set CAMSTACK_HUB_URL (e.g. https://hub.local:4443) to reach a hub.')
  }
  const inline = env['CAMSTACK_HUB_TOKEN']?.trim()
  const file = env['CAMSTACK_HUB_TOKEN_FILE']?.trim()
  let token: string | undefined = inline !== undefined && inline !== '' ? inline : undefined
  if (token === undefined && file !== undefined && file !== '') token = readTokenFile(file).token
  if (token === undefined) {
    throw new HubConfigError(
      'Set CAMSTACK_HUB_TOKEN_FILE (preferred: a file holding one token) or CAMSTACK_HUB_TOKEN. ' +
        'The write tools need an admin token.',
    )
  }
  const client = createHubClient({
    baseUrl: resolved.url,
    token,
    tls: resolveHubTls(resolved.url, env),
  })
  return createReviewHub(client)
}
