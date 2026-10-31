/**
 * The one place an MCP tool answer becomes a protocol result. A tool that
 * could not do its job answers with a typed `{ status }`; the protocol must
 * also say it failed (`isError: true`), or an assistant reads the failure as
 * data. A thrown error is already an `isError` result (the SDK catches it).
 */
import { text as plainText, textError } from '@camstack/develop'
import type { ToolTextResult } from './context.js'

/** Top-level `status` values that mean "this call did not do what was asked". */
const FAILURE_STATUSES: ReadonlySet<string> = new Set([
  'no-session',
  'refused',
  'failed',
  'fetch-failed',
  'unreachable',
  'invalid-address',
  'unsupported',
  'unavailable',
  'not-exposed',
])

export function isFailureResult(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const status: unknown = Reflect.get(value, 'status')
  return typeof status === 'string' && FAILURE_STATUSES.has(status)
}

/** Drop-in for `text()`: the same scrubbed JSON body, `isError` set on a failure. */
export function text(value: unknown): ToolTextResult {
  const ok = plainText(value)
  if (!isFailureResult(value)) return ok
  const body = ok.content[0]?.text ?? ''
  return textError(body)
}
