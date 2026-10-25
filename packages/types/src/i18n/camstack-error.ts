/**
 * A user-facing error with a STABLE code (D863).
 *
 * `message` is always the English text, so every consumer that knows nothing
 * of codes (old clients, logs, the mesh) behaves exactly as before. The hub's
 * tRPC error formatter reads `code` + `params` and, when the request language
 * has a text for `server:<code>`, replaces the response `message`; the code
 * stays in the payload (`data.i18n`).
 */
import { z } from 'zod'
import type { TranslationParams } from './translation.js'

/** Dotted lower-case code, e.g. `auth.invalid-credentials`. It is the key in the `server` catalog. */
export const ErrorCodeSchema = z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/)

/** What travels in the error payload next to the message. */
export const ErrorI18nPayloadSchema = z.object({
  code: ErrorCodeSchema,
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
})
export type ErrorI18nPayload = z.infer<typeof ErrorI18nPayloadSchema>

export class CamstackError extends Error {
  readonly i18nCode: string
  readonly i18nParams: TranslationParams | undefined

  constructor(code: string, params: TranslationParams | undefined, englishMessage: string) {
    super(englishMessage)
    this.name = 'CamstackError'
    this.i18nCode = code
    this.i18nParams = params
  }
}

/** `throw userError('device.not-found', { id }, 'Device 12 not found')` */
export function userError(
  code: string,
  params: TranslationParams | undefined,
  englishFallback: string,
): CamstackError {
  return new CamstackError(code, params, englishFallback)
}

/**
 * Finds a code on `err` or anywhere down its `.cause` chain. Duck-typed on
 * the field so it survives a module boundary (self-contained addons).
 */
export function readErrorI18n(err: unknown): ErrorI18nPayload | null {
  let current: unknown = err
  for (let depth = 0; depth < 8; depth++) {
    if (typeof current !== 'object' || current === null) return null
    const code: unknown = Reflect.get(current, 'i18nCode')
    if (typeof code === 'string') {
      const parsed = ErrorI18nPayloadSchema.safeParse({
        code,
        params: Reflect.get(current, 'i18nParams'),
      })
      return parsed.success ? parsed.data : null
    }
    const cause: unknown = Reflect.get(current, 'cause')
    if (cause === current) return null
    current = cause
  }
  return null
}
