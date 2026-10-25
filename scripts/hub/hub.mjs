// Generic tRPC caller against YOUR hub — through the shared credential chain.
//
// Usage: node scripts/hub/hub.mjs <GET|POST> <path> '<json>'   ('-' as the JSON reads it from stdin)
//        node scripts/hub/hub.mjs --token-file <f> <GET|POST> <path> '<json>'
//        node scripts/hub/hub.mjs --server <url> ...
//
// No password, no login, no certificate bypass (D835). ONE token format; only the
// permissions differ. Run `camstack login <host>` once: every tool uses that session
// (~/.camstack/<host>.json), renewed automatically when it is about to expire, and a
// 401 renews it once and retries once. The chain (`@camstack/develop`,
// packages/develop/src/hub):
//   1. --token-file <f>        an explicit override only (a bare token or a session file)
//   2. $CAMSTACK_TOKEN
//   3. the `camstack login` session
// This script never looks for a token file of its own.
//
// --server takes a host, host:port or https URL (normalised by the shared
// normalizeHubAddress in @camstack/develop; port defaults to 4443).
// The hub address is never in this file: --server, else $CAMSTACK_HUB_URL, else
// the gitignored scratchpad/.hub-url (one line, https://<hub-host>:4443), else
// the cached session's server.
//
// TLS stays on. A hub with a private certificate is trusted by saving its PEM (or the issuing CA, e.g. mkcert rootCA.pem)
// to ~/.camstack/<host>.ca.pem (or $CAMSTACK_HUB_CA_FILE); a failure prints
// the exact command.
//
// Needs the develop package built once: `npm run build -w packages/develop`.
import { fileURLToPath } from 'node:url'

let develop
try {
  develop = await import('@camstack/develop')
} catch (err) {
  console.error(
    `cannot load @camstack/develop (${err instanceof Error ? err.message : String(err)}) — run: npm run build -w packages/develop`,
  )
  process.exit(1)
}
const {
  createHubClient,
  HubHttpError,
  HubRpcError,
  loadSession,
  MissingCredentialsError,
  refreshOnUnauthorized,
  resolveFreshCredentials,
  resolveHubTls,
  resolveHubUrl,
  withAuthHint,
} = develop

const WORKSPACE_ROOT = fileURLToPath(new URL('../../', import.meta.url))
// The hub runs near its RAM/CPU limit and a rebuild pins it harder: a busy hub
// is slow to answer, which must not read as "the hub is down".
const TIMEOUT_MS = 180_000

function takeFlag(argv, name) {
  const at = argv.indexOf(name)
  if (at === -1) return undefined
  const value = argv[at + 1]
  if (value === undefined || value.startsWith('--')) {
    console.error(`${name} needs a value`)
    process.exit(1)
  }
  argv.splice(at, 2)
  return value
}

const argv = process.argv.slice(2)
const tokenFile = takeFlag(argv, '--token-file')
const serverFlag = takeFlag(argv, '--server')
const [method, route, rawInput] = argv

if (method === 'login') {
  console.error(
    'hub.mjs no longer logs in with a password. Use `camstack login` (cached session at ~/.camstack/<host>.json).',
  )
  process.exit(1)
}
if ((method !== 'GET' && method !== 'POST') || !route) {
  console.error("usage: hub.mjs [--token-file <f>] [--server <host>] <GET|POST> <path> '<json>'")
  process.exit(1)
}

const hub = resolveHubUrl({
  explicit: serverFlag,
  workspaceRoot: WORKSPACE_ROOT,
  session: loadSession(),
})
if (!hub) {
  console.error(
    'no hub URL: pass --server, set CAMSTACK_HUB_URL, write scratchpad/.hub-url, or run `camstack login`',
  )
  process.exit(1)
}

let credentials
try {
  credentials = await resolveFreshCredentials({
    server: hub.url,
    ...(tokenFile ? { tokenFile } : {}),
    loadSession,
  })
} catch (err) {
  console.error(err instanceof MissingCredentialsError ? err.message : String(err))
  process.exit(1)
}
if (credentials.warning) console.error(`warning: ${credentials.warning}`)

const client = createHubClient({
  baseUrl: hub.url,
  token: credentials.token,
  tls: resolveHubTls(hub.url),
  timeoutMs: TIMEOUT_MS,
  ...(credentials.source === 'session'
    ? { onUnauthorized: refreshOnUnauthorized({ server: hub.url, tls: resolveHubTls(hub.url) }) }
    : {}),
})

// `-` reads the JSON from stdin: a large input (a batch of rows) must never travel
// through argv, whose limit is far below what a Fastify body accepts.
async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf-8')
}

let input
try {
  const text = rawInput === '-' ? await readStdin() : rawInput
  input = text ? JSON.parse(text) : undefined
} catch {
  console.error('the input is not valid JSON')
  process.exit(1)
}

for (let attempt = 1; ; attempt += 1) {
  try {
    console.log(JSON.stringify(await client.call(method, route, input), null, 2))
    break
  } catch (err) {
    if (err instanceof HubRpcError || err instanceof HubHttpError) {
      console.error(withAuthHint(`ERROR ${err.message}`, err.status, credentials.source))
      process.exit(1)
    }
    // A TLS explanation or an oversized response is not transient.
    const transient =
      err instanceof Error &&
      !err.message.startsWith('TLS verification') &&
      !err.message.includes('response larger than')
    if (!transient || attempt >= 4) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
    await new Promise((res) => setTimeout(res, 3000 * attempt))
  }
}
