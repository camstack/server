import { useTrpcClient, type WidgetProps } from '@camstack/ui-library'
import { z } from 'zod'
import type { CcuTrpc } from '../ui/ccu-client.js'
import { DevicePanel } from '../ui/DevicePanel.js'
import { useT } from '../i18n/index.js'

/** What the device section hands the widget (`hm-device-panel-section.ts`). */
const PanelConfigSchema = z.object({
  integrationId: z.string().min(1),
  address: z.string().min(1),
})

/** The Homematic panel on a CCU device's CamStack page. */
export function DevicePanelWidget(props: WidgetProps) {
  const trpc: CcuTrpc = useTrpcClient()
  const { t } = useT()
  const config = PanelConfigSchema.safeParse(props.config ?? {})
  if (!config.success) {
    return <p className="text-sm text-danger">{t('panel.badConfig')}</p>
  }
  return (
    <DevicePanel
      trpc={trpc}
      integrationId={config.data.integrationId}
      address={config.data.address}
      {...(props.deviceId === undefined ? {} : { deviceId: props.deviceId })}
    />
  )
}
