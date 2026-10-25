// The ONE credential doorway for operator scripts (scripts/hub/hub.mjs is the other
// face of it). A script never opens a token file of its own: it asks for
// `resolveHubAuth()` and gets a bearer from the shared chain in `@camstack/develop`
// (packages/develop/src/hub/session-refresh.ts):
//   --token-file (explicit override only) -> $CAMSTACK_TOKEN -> the `camstack login`
//   session in ~/.camstack/<host>.json, renewed automatically when it is about to expire.
//
// Setup, once per hub:  camstack login <host>
//
// Usage in a script:
//   import { resolveHubAuth } from '../hub/credentials.mjs'
//   const { server, token } = await resolveHubAuth({ server: args.server, tokenFile: args['token-file'] })
//
// Needs the develop package built once: `npm run build -w packages/develop`.
import { fileURLToPath } from 'node:url'

const WORKSPACE_ROOT = fileURLToPath(new URL('../../', import.meta.url))

async function loadDevelop() {
  try {
    return await import('@camstack/develop')
  } catch (err) {
    throw new Error(
      `cannot load @camstack/develop (${err instanceof Error ? err.message : String(err)}) — run: npm run build -w packages/develop`,
    )
  }
}

/**
 * @param {{ server?: string, tokenFile?: string }} [opts] both are explicit
 *   overrides; with neither, the address comes from $CAMSTACK_HUB_URL /
 *   scratchpad/.hub-url / the session and the token from the session.
 * @returns {Promise<{ server: string, token: string, tier: 'admin' | 'protected', source: string }>}
 */
export async function resolveHubAuth(opts = {}) {
  const develop = await loadDevelop()
  const hub = develop.resolveHubUrl({
    ...(opts.server ? { explicit: opts.server } : {}),
    workspaceRoot: WORKSPACE_ROOT,
    session: develop.loadSession(),
  })
  if (!hub) {
    throw new Error(
      'no hub URL: pass --server, set CAMSTACK_HUB_URL, write scratchpad/.hub-url, or run `camstack login <host>`',
    )
  }
  const credentials = await develop.resolveFreshCredentials({
    server: hub.url,
    ...(opts.tokenFile ? { tokenFile: opts.tokenFile } : {}),
    loadSession: develop.loadSession,
  })
  if (credentials.warning) console.error(`warning: ${credentials.warning}`)
  return {
    server: hub.url,
    token: credentials.token,
    tier: credentials.tier,
    source: credentials.source,
  }
}
