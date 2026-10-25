import { SECRET_CLEAR } from '@camstack/types'

/** Account label from a sign-in, or the older username string when that is still plaintext. */
export function homeComSignedInAccount(settings: Record<string, unknown>): string {
  const label = settings['accountLabel']
  if (typeof label === 'string' && label.length > 0) return label
  const username = settings['username']
  if (typeof username === 'string' && username.length > 0) return username
  return ''
}

/** Gateway count stored beside the account. Absent is unknown, not zero. */
export function homeComGatewayCount(settings: Record<string, unknown>): number | null {
  const count = settings['gatewayCount']
  if (typeof count === 'number' && Number.isFinite(count)) return count
  return null
}

/** Sign-out: keychain secrets are cleared only by the clear instruction. */
export function homeComSignOutPatch(): Record<string, unknown> {
  return {
    token: SECRET_CLEAR,
    refresh: SECRET_CLEAR,
    username: SECRET_CLEAR,
    accountLabel: '',
    gatewayId: '',
    gatewayCount: 0,
  }
}
