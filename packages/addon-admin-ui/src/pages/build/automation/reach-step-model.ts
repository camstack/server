/**
 * The pure edits of the `probe` and `http-request` steps: their blank forms,
 * the headers as rows, and the expectation as a form. A field left empty is
 * dropped from the step rather than saved as `''` or `0`.
 */
import {
  type AutomationHttpExpect,
  type AutomationHttpRequestStep,
  type AutomationProbeStep,
  HTTP_HEADERS_MAX,
} from '@camstack/types'

export type HttpHeaders = NonNullable<AutomationHttpRequestStep['headers']>

export function newProbe(): AutomationProbeStep {
  return { kind: 'probe', host: '', port: 80, timeoutSeconds: 5 }
}

export function newHttpRequest(): AutomationHttpRequestStep {
  return { kind: 'http-request', method: 'GET', url: '', timeoutSeconds: 10 }
}

// ── optional fields: blank means absent ────────────────────────────────────

export function probeRetry(
  step: AutomationProbeStep,
  seconds: number | undefined,
): AutomationProbeStep {
  const { retryUntilSeconds: _old, ...rest } = step
  return seconds === undefined ? rest : { ...rest, retryUntilSeconds: seconds }
}

export function probeSaveAs(step: AutomationProbeStep, name: string): AutomationProbeStep {
  const { saveAs: _old, ...rest } = step
  return name === '' ? rest : { ...rest, saveAs: name }
}

export function probeExpect(
  step: AutomationProbeStep,
  expect: AutomationProbeStep['expect'],
): AutomationProbeStep {
  const { expect: _old, ...rest } = step
  return expect === undefined ? rest : { ...rest, expect }
}

export function httpRetry(
  step: AutomationHttpRequestStep,
  seconds: number | undefined,
): AutomationHttpRequestStep {
  const { retryUntilSeconds: _old, ...rest } = step
  return seconds === undefined ? rest : { ...rest, retryUntilSeconds: seconds }
}

export function httpSaveAs(
  step: AutomationHttpRequestStep,
  name: string,
): AutomationHttpRequestStep {
  const { saveAs: _old, ...rest } = step
  return name === '' ? rest : { ...rest, saveAs: name }
}

export function httpBody(step: AutomationHttpRequestStep, body: string): AutomationHttpRequestStep {
  const { body: _old, ...rest } = step
  return body === '' ? rest : { ...rest, body }
}

export function httpHeaders(
  step: AutomationHttpRequestStep,
  headers: HttpHeaders | undefined,
): AutomationHttpRequestStep {
  const { headers: _old, ...rest } = step
  return headers === undefined ? rest : { ...rest, headers }
}

export function httpExpect(
  step: AutomationHttpRequestStep,
  expect: AutomationHttpExpect | undefined,
): AutomationHttpRequestStep {
  const { expect: _old, ...rest } = step
  return expect === undefined ? rest : { ...rest, expect }
}

/** A whole number from a field's text; `undefined` when it is blank or not a number. */
export function wholeNumber(text: string): number | undefined {
  if (text.trim() === '') return undefined
  const n = Number(text)
  return Number.isFinite(n) ? Math.trunc(n) : undefined
}

// ── headers as rows ─────────────────────────────────────────────────────────

export interface HeaderRow {
  readonly name: string
  readonly value: string
}

export function headerRows(headers: HttpHeaders | undefined): readonly HeaderRow[] {
  return Object.entries(headers ?? {}).map(([name, value]) => ({ name, value }))
}

function fromRows(rows: readonly HeaderRow[]): HttpHeaders | undefined {
  return rows.length === 0 ? undefined : Object.fromEntries(rows.map((r) => [r.name, r.value]))
}

export function canAddHeader(headers: HttpHeaders | undefined): boolean {
  const names = Object.keys(headers ?? {})
  return !names.includes('') && names.length < HTTP_HEADERS_MAX
}

export function addHeader(headers: HttpHeaders | undefined): HttpHeaders {
  return canAddHeader(headers) ? { ...headers, '': '' } : (headers ?? {})
}

/** Rename row `index`, keeping its place and value; the same headers when the name is taken. */
export function renameHeader(
  headers: HttpHeaders | undefined,
  index: number,
  name: string,
): HttpHeaders | undefined {
  const rows = headerRows(headers)
  if (rows.some((row, i) => i !== index && row.name.toLowerCase() === name.toLowerCase())) {
    return headers
  }
  return fromRows(rows.map((row, i) => (i === index ? { ...row, name } : row)))
}

export function setHeaderValue(
  headers: HttpHeaders | undefined,
  index: number,
  value: string,
): HttpHeaders | undefined {
  return fromRows(headerRows(headers).map((row, i) => (i === index ? { ...row, value } : row)))
}

export function removeHeader(
  headers: HttpHeaders | undefined,
  index: number,
): HttpHeaders | undefined {
  return fromRows(headerRows(headers).filter((_, i) => i !== index))
}

// ── the expectation ─────────────────────────────────────────────────────────

/** What a freshly switched-on expectation says: a 2xx answer. */
export const DEFAULT_HTTP_EXPECT: AutomationHttpExpect = {
  on: 'status',
  operator: 'eq',
  value: 200,
}

/**
 * The value field's text as the expectation's value: a status is always a
 * number; a JSON field keeps a number or `true`/`false` that was typed as such,
 * and any other text as text (an empty string is a value: "not empty").
 */
export function expectValueOf(
  on: AutomationHttpExpect['on'],
  text: string,
): string | number | boolean {
  if (on === 'status') return wholeNumber(text) ?? 0
  if (text === 'true') return true
  if (text === 'false') return false
  const n = Number(text)
  return text.trim() !== '' && Number.isFinite(n) ? n : text
}

/** Switch the expectation to read the status or a JSON field, keeping a sensible comparison. */
export function expectOn(
  expect: AutomationHttpExpect,
  on: AutomationHttpExpect['on'],
): AutomationHttpExpect {
  if (on === expect.on) return expect
  if (on === 'status') return { ...DEFAULT_HTTP_EXPECT }
  return { on: 'json', fieldPath: '', operator: 'ne', value: '' }
}
