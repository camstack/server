import { TRPCError } from '@trpc/server'
import { userError, type TranslationParams } from '@camstack/types'

type TrpcErrorCode = ConstructorParameters<typeof TRPCError>[0]['code']

/**
 * A `TRPCError` that carries a stable i18n code (D863). `message` stays the
 * English text; the error formatter swaps it for the `server` catalog text in
 * the request language and keeps `{ code, params }` in `data.i18n`.
 */
export function trpcUserError(
  trpcCode: TrpcErrorCode,
  i18nCode: string,
  params: TranslationParams | undefined,
  englishFallback: string,
): TRPCError {
  return new TRPCError({
    code: trpcCode,
    message: englishFallback,
    cause: userError(i18nCode, params, englishFallback),
  })
}
