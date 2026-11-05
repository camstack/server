/**
 * The ONE "Add device" modal of an integration.
 *
 * - "Found on the network": the devices the integration could take, from its
 *   adoption provider, a scan scoped to it and passive discovery, deduped;
 * - "Enter parameters": the provider's manual creation form, offered only when
 *   the provider declares one.
 *
 * Devices are added here and nowhere else: never through the integration's
 * settings form. A tab that would be the only one is not drawn as a tab.
 */
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@camstack/ui-library'
import { Loader2 } from 'lucide-react'
import { type ReactElement, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AddDeviceForm, useManualCreationAvailability } from './AddDeviceDialog'
import { AdoptDevicesPanel } from './AdoptDevicesModal'
import { NetworkCandidatesPanel } from './NetworkCandidatesPanel'
import type { IntegrationFormSeed } from './integration-setup-seed'

type TabId = 'network' | 'manual'

interface AddDeviceModalProps {
  readonly addonId: string
  readonly integrationId: string
  /** `device-adoption` integrations without a scan list their candidates through the adopt job surface. */
  readonly kind: 'device-adoption' | 'device-provider'
  /** The provider supports a network scan; `null` while that is still being asked. */
  readonly canScan: boolean | null
  readonly onClose: () => void
  readonly onSetupIntegration?: (seed: IntegrationFormSeed) => void
}

export function AddDeviceModal({
  addonId,
  integrationId,
  kind,
  canScan,
  onClose,
  onSetupIntegration,
}: AddDeviceModalProps): ReactElement {
  const { t } = useTranslation()
  const manual = useManualCreationAvailability(addonId, integrationId)
  const scanPending = kind === 'device-adoption' && canScan === null
  const hasNetwork = kind === 'device-adoption' || canScan === true
  const hasManual = manual === 'available'
  const [picked, setPicked] = useState<TabId | null>(null)
  const active: TabId = picked ?? (hasNetwork ? 'network' : 'manual')

  // An adoption integration lists its candidates through the adopt surface, whole.
  // When the provider can also scan, the scan block is drawn above it and leaves
  // out what the adoption list already holds. Neither is drawn before the answer
  // is known, so the surface never remounts after the first paint.
  const network = scanPending ? (
    <DialogBody>
      <Loader2 className="mx-auto h-5 w-5 animate-spin text-primary" />
    </DialogBody>
  ) : kind === 'device-adoption' ? (
    <>
      {canScan === true && (
        <NetworkCandidatesPanel
          addonId={addonId}
          integrationId={integrationId}
          onClose={onClose}
          alongsideAdoption
          {...(onSetupIntegration ? { onSetupIntegration } : {})}
        />
      )}
      <AdoptDevicesPanel addonId={addonId} integrationId={integrationId} onClose={onClose} />
    </>
  ) : (
    <NetworkCandidatesPanel
      addonId={addonId}
      integrationId={integrationId}
      onClose={onClose}
      {...(onSetupIntegration ? { onSetupIntegration } : {})}
    />
  )
  const form = <AddDeviceForm integrationId={integrationId} addonId={addonId} onClose={onClose} />

  const body = (): ReactElement => {
    if (hasNetwork && hasManual) {
      return (
        <Tabs
          value={active}
          onValueChange={(v) => setPicked(v === 'manual' ? 'manual' : 'network')}
        >
          <TabsList>
            <TabsTrigger value="network">
              {t('integrations.addDeviceModal.tabNetwork', 'Found on the network')}
            </TabsTrigger>
            <TabsTrigger value="manual">
              {t('integrations.addDeviceModal.tabManual', 'Enter parameters')}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="network">{network}</TabsContent>
          <TabsContent value="manual">{form}</TabsContent>
        </Tabs>
      )
    }
    if (hasNetwork) return network
    if (hasManual) return form
    if (manual === 'loading') {
      return (
        <DialogBody>
          <Loader2 className="mx-auto h-5 w-5 animate-spin text-primary" />
        </DialogBody>
      )
    }
    return (
      <DialogBody>
        <p className="py-6 text-center text-xs text-foreground-subtle">
          {t(
            'integrations.addDeviceModal.nothingToAdd',
            'This integration has no way to add a device from here.',
          )}
        </p>
      </DialogBody>
    )
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      {/* A candidate list of any size gets a fixed desktop height so the modal does
          not resize between its loading, list and empty states. */}
      <DialogContent
        width="xl"
        placement="sheet-on-mobile"
        scroll="body"
        className={kind === 'device-adoption' ? 'md:h-[85vh]' : undefined}
      >
        <DialogHeader>
          <DialogTitle>{t('integrations.addDevice', 'Add device')}</DialogTitle>
        </DialogHeader>
        {body()}
      </DialogContent>
    </Dialog>
  )
}
