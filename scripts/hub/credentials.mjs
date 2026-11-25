// The ONE credential doorway for operator scripts (scripts/hub/hub.mjs is the other
// face of it). A script never opens a token file of its own and never logs in with a
// password: it asks for `resolveHubAuth()` and gets a bearer from the `camstack login`
// session in ~/.camstack/<host>_<port>.json, renewed automatically when it is about to
// expire (packages/develop/src/hub/session-refresh.ts). Nothing else is a credential
// (D1101): no token flag, no token file, no environment token.
//
// Setup, once per hub, interactively:  camstack login <host>
//
// Usage in a script:
//   import { resolveHubAuth } from '../hub/credentials.mjs'
//   const { server, token } = await resolveHubAuth({ server: args.server })
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
 * @param {{ server?: string }} [opts] an explicit hub ADDRESS; without it the address
 *   comes from $CAMSTACK_HUB_URL / scratchpad/.hub-url / the session. The token always
 *   comes from the session.
 * @returns {Promise<{ server: string, token: string, tier: 'admin' | 'protected', source: 'session' }>}
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
    loadSession: develop.loadSession,
  })
  return {
    server: hub.url,
    token: credentials.token,
    tier: credentials.tier,
    source: credentials.source,
  }
}
