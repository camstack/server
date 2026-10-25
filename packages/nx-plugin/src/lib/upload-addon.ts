import * as fs from 'node:fs'
import * as path from 'node:path'
import FormData from 'form-data'

/** Undici accepts node `form-data` as a streaming body when `duplex: 'half'`. */
export interface MultipartUploadInit {
  readonly method: 'POST'
  readonly headers: Record<string, string>
  readonly body: FormData
  readonly duplex: 'half'
}

export type MultipartFetch = (url: string | URL, init: MultipartUploadInit) => Promise<Response>

function nodeMultipartFetch(url: string | URL, init: MultipartUploadInit): Promise<Response> {
  const requestInit: Record<string, unknown> = {
    method: init.method,
    headers: init.headers,
    body: init.body,
    duplex: init.duplex,
  }
  return Reflect.apply(globalThis.fetch, globalThis, [url, requestInit])
}

export interface UploadInputs {
  readonly server: string
  readonly token: string
  readonly tarballPath: string
  /** Inject a fake fetch for tests (defaults to global). */
  readonly fetchImpl?: MultipartFetch
}

export interface UploadResult {
  readonly status: number
  readonly body: unknown
}

/**
 * POST a `.tgz` to `${server}/api/addons/upload` with the Bearer token.
 * Returns the HTTP status + parsed body. Throws on non-2xx so the
 * executor can map this to a non-zero exit code.
 *
 * The server endpoint accepts multipart/form-data with a single `file`
 * field — matches `deploy-addon.sh`'s curl invocation.
 */
export async function uploadAddon(inputs: UploadInputs): Promise<UploadResult> {
  if (!fs.existsSync(inputs.tarballPath)) {
    throw new Error(`uploadAddon: tarball not found: ${inputs.tarballPath}`)
  }

  const form = new FormData()
  form.append('file', fs.createReadStream(inputs.tarballPath), {
    filename: path.basename(inputs.tarballPath),
    contentType: 'application/octet-stream',
  })

  const url = `${inputs.server.replace(/\/+$/, '')}/api/addons/upload`
  const fetcher: MultipartFetch = inputs.fetchImpl ?? nodeMultipartFetch
  if (!fetcher) {
    throw new Error('uploadAddon: global fetch unavailable — Node 18+ required')
  }

  const init: MultipartUploadInit = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${inputs.token}`,
      ...form.getHeaders(),
    },
    body: form,
    duplex: 'half',
  }
  const res = await fetcher(url, init)

  const text = await res.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }

  if (!res.ok) {
    throw new Error(
      `uploadAddon: server returned HTTP ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`,
    )
  }

  return { status: res.status, body }
}
