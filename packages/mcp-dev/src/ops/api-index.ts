/**
 * The hub's method catalogue as the repository generates it
 * (`docs/reference/api.md`, "Method index": tRPC path | kind | auth | capability).
 *
 * `hub_query` trusts this table and nothing else for "is it a query?" and "what
 * tier does it need?" — a method the generator did not emit is refused, which is
 * also how a hallucinated path is caught before it reaches the hub.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export type MethodKind = 'query' | 'mutation' | 'subscription'
export type MethodAuth = 'public' | 'protected' | 'admin'

export interface ApiMethod {
  readonly path: string
  readonly kind: MethodKind
  readonly auth: MethodAuth
  readonly capability: string
}

export type ApiIndex = ReadonlyMap<string, ApiMethod>

const ROW = /^\|\s*`([A-Za-z0-9_.]+)`\s*\|\s*(\w+)\s*\|\s*(\w+)\s*\|\s*([^|]+?)\s*\|\s*$/

function isKind(value: string): value is MethodKind {
  return value === 'query' || value === 'mutation' || value === 'subscription'
}

function isAuth(value: string): value is MethodAuth {
  return value === 'public' || value === 'protected' || value === 'admin'
}

/** Parse the method-index table out of the generated api.md text. */
export function parseApiIndex(markdown: string): ApiIndex {
  const out = new Map<string, ApiMethod>()
  for (const line of markdown.split('\n')) {
    const m = ROW.exec(line)
    if (!m) continue
    const [, methodPath, kind, auth, capability] = m
    if (!methodPath || !kind || !auth || !capability) continue
    if (!isKind(kind) || !isAuth(auth)) continue
    if (out.has(methodPath)) continue
    out.set(methodPath, { path: methodPath, kind, auth, capability })
  }
  return out
}

/**
 * Fixed core routers that are not capabilities (so not in the generated table):
 * the in-RAM log ring and the capability registry's read side. All admin-tier.
 */
export const CORE_QUERY_METHODS: readonly ApiMethod[] = [
  { path: 'logs.query', kind: 'query', auth: 'admin', capability: '(core) logs' },
  { path: 'capabilities.listCapabilities', kind: 'query', auth: 'admin', capability: '(core)' },
  { path: 'capabilities.getCapability', kind: 'query', auth: 'admin', capability: '(core)' },
  {
    path: 'capabilities.getDeviceCapabilities',
    kind: 'query',
    auth: 'admin',
    capability: '(core)',
  },
]

export function loadApiIndex(workspaceRoot: string): ApiIndex {
  const file = path.join(workspaceRoot, 'docs', 'reference', 'api.md')
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (err) {
    throw new Error(
      `cannot read ${file} — run \`npm run docs:generate\` in the CamStack checkout (the ops tools take the method catalogue from it)`,
      { cause: err },
    )
  }
  const index = new Map(parseApiIndex(text))
  for (const core of CORE_QUERY_METHODS) index.set(core.path, core)
  return index
}
