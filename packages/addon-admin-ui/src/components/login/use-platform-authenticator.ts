/**
 * Whether the window can service a PLATFORM passkey, asked of
 * `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()`.
 *
 * Asked only inside the desktop shell (`window.camstackAgentApp`): there the
 * answer is `false` until the shell has configured its authenticator, and a
 * passkey button that cannot complete is worse than none. A browser keeps
 * its own roaming-key paths, so it is never asked and never hidden by this.
 */
import { useEffect, useState } from 'react'
import type { PlatformAuthenticatorAvailability } from './second-factor-selection'

export async function probePlatformAuthenticator(): Promise<PlatformAuthenticatorAvailability> {
  if (typeof PublicKeyCredential === 'undefined') return null
  const ask = PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable
  if (typeof ask !== 'function') return null
  try {
    return await ask.call(PublicKeyCredential)
  } catch {
    return null
  }
}

const isDesktopShell = (): boolean => 'camstackAgentApp' in window

export function usePlatformAuthenticator(): PlatformAuthenticatorAvailability {
  const [available, setAvailable] = useState<PlatformAuthenticatorAvailability>(null)
  useEffect(() => {
    if (!isDesktopShell()) return
    let live = true
    void probePlatformAuthenticator().then((answer) => {
      if (live) setAvailable(answer)
    })
    return () => {
      live = false
    }
  }, [])
  return available
}
