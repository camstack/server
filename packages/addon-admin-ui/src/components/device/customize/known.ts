import i18n from '../../../i18n/index'

/**
 * An answered fact, or why it is not one (D315): `pending` = nobody has
 * answered, `unknown` = the read FAILED (with its reason), `known` = an
 * answer. Only `known` may ever say something is absent.
 */
export type Known<T> =
  | { readonly kind: 'pending' }
  | { readonly kind: 'unknown'; readonly reason: string }
  | { readonly kind: 'known'; readonly value: T }

/** The one field of a query error this module reads. */
export interface QueryErrorLike {
  readonly message: string
}

export interface QueryLike<T> {
  readonly status: 'pending' | 'error' | 'success'
  readonly data?: T | undefined
  readonly error?: QueryErrorLike | null
}

export function knownOf<T, U>(query: QueryLike<T>, map: (data: T) => U): Known<U> {
  if (query.status === 'error') {
    return {
      kind: 'unknown',
      reason: query.error?.message ?? i18n.t('helpers.customize.requestFailed'),
    }
  }
  const data = query.data
  if (query.status === 'pending' || data === undefined) return { kind: 'pending' }
  return { kind: 'known', value: map(data) }
}
