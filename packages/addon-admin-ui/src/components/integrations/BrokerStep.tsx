/**
 * `BrokerStep` — the integration wizard's broker gate for `device-adoption`
 * addons. Such an integration stores ONLY a `{ brokerId }`; the broker holds the
 * connection identity and credentials. The step is a `BrokerPicker` of the
 * required `kind` (pick one, or "Create new…" in a dialog stacked over the
 * wizard, which comes back with the new broker selected) and a confirm button.
 * It names no kind and owns no create / sign-in code of its own.
 */
import { useState } from 'react'
import { ChevronLeft } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@camstack/ui-library'
import { BrokerPicker } from '../brokers/BrokerPicker'

export interface BrokerStepProps {
  /** Broker kind the device-adoption addon requires. */
  readonly kind: string
  /** Resolve the wizard's broker selection to a single broker id. */
  readonly onResolved: (brokerId: string) => void
  /** Return to the provider picker. */
  readonly onBack: () => void
}

export function BrokerStep({ kind, onResolved, onBack }: BrokerStepProps) {
  const { t } = useTranslation()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ChevronLeft className="h-3.5 w-3.5" /> {t('common.back')}
      </Button>
      <BrokerPicker kind={kind} value={selectedId} onChange={setSelectedId} />
      <div className="flex justify-end pt-1">
        <Button
          variant="primary"
          size="sm"
          disabled={selectedId === null}
          onClick={() => selectedId !== null && onResolved(selectedId)}
        >
          {t('integrations.brokerStep.useThisBroker', 'Use this broker')}
        </Button>
      </div>
    </div>
  )
}
