/**
 * Lightweight tRPC HTTP client for E2E suites.
 *
 * Avoids `@trpc/client` here so the harness has zero compile-time coupling
 * to the server's tRPC version. The wire format is stable: a tRPC v11
 * batched HTTP request is just a POST with `{"0":{"json":<input>}}`.
 *
 * Each helper hits a known router method and returns the unwrapped
 * `result.data.json` payload. Self-signed cert is tolerated via a custom
 * https agent — this is the dev cluster's posture.
 */
import * as https from 'node:https'
import { URL } from 'node:url'

const insecureAgent = new https.Agent({ rejectUnauthorized: false })

export interface AuthorizedClient {
  readonly port: number
  readonly token: string
}

export interface RawResponse {
  status: number
  body: string
}

interface TrpcSuccessFrame<T> {
  result: { data: { json: T } }
}

interface TrpcErrorFrame {
  error: {
    json: {
      message: string
      code?: number
      data?: Record<string, unknown>
    }
  }
}

type TrpcFrame<T> = TrpcSuccessFrame<T> | TrpcErrorFrame

function buildUrl(port: number, procedure: string): string {
  return `https://localhost:${port}/trpc/${procedure}?batch=1`
}

async function rawRequest(
  port: number,
  method: 'GET' | 'POST',
  procedure: string,
  body: unknown,
  token: string | undefined,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(buildUrl(port, procedure))
    if (method === 'GET' && body !== undefined) {
      url.searchParams.set('input', JSON.stringify(body))
    }
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    }
    if (token) headers['authorization'] = `Bearer ${token}`
    const req = https.request(url, { method, agent: insecureAgent, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf-8'),
        })
      })
    })
    req.on('error', reject)
    req.setTimeout(30_000, () => {
      req.destroy(new Error(`Timeout calling ${procedure}`))
    })
    if (method === 'POST' && body !== undefined) {
      req.write(JSON.stringify(body))
    }
    req.end()
  })
}

function unwrap<T>(raw: RawResponse, procedure: string): T {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.body)
  } catch (err) {
    throw new Error(
      `[trpc] ${procedure} → status ${raw.status}, body not JSON: ${raw.body.slice(0, 200)}`,
      { cause: err },
    )
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`[trpc] ${procedure} → unexpected envelope: ${raw.body.slice(0, 200)}`)
  }
  const frame = parsed[0] as TrpcFrame<T>
  if ('error' in frame) {
    throw new Error(
      `[trpc] ${procedure} → ${frame.error.json.message ?? 'unknown error'} ` +
        `(status ${raw.status})`,
    )
  }
  return frame.result.data.json
}

/** Mutation. */
export async function trpcMutation<T>(
  port: number,
  procedure: string,
  input: unknown,
  token?: string,
): Promise<T> {
  const body = { '0': { json: input } }
  const raw = await rawRequest(port, 'POST', procedure, body, token)
  return unwrap<T>(raw, procedure)
}

/** Query (GET). */
export async function trpcQuery<T>(
  port: number,
  procedure: string,
  input: unknown,
  token?: string,
): Promise<T> {
  const body = { '0': { json: input } }
  const raw = await rawRequest(port, 'GET', procedure, body, token)
  return unwrap<T>(raw, procedure)
}

interface LoginResult {
  token: string
  user: { id: string; username: string; role: string }
}

export async function loginAs(port: number, username: string, password: string): Promise<string> {
  const result = await trpcMutation<LoginResult>(port, 'auth.login', { username, password })
  return result.token
}

/** Convenience: log in with the seeded admin. */
export async function loginAsAdmin(port: number, password = 'changeme'): Promise<AuthorizedClient> {
  const token = await loginAs(port, 'admin', password)
  return { port, token }
}

// --- Domain helpers -----------------------------------------------------

export interface AddonListItem {
  manifest: {
    id?: string
    packageName: string
    protected?: boolean
    [k: string]: unknown
  }
  declaration?: unknown
  source: string
  installSource?: string
  process?: { state: string; pid?: number; mode?: string }
}

export async function listAddons(client: AuthorizedClient): Promise<readonly AddonListItem[]> {
  return trpcQuery<readonly AddonListItem[]>(client.port, 'addons.list', undefined, client.token)
}

export interface StorageLocation {
  id: string
  type: string
  providerId: string
  isDefault: boolean
  displayName?: string
  config?: Record<string, unknown>
}

export async function listStorageLocations(
  client: AuthorizedClient,
): Promise<readonly StorageLocation[]> {
  return trpcQuery<readonly StorageLocation[]>(
    client.port,
    'storage.listLocations',
    undefined,
    client.token,
  )
}

export interface IntegrationRecord {
  id: string
  addonId: string
  name: string
  enabled: boolean
  info: Record<string, unknown>
  createdAt: number
  updatedAt: number
  processState?: string
}

export async function listIntegrations(
  client: AuthorizedClient,
): Promise<readonly IntegrationRecord[]> {
  return trpcQuery<readonly IntegrationRecord[]>(
    client.port,
    'integrations.list',
    undefined,
    client.token,
  )
}

export async function getAvailableIntegrationTypes(
  client: AuthorizedClient,
): Promise<readonly { id: string; name: string }[]> {
  return trpcQuery(client.port, 'integrations.getAvailableTypes', undefined, client.token)
}

/** GET helper for arbitrary asset URLs (e.g. /assets/<addon>/icon.svg). */
export async function fetchAsset(port: number, pathname: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      `https://localhost:${port}${pathname}`,
      { method: 'GET', agent: insecureAgent },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf-8'),
          })
        })
      },
    )
    req.on('error', reject)
    req.setTimeout(10_000, () => {
      req.destroy(new Error(`Timeout fetching ${pathname}`))
    })
    req.end()
  })
}

interface HealthBody {
  ok: boolean
  uptimeSeconds: number
  nodeId?: string
}

function parseHealthBody(raw: string): HealthBody | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { ok?: unknown }).ok === 'boolean' &&
      typeof (parsed as { uptimeSeconds?: unknown }).uptimeSeconds === 'number'
    ) {
      return parsed as HealthBody
    }
    return null
  } catch {
    return null
  }
}

/** GET /health on the hub. Self-signed cert tolerant. */
export async function fetchHealth(port: number): Promise<{
  status: number
  body: HealthBody | null
}> {
  const raw = await fetchAsset(port, '/health')
  return { status: raw.status, body: parseHealthBody(raw.body) }
}
