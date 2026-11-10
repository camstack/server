import type { EnpalConnection } from './config.js'
import {
  BlazorBridgeError,
  type BlazorBackoff,
  blazorRowsToReadings,
  blazorRowsToTexts,
  type BlazorReader,
} from './enpal-blazor.js'
import { parseDeviceMessages } from './enpal-device-page.js'
import { parseFluxCsv } from './enpal-flux-csv.js'
import {
  createSnapshot,
  type EnpalErrorKind,
  type EnpalFallbackReason,
  type EnpalReading,
  type EnpalSnapshot,
  type EnpalSourceKind,
  type EnpalText,
} from './enpal-snapshot.js'

/** The slice of `fetch` the client uses, so a test hands in a fake box. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** The box answers in well under this; its CPU is small, so a slow answer is a failure. */
const REQUEST_TIMEOUT_MS = 20_000

/**
 * A failed read of the box, by cause. The message names the host and the status only: it is
 * built here, never from the transport error, because that text can echo request headers and
 * the access token is one of them.
 */
export class EnpalError extends Error {
  readonly kind: EnpalErrorKind
  readonly source: EnpalSourceKind

  constructor(kind: EnpalErrorKind, source: EnpalSourceKind, message: string) {
    super(message)
    this.name = 'EnpalError'
    this.kind = kind
    this.source = source
  }
}

/** What one source returned: the numbers, and the text rows when the source carries them. */
interface SourceRead {
  readonly readings: EnpalReading[]
  readonly texts: readonly EnpalText[]
}

export interface ReadEnpalSnapshotInput {
  readonly connection: EnpalConnection
  /** The token is stored but the keychain cannot serve it right now. */
  readonly tokenLocked?: boolean
  readonly fetch: FetchLike
  /** The Python bridge to the box's Blazor channel; absent while Python is unavailable. */
  readonly blazor?: BlazorReader
  /** Shared across polls: `auto` skips a Blazor channel that failed recently. */
  readonly blazorBackoff?: BlazorBackoff
  readonly now: () => number
}

function describeFailure(error: unknown): 'timeout' | 'unreachable' {
  const name = error instanceof Error ? error.name : ''
  return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable'
}

