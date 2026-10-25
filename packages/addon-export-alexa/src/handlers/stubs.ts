/**
 * Stub responder for namespaces not yet implemented (CameraStream /
 * RTCSession / Doorbell). Returns the Alexa-canonical
 * `INVALID_DIRECTIVE` error envelope so Echo devices surface a clean
 * "not supported yet" rather than silently timing out.
 *
 * Real implementations land in the next dispatch.
 */
import { errorEnvelope, type AlexaErrorEnvelope } from './error-envelope.js'
import type { DirectiveHeader } from './types.js'

export function notImplemented(header: DirectiveHeader): AlexaErrorEnvelope {
  return errorEnvelope(
    header,
    'INVALID_DIRECTIVE',
    `${header.namespace}/${header.name} is not implemented yet — coming in the next CamStack release`,
  )
}
