/**
 * Gives every settings form's secret field its eye (D789): the ui-library
 * secret control asks this host for a ref's value, and the host asks the hub
 * through `keychain-admin.reveal` — admin-only and audited on the hub. Nothing
 * caches the answer. A refusal comes back as a sentence the field can show on
 * its eye, not as a transport code.
 */
import { SecretRevealProvider, useKeychainAdminReveal } from '@camstack/ui-library'
import type { ReactNode } from 'react'
import { useCallback } from 'react'
import i18n from '../../i18n/index'

/** What the eye says when the hub refuses a reveal to this user. */
export function revealForbiddenMessage(): string {
  return i18n.t('helpers.keychainRevealHost.forbidden')
}

function trpcCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null
  const data: unknown = Reflect.get(err, 'data')
  if (typeof data !== 'object' || data === null) return null
  const code: unknown = Reflect.get(data, 'code')
  return typeof code === 'string' ? code : null
}

/** A reveal failure as the sentence the secret field shows. */
export function revealErrorMessage(err: unknown): string {
  const code = trpcCode(err)
  if (code === 'FORBIDDEN' || code === 'UNAUTHORIZED') return revealForbiddenMessage()
  const message = err instanceof Error ? err.message : String(err)
  return message.length > 0
    ? i18n.t('helpers.keychainRevealHost.failedWith', { message })
    : i18n.t('helpers.keychainRevealHost.failed')
}

export function KeychainRevealHost({ children }: { readonly children: ReactNode }) {
  const reveal = useKeychainAdminReveal()
  const revealRef = useCallback(
    async (ref: string): Promise<string> => {
      try {
        return (await reveal.mutateAsync({ ref })).value
      } catch (err: unknown) {
        throw new Error(revealErrorMessage(err))
      }
    },
    [reveal],
  )
  return <SecretRevealProvider reveal={revealRef}>{children}</SecretRevealProvider>
}
