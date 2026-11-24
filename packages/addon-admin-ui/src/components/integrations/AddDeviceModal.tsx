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
  ErrorBox,
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

/** Keeps the dialog's flex column unbroken down to a panel's DialogBody. */
const TAB_CHAIN = 'flex min-h-0 flex-1 flex-col'

type TabId = 'network' | 'manual' | 'pairing'

/** A pairing tab an integration adds beside the network and manual ones (a Matter share code). */
export interface PairingTab {
  readonly label: string
  /** What this integration calls the "Found on the network" tab (its adoptable nodes). */
  readonly networkLabel?: string
  /** Drawn inside the tab; `onPaired` moves the operator to "Found on the network" to adopt. */
  readonly render: (api: { readonly onPaired: () => void }) => ReactElement
}

interface AddDeviceModalProps {
  readonly addonId: string
  readonly integrationId: string
  /** `device-adoption` integrations without a scan list their candidates through the adopt job surface. */
  readonly kind: 'device-adoption' | 'device-provider'
  /**
   * A LAN scan for devices inside this integration is offered: its discovery mode is `lan` (or it
   * is a legacy discovery provider). An account integration lists devices through adoption and
   * manual add. `null` while that is still being asked.
   */
  readonly canScan: boolean | null
  /** Why the scan could not be decided (the integration's description failed); drawn instead of a scan. */
  readonly scanFailure?: string | null
  readonly onClose: () => void
  /** The integration commissions devices from a pairing code: one more tab. */
  readonly pairing?: PairingTab
}

function toTabId(value: string): TabId {
  return value === 'manual' ? 'manual' : value === 'pairing' ? 'pairing' : 'network'
}

function ScanFailure({ reason }: { readonly reason: string }): ReactElement {
  const { t } = useTranslation()
  return (
    <DialogBody>
      <ErrorBox
        message={t('integrations.addDeviceModal.scanUnavailable', {
          defaultValue: 'The network scan is unavailable for this integration: {{reason}}',
          reason,
        })}
      />
    </DialogBody>
  )
}

export function AddDeviceModal({
  addonId,
  integrationId,
  kind,
  canScan,
  scanFailure = null,
  onClose,
  pairing,
}: AddDeviceModalProps): ReactElement {
  const { t } = useTranslation()
  const manual = useManualCreationAvailability(addonId, integrationId)
  const scanPending = kind === 'device-adoption' && canScan === null
  const hasNetwork = kind === 'device-adoption' || canScan === true || scanFailure !== null
  const hasManual = manual === 'available'
  const [picked, setPicked] = useState<TabId | null>(null)
  // A pairing integration opens on its pairing tab: that is where its devices come from first.
  const active: TabId =
    picked ?? (pairing !== undefined ? 'pairing' : hasNetwork ? 'network' : 'manual')
  const tabCount = [hasNetwork, hasManual, pairing !== undefined].filter(Boolean).length

  // An adoption integration lists its candidates through the adopt surface, whole.
  // When the provider can also scan, ONE list carries every device found: the
  // adoption candidates, the scan hits and what discovery proposed, merged by
  // identity. Nothing is drawn before the answer is known, so the surface never
  // remounts after the first paint.
  const network = scanPending ? (
    <DialogBody>
      <Loader2 className="mx-auto h-5 w-5 animate-spin text-primary" />
    </DialogBody>
  ) : kind === 'device-adoption' ? (
    <>
      {scanFailure !== null && <ScanFailure reason={scanFailure} />}
      <AdoptDevicesPanel
        addonId={addonId}
        integrationId={integrationId}
        onClose={onClose}
        withScan={canScan === true}
      />
    </>
  ) : scanFailure !== null ? (
    <ScanFailure reason={scanFailure} />
  ) : (
    <NetworkCandidatesPanel addonId={addonId} integrationId={integrationId} onClose={onClose} />
  )
  const form = <AddDeviceForm integrationId={integrationId} addonId={addonId} onClose={onClose} />

  const body = (): ReactElement => {
    if (tabCount > 1) {
      return (
        // Every wrapper between the dialog and a panel's DialogBody stays a
        // flex column with min-h-0, or the body cannot scroll and the dialog
        // clips the test logs and the footer off its bottom.
        <Tabs value={active} onValueChange={(v) => setPicked(toTabId(v))} className={TAB_CHAIN}>
          <TabsList className="shrink-0">
            {hasNetwork && (
              <TabsTrigger value="network">
                {pairing?.networkLabel ??
                  t('integrations.addDeviceModal.tabNetwork', 'Found on the network')}
              </TabsTrigger>
            )}
            {hasManual && (
              <TabsTrigger value="manual">
                {t('integrations.addDeviceModal.tabManual', 'Enter parameters')}
              </TabsTrigger>
            )}
            {pairing !== undefined && <TabsTrigger value="pairing">{pairing.label}</TabsTrigger>}
          </TabsList>
          {hasNetwork && (
            <TabsContent value="network" className={TAB_CHAIN}>
              {network}
            </TabsContent>
          )}
          {hasManual && (
            <TabsContent value="manual" className={TAB_CHAIN}>
              {form}
            </TabsContent>
          )}
          {/* Hidden, not unmounted: a commission in flight survives a tab switch. */}
          {pairing !== undefined && (
            <div
              role="tabpanel"
              id="tabpanel-pairing"
              hidden={active !== 'pairing'}
              className="pt-3"
            >
              {pairing.render({ onPaired: () => setPicked('network') })}
            </div>
          )}
        </Tabs>
      )
    }
    if (pairing !== undefined && !hasNetwork && !hasManual) {
      return pairing.render({ onPaired: () => setPicked('network') })
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
