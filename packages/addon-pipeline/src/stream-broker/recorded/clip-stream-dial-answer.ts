/**
 * clip-stream-dial-answer — what a THROWN `videoclips.dialClipStream` means.
 *
 * The cap call has three ways to fail, and the feeder must tell them apart
 * because they lead to different lines and different states:
 *
 * - the provider PREDATES the method (`NOT_IMPLEMENTED`, "does not
 *   implement") — the stream does not exist on this cluster yet, which is a
 *   deploy-order fact, not a clip fact;
 * - the provider REFUSED in the clip vocabulary (`clipExportFailure`):
 *   `sleeping`, `catalog-miss`, `clip-in-progress`, `unsupported-option`… —
 *   the code is kept, the prose travels with it;
 * - anything else — the transport, a bug — is `fetch-failed` with the prose
 *   verbatim, exactly as the export engine treats an unknown error (D572).
 */
import { clipExportFailureOf } from '@camstack/types'
import type { ClipStreamDialAnswer } from './clip-stream-feeder.js'

interface WithCode {
  readonly data?: { readonly code?: unknown }
  readonly code?: unknown
}

function trpcCodeOf(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null
  const shaped = err as WithCode
  if (typeof shaped.data?.code === 'string') return shaped.data.code
  if (typeof shaped.code === 'string') return shaped.code
  return null
}

export function dialAnswerFromError(err: unknown): ClipStreamDialAnswer {
  const message = err instanceof Error ? err.message : String(err)
  if (trpcCodeOf(err) === 'NOT_IMPLEMENTED' || /does not implement/i.test(message)) {
    return { kind: 'unavailable', detail: message }
  }
  const code = clipExportFailureOf(message)
  if (code !== null) {
    const sep = message.indexOf(':')
    return { kind: 'refused', code, detail: sep === -1 ? '' : message.slice(sep + 1).trim() }
  }
  return { kind: 'refused', code: 'fetch-failed', detail: message }
}
