/**
 * The mark of a device the hub already holds, in every row of the Add device list: an "Adopted" badge
 * and, when the hub device is known, a link to it. An adopted row has no add action.
 */
import { Badge } from '@camstack/ui-library'
import { Check } from 'lucide-react'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'

interface AdoptedMarkProps {
  /** The hub device this row is; null when the provider did not say which one. */
  readonly deviceId: number | null
  /** The name the device carries on the hub, when it differs from the row's. */
  readonly deviceName?: string | null
  /** Leaves the modal before the link navigates. */
  readonly onNavigate: () => void
}

export function AdoptedMark({ deviceId, deviceName, onNavigate }: AdoptedMarkProps): ReactElement {
  const { t } = useTranslation()
  return (
    <span className="inline-flex min-w-0 shrink-0 items-center gap-2" data-testid="adopted-mark">
      <Badge variant="success" size="sm" icon={<Check className="h-3 w-3" />}>
        {t('integrations.adoptAlready', 'Adopted')}
      </Badge>
      {deviceId !== null && (
        <Link
          to={`/devices/${String(deviceId)}`}
          onClick={onNavigate}
          className="truncate text-[11px] text-primary hover:underline"
        >
          {deviceName ?? t('integrations.addDeviceModal.openDevice', 'Open device')}
        </Link>
      )}
    </span>
  )
}
