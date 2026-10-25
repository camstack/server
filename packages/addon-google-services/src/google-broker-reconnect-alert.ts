import type { Alert } from '@camstack/types'

export function googleBrokerReconnectAlertId(brokerId: string): string {
  return `google-broker:${brokerId}`
}

export function isInvalidGrantRefreshError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.includes('invalid_grant')
}

export function buildGoogleBrokerReconnectAlert(brokerId: string, brokerName: string): Alert {
  return {
    id: googleBrokerReconnectAlertId(brokerId),
    category: 'google.broker-reconnect',
    severity: 'critical',
    title: 'Google needs a new sign-in',
    message: `${brokerName} needs you to sign in to Google again.`,
    action: {
      label: 'Sign in again',
      href: `/addon/google-services/oauth/start?brokerId=${encodeURIComponent(brokerId)}`,
      // An addon HTTP route, not an admin-ui page: the browser must leave the SPA.
      navigation: 'server',
    },
    status: 'active',
    read: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    source: { type: 'google-broker', id: brokerId },
    metadata: { episodeKey: 'reconnect' },
  }
}