async function request(
  source: EnpalSourceKind,
  host: string,
  url: string,
  init: RequestInit,
  fetchFn: FetchLike,
): Promise<string> {
  let response: Response
  try {
    response = await fetchFn(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    const kind = describeFailure(error)
    throw new EnpalError(
      kind,
      source,
      kind === 'timeout'
        ? `Enpal box ${host} did not answer within ${REQUEST_TIMEOUT_MS / 1000}s`
        : `Enpal box ${host} is unreachable`,
    )
  }
  if (response.status === 401 || response.status === 403) {
    throw new EnpalError(
      'unauthorized',
      source,
      `Enpal box ${host} refused the credentials (HTTP ${response.status})`,
    )
  }
  if (!response.ok) {
    throw new EnpalError(
      'bad-response',
      source,
      `Enpal box ${host} answered HTTP ${response.status}`,
    )
  }
  return response.text()
}

async function readInflux(input: ReadEnpalSnapshotInput): Promise<SourceRead> {
  const { connection } = input
  if (input.tokenLocked === true) {
    throw new EnpalError(
      'token-missing',
      'influxdb',
      'The InfluxDB token is stored but the keychain cannot serve it right now',
    )
  }
  if (connection.token.trim().length === 0) {
    throw new EnpalError('token-missing', 'influxdb', 'No InfluxDB token is set')
  }
  const url = `http://${connection.host}:${connection.influxPort}/api/v2/query?org=${encodeURIComponent(connection.org)}`
  // One query per poll: the box has a small CPU. `last()` over two hours drops series that
  // stopped writing, so a stale series is not reported as current.
  const flux = `from(bucket: "${connection.bucket}") |> range(start: -2h) |> last()`
  const body = await request(
    'influxdb',
    connection.host,
    url,
    {
      method: 'POST',
      body: flux,
      headers: {
        Authorization: `Token ${connection.token}`,
        'Content-Type': 'application/vnd.flux',
        Accept: 'application/csv',
      },
    },
    input.fetch,
  )
  const readings = parseFluxCsv(body)
  if (readings.length === 0) {
    throw new EnpalError(
      'empty',
      'influxdb',
      `Enpal InfluxDB on ${connection.host} returned no series for bucket "${connection.bucket}" in the last two hours`,
    )
  }
  return { readings, texts: [] }
}

async function readBlazor(input: ReadEnpalSnapshotInput): Promise<SourceRead> {
  const { connection } = input
  if (input.blazor === undefined) {
    throw new EnpalError(
      'bridge-unavailable',
      'blazor',
      'The embedded Python the Enpal bridge needs is not available on this node',
    )
  }
  let readings: EnpalReading[]
  let texts: EnpalText[]
  try {
    const rows = await input.blazor({
      host: connection.host,
      port: connection.pagePort,
    })
    readings = blazorRowsToReadings(rows)
    texts = blazorRowsToTexts(rows)
  } catch (error) {
    if (!(error instanceof BlazorBridgeError)) throw error
    const kind: EnpalErrorKind = error.kind === 'protocol' ? 'bad-response' : error.kind
    throw new EnpalError(kind, 'blazor', error.message)
  }
  if (readings.length === 0) {
    throw new EnpalError(
      'empty',
      'blazor',
      `Enpal box ${connection.host} sent no numeric sensor rows`,
    )
  }
  return { readings, texts }
}

async function readPage(input: ReadEnpalSnapshotInput): Promise<SourceRead> {
  const { connection } = input
  const url = `http://${connection.host}:${connection.pagePort}/deviceMessages`
  const body = await request('device-page', connection.host, url, { method: 'GET' }, input.fetch)
  const readings = parseDeviceMessages(body)
  if (readings.length === 0) {
    throw new EnpalError(
      'empty',
      'device-page',
      `The device page of ${connection.host} lists no device rows (firmware 8.51 and later render them only through the web socket)`,
    )
  }
  return { readings, texts: [] }
}

function reasonOf(error: EnpalError): EnpalFallbackReason {
  return { kind: error.kind, message: error.message }
}

const READERS: Readonly<
  Record<EnpalSourceKind, (input: ReadEnpalSnapshotInput) => Promise<SourceRead>>
> = {
  blazor: readBlazor,
  influxdb: readInflux,
  'device-page': readPage,
}

/** One reason from several: the kind of the first real failure, every message. */
function joinReasons(reasons: readonly EnpalFallbackReason[]): EnpalFallbackReason | undefined {
  if (reasons.length === 0) return undefined
  const kind = reasons.find((r) => r.kind !== 'bridge-unavailable')?.kind ?? 'bridge-unavailable'
  return { kind, message: reasons.map((r) => r.message).join('; ') }
}

const PYTHON_MISSING: EnpalFallbackReason = {
  kind: 'bridge-unavailable',
  message:
    'Python is not available on this node, so the box web channel (the only complete source on firmware 8.51 and later) is not used',
}

/**
 * Read every data point the box reports, once. `auto` tries the Blazor channel first (the
 * only one that carries the device tables on firmware 8.51 and later, no credential), then
 * InfluxDB when a token is set, then the device page. The snapshot records why a preferred
 * source was not used: Python missing, the channel skipped after a recent failure, or the
 * failure itself. A Blazor failure in `auto` is remembered for {@link BLAZOR_BACKOFF_MS}.
 * When every source fails the FIRST real failure is the one reported. A failed read throws
 * {@link EnpalError}: it never yields a snapshot of zeros.
 */
export async function readEnpalSnapshot(input: ReadEnpalSnapshotInput): Promise<EnpalSnapshot> {
  const { source: mode } = input.connection
  const now = input.now()
  const hasToken = input.tokenLocked !== true && input.connection.token.trim().length > 0
  const reasons: EnpalFallbackReason[] = []
  let first: EnpalError | undefined
  const order: EnpalSourceKind[] = []

  if (mode === 'blazor') order.push('blazor')
  else if (mode === 'influx') order.push('influxdb')
  else if (mode === 'page') order.push('device-page')
  else {
    if (input.blazor === undefined) reasons.push(PYTHON_MISSING)
    else {
      const skip = input.blazorBackoff?.skipReason(now) ?? null
      if (skip !== null) reasons.push(skip)
      else order.push('blazor')
    }
    if (hasToken) order.push('influxdb')
    order.push('device-page')
  }

  for (const source of order) {
    try {
      const read = await READERS[source](input)
      if (source === 'blazor') input.blazorBackoff?.recovered()
      return createSnapshot(source, read.readings, now, joinReasons(reasons), read.texts)
    } catch (error) {
      if (!(error instanceof EnpalError)) throw error
      if (source === 'blazor' && mode === 'auto') {
        input.blazorBackoff?.failed(now, reasonOf(error))
      }
      first ??= error
      reasons.push(reasonOf(error))
    }
  }
  if (first === undefined) throw new Error('readEnpalSnapshot: no source to read')
  throw first
}
