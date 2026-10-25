import { SECRET_CLEAR } from '@camstack/types'

/** Account label written by sign-in. Older integrations have none until the next sign-in. */
export function homeConnectSignedInAccount(settings: Record<string, unknown>): string {
  const label = settings['accountLabel']
  return typeof label === 'string' ? label : ''
}

export function homeConnectSignOutPatch(): Record<string, unknown> {
  return {
    token: SECRET_CLEAR,
    refresh: SECRET_CLEAR,
    applianceSecrets: SECRET_CLEAR,
    appliances: [],
    accountLabel: '',
  }
}
