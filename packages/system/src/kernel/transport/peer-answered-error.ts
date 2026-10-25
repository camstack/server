import type { ErrorI18nPayload, TranslationParams } from '@camstack/types'

/**
 * An error the FAR END of a channel answered with.
 *
 * The request was delivered, a handler ran, and it said no — typically a
 * provider refusing by throwing ("No home preset configured for this
 * camera"). That is an application answer, and it must reach the caller as
 * the provider's own sentence. A transport failure (channel closed, request
 * timed out, no child) is a plain `Error` and nobody answered it.
 *
 * `CapRouteResolver.dispatch` keys on this class: it used to wrap EVERY
 * non-routing throw as `CapRouteError{reason:'transport-failed'}`, so an
 * operator pressing PTZ Home was told the node was "not routable" when the
 * node had answered (2026-09-25, device 3836).
 */
export class PeerAnsweredError extends Error {
  /** The far end's stable error code (D863), carried so the hub can translate it. */
  readonly i18nCode: string | undefined
  readonly i18nParams: TranslationParams | undefined

  constructor(message: string, i18n?: ErrorI18nPayload) {
    super(message)
    this.name = 'PeerAnsweredError'
    this.i18nCode = i18n?.code
    this.i18nParams = i18n?.params
  }
}
