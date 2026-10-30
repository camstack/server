/**
 * `BrokerSignInPanel` is the interactive sign-in a broker kind declares
 * (`signIn.basePath`). When the kind serves more than one method
 * (`signIn.methods`, preference order) the operator picks between them; the
 * first listed is the default, and one method shows no selector. Switching
 * method unmounts the running flow, which cancels its session.
 *
 * Nothing in this file names a kind.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Tabs, TabsList, TabsTrigger } from '@camstack/ui-library'
import type { BrokerSignInMethod } from '../../lib/broker-sign-in'
import { BrokerDeviceCodeSignIn } from './BrokerDeviceCodeSignIn'
import { BrokerProxySignIn } from './BrokerProxySignIn'

const DEFAULT_METHODS: readonly BrokerSignInMethod[] = ['proxy']

export interface BrokerSignInPanelProps {
  /** The kind's `signIn.basePath`. */
  readonly basePath: string
  /** The kind's `signIn.methods`; absent means the guided proxy only. */
  readonly methods?: readonly BrokerSignInMethod[]
  /** Name for a NEW broker; ignored when `brokerId` re-links an existing one. */
  readonly name: string
  /** Re-link this broker instead of creating one. */
  readonly brokerId?: string
  /** The form's current settings, sent to `start`. */
  readonly getSettings: () => Record<string, unknown>
  readonly disabled?: boolean
  readonly onSignedIn: (brokerId: string) => void
}

export function BrokerSignInPanel({ methods, ...flow }: BrokerSignInPanelProps) {
  const { t } = useTranslation()
  const available = methods !== undefined && methods.length > 0 ? methods : DEFAULT_METHODS
  const [picked, setPicked] = useState<BrokerSignInMethod | null>(null)
  const method = picked !== null && available.includes(picked) ? picked : (available[0] ?? 'proxy')

  return (
    <div className="space-y-2">
      {available.length > 1 && (
        <Tabs
          value={method}
          onValueChange={(v) => setPicked(v === 'device-code' ? v : 'proxy')}
          appearance="pills"
        >
          <TabsList aria-label={t('brokers.signIn.method')}>
            {available.map((m) => (
              <TabsTrigger key={m} value={m}>
                {m === 'device-code'
                  ? t('brokers.signIn.methodDeviceCode')
                  : t('brokers.signIn.methodProxy')}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}
      {method === 'device-code' ? (
        <BrokerDeviceCodeSignIn key="device-code" {...flow} />
      ) : (
        <BrokerProxySignIn key="proxy" {...flow} />
      )}
    </div>
  )
}
