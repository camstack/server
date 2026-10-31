/**
 * The CLI's wire for `@camstack/develop` calls (session refresh, `whoami`):
 * the same pinned-CA agent every other CLI hub call uses
 * (`hub-http.ts`).
 */
import type { HubTransport } from '@camstack/develop'
import { hubRequest } from './hub-http.js'

export const cliHubTransport: HubTransport = async (req) => {
  const res = await hubRequest(req.url, {
    method: req.method,
    headers: req.headers,
    ...(req.body !== undefined ? { body: req.body } : {}),
    timeoutMs: req.timeoutMs,
  })
  return { status: res.status, text: await res.text() }
}
