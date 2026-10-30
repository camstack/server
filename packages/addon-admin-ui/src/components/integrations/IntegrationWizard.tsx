import type {
  ConfigField,
  ConfigFieldWithValue,
  ConfigUISchema,
  ConfigUISchemaWithValues,
} from '@camstack/types'
import {
  useAddonSettingsGetGlobalSettings,
  useDeviceManagerAdoptDevice,
  useDeviceManagerDiscoverDevices,
  useDeviceManagerDiscoveryProviders,
  useIntegrationsCreate,
  useIntegrationsGetAvailableTypes,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { integrationDetailUrl } from '../../lib/integration-instance-selection'
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock'
import { useOverdueDeadline } from '../../hooks/useOverdueDeadline'
import { BrokerStep } from './BrokerStep'
import { DeviceDiscoveryStep } from './DeviceDiscoveryStep'
import { ProviderConfigForm } from './ProviderConfigForm'
import type { IntegrationFormSeed } from './integration-setup-seed'
import { ProviderPicker } from './ProviderPicker'
import { ScanNetworkModal } from './ScanNetworkModal'

/**
 * Convert a `ConfigUISchemaWithValues` (Phase 5 endpoint output) into
 * a plain `ConfigUISchema` by stripping the inline `value` field from
 * every leaf. The wizard only needs the schema structure — the
 * integration is being created from scratch so there are no stored
 * values to hydrate against.
 */
function stripValuesFromSchema(schema: ConfigUISchemaWithValues): ConfigUISchema {
  const stripField = (field: ConfigFieldWithValue): ConfigField => {
    if (field.type === 'separator' || field.type === 'info' || field.type === 'button') {
      return field as ConfigField
    }
    if (field.type === 'group') {
      return {
        ...field,
        fields: field.fields.map((child) => stripField(child)),
      } as ConfigField
    }
    const withValue = field as ConfigFieldWithValue & { value?: unknown }
    const { value: _value, ...rest } = withValue
    void _value
    return rest as ConfigField
  }
  return {
    ...(schema.tabs ? { tabs: schema.tabs } : {}),
    sections: schema.sections.map((s) => ({
      ...s,
      fields: s.fields.map(stripField),
    })),
  }
}

type WizardStep = 'picker' | 'config' | 'discovery' | 'broker'

/**
 * How long the "Creating integration…" overlay may spin before it stops
 * trapping the operator. Creation restarts the addon and waits for its caps
 * to re-register; that is normally seconds, but a slow/flaky restart must
 * never hold the modal hostage with a disabled close button. Past this
 * deadline we re-enable the close affordance and tell the operator the
 * integration may already exist — close and refresh to check.
 */
const CREATE_OVERDUE_MS = 20_000

interface IntegrationWizardProps {
  open: boolean
  onClose: () => void
  /** Skip the picker and open the config step with these values (a scan proposal). */
  seed?: IntegrationFormSeed | null
}

export function IntegrationWizard({ open, onClose, seed = null }: IntegrationWizardProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [step, setStep] = useState<WizardStep>('picker')
  const [selectedAddonId, setSelectedAddonId] = useState<string | null>(null)
  const [createdProviderId, setCreatedProviderId] = useState<string | null>(null)
  const [discoveryMode, setDiscoveryMode] = useState<string>('manual')
  // Broker kind to create/link for a `device-adoption` addon (Approach A).
  const [brokerKind, setBrokerKind] = useState<string | null>(null)
  // Pending integration name (carried from the picker entry's display name)
  // so the broker step can create the integration with it on resolve.
  const [pendingName, setPendingName] = useState<string>('')
  // Integration id created after the broker is resolved. Read by the adopt
  // step (built in the next task) to drive device adoption against it.
  const [createdIntegrationId, setCreatedIntegrationId] = useState<string | null>(null)
  // Local picker-level error (e.g. a device-adoption addon with no broker
  // kind in its manifest). Surfaced near the picker; cleared on re-select.
  const [pickerError, setPickerError] = useState<string | null>(null)
  // Whether the picked integration declares a pre-creation test. Drives the
  // config step's Test button: an integration with no declared test must say so
  // rather than offering a button that can only answer "cannot be tested".
  const [canTest, setCanTest] = useState<boolean>(false)
  const [formSeed, setFormSeed] = useState<Readonly<Record<string, unknown>>>({})
  const [appliedSeed, setAppliedSeed] = useState('')
  // The config step's own Scan: a pick refills the form it was opened from.
  const [scanOpen, setScanOpen] = useState(false)
  const [scanFills, setScanFills] = useState(0)
  const [scanLabel, setScanLabel] = useState('')
  const discoveryProviders = useDeviceManagerDiscoveryProviders(
    {},
    {
      enabled: open && step === 'config',
    },
  )
  const canScan =
    selectedAddonId !== null &&
    (discoveryProviders.data?.providers ?? []).some((p) => p.addonId === selectedAddonId)

  const seedHost = seed?.config['host']
  const seedIdentity =
    seed === null
      ? ''
      : `${seed.addonId}\0${seed.name}\0${typeof seedHost === 'string' ? seedHost : ''}`
  if (open && seed !== null && appliedSeed !== seedIdentity) {
    setAppliedSeed(seedIdentity)
    setSelectedAddonId(seed.addonId)
    setPendingName(seed.name)
    setFormSeed({ ...seed.config })
    setStep('config')
  }

  const availableTypes = useIntegrationsGetAvailableTypes(undefined, {
    enabled: open && seed !== null,
  })

  // Fetch the provider addon's global settings schema via the Phase 5
  // three-level API, then strip the inline `value` from each leaf so
  // the legacy `ProviderConfigForm`'s FormBuilder can render it with
  // a local editing state seeded from user input. When the addon has
  // no addon-level settings we pass `null` and the form renders a
  // bare name input only.
  const { data: configSchemaWithValues } = useAddonSettingsGetGlobalSettings(
    { addonId: selectedAddonId ?? '', nodeId: 'hub' },
    { enabled: selectedAddonId != null },
  )
  const configSchema = useMemo<ConfigUISchema | null>(
    () =>
      configSchemaWithValues
        ? stripValuesFromSchema(configSchemaWithValues as ConfigUISchemaWithValues)
        : null,
    [configSchemaWithValues],
  )

  const addProviderMutation = useIntegrationsCreate({
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [['integrations']] }),
  })

  const discoverDevicesMutation = useDeviceManagerDiscoverDevices()
  const discoveredDevices = discoverDevicesMutation.data

  useEffect(() => {
    if (!open || seed === null) return
    const match = availableTypes.data?.find((row) => row.addonId === seed.addonId)
    if (!match) return
    setCanTest(match.canTest)
    setDiscoveryMode(match.discoveryMode)
  }, [open, seed, availableTypes.data])

  useEffect(() => {
    if (step !== 'discovery' || !createdProviderId || !selectedAddonId) return
    if (discoverDevicesMutation.isPending || discoverDevicesMutation.data) return
    discoverDevicesMutation.mutate({ addonId: selectedAddonId })
  }, [step, createdProviderId, selectedAddonId, discoverDevicesMutation])

  const adoptMutation = useDeviceManagerAdoptDevice({
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [['deviceManager']] }),
  })

  function handlePickerSelect(
    addonId: string,
    _instanceMode: string,
    providerDiscoveryMode: string,
    displayName: string,
    _kind: 'device-adoption' | 'device-provider',
    providerBrokerKind: string | null,
    mode: 'standalone' | 'account' | 'broker',
    providerCanTest: boolean,
  ) {
    if (addProviderMutation.isPending) return

    setSelectedAddonId(addonId)
    setCanTest(providerCanTest)
    setDiscoveryMode(providerDiscoveryMode)
    setPendingName(displayName)
    setPickerError(null)

    // Route by `mode` (LOCKED MODEL), never by addon name:
    //   - broker     → shared-bus/session broker step (HA/MQTT). The operator
    //                  picks or creates a broker; the integration stores ONLY
    //                  `{ brokerId }`.
    //   - account    → config step: the operator names AND configures the
    //                  account/connection before the integration is created
    //                  (Dreo/Wyze/Dreame).
    //   - standalone → NO integration-level config. Create the integration NOW
    //                  with empty settings, then close the wizard and land on
    //                  the detail page with `?add=1` so it auto-opens the
    //                  add/discover-device flow (Reolink/ONVIF/Ecowitt/Gree).
    //
    // This REVISES the earlier "every device-provider goes through the config
    // step" behaviour: standalone SKIPS config and goes straight to devices;
    // only account keeps the config step.
    if (mode === 'broker') {
      // A broker integration MUST carry a broker kind it routes through.
      // Without it the broker step has no list filter / form schema to render
      // and would show a blank pane — surface a clear error and stay on the
      // picker instead.
      if (!providerBrokerKind) {
        setPickerError(
          `Addon '${addonId}' declares mode 'broker' but no brokerKind in its manifest`,
        )
        return
      }
      setBrokerKind(providerBrokerKind)
      setStep('broker')
      return
    }

    if (mode === 'account') {
      setStep('config')
      return
    }

    // standalone — create with empty settings, then navigate to the detail
    // page with `?add=1` so it auto-opens the add-device flow.
    void handleStandaloneCreate(addonId, displayName)
  }

  async function handleStandaloneCreate(addonId: string, displayName: string) {
    try {
      const result = await addProviderMutation.mutateAsync({
        addonId,
        name: displayName,
        settings: {},
      })
      onClose()
      resetState()
      navigate(`${integrationDetailUrl(addonId, result.id)}&add=1`)
    } catch {
      // Error is handled by mutation state (surfaced above the picker).
    }
  }

  async function handleConfigSave(data: {
    name: string
    config: Record<string, unknown>
    secretKeys: readonly string[]
  }) {
    if (!selectedAddonId) return

    try {
      const result = await addProviderMutation.mutateAsync({
        addonId: selectedAddonId,
        name: data.name,
        settings: data.config,
        secretKeys: [...data.secretKeys],
      })
      setCreatedProviderId(result.id)
      setCreatedIntegrationId(result.id)
      if (discoveryMode === 'auto' || discoveryMode === 'both') {
        setStep('discovery')
      } else {
        // Account integrations (Bosch SHC, …) land on the detail page with the
        // adopt modal open — same deep-link standalone uses after create.
        finish(result.id, { openAdd: true })
      }
    } catch {
      // Error is handled by mutation state
    }
  }

  async function handleBrokerResolved(brokerId: string) {
    if (!selectedAddonId) return
    try {
      // A device-adoption integration stores ONLY the broker reference;
      // the broker (registered via `broker.add`) owns the connection
      // identity/credentials. No provider credentials live on the
      // integration record (Approach A).
      const result = await addProviderMutation.mutateAsync({
        addonId: selectedAddonId,
        name: pendingName,
        settings: { brokerId },
      })
      // Store the created integration id so the adopt step (next task)
      // can drive device adoption against it.
      setCreatedIntegrationId(result.id)
      setCreatedProviderId(result.id)
      // The adopt modal is built in the next task; for now finish the
      // wizard and navigate to the new integration's detail page.
      finish(result.id)
    } catch {
      // Error is handled by mutation state
    }
  }

  async function handleImport(externalIds: readonly string[]) {
    if (!selectedAddonId) return
    for (const id of externalIds) {
      const candidate = discoveredDevices?.find((d) => d.stableId === id)
      if (!candidate) continue
      await adoptMutation.mutateAsync({
        addonId: selectedAddonId,
        candidate,
        ...(createdIntegrationId !== null ? { integrationId: createdIntegrationId } : {}),
      })
    }
    finish()
  }

  function finish(overrideProviderId?: string, options?: { readonly openAdd?: boolean }) {
    const targetId = overrideProviderId ?? createdProviderId ?? selectedAddonId
    onClose()
    resetState()
    if (targetId && selectedAddonId) {
      const url = integrationDetailUrl(selectedAddonId, targetId)
      navigate(options?.openAdd === true ? `${url}&add=1` : url)
    }
  }

  function resetState() {
    setStep('picker')
    setSelectedAddonId(null)
    setCreatedProviderId(null)
    setDiscoveryMode('manual')
    setBrokerKind(null)
    setPendingName('')
    setCreatedIntegrationId(null)
    setPickerError(null)
    setCanTest(false)
    setFormSeed({})
    setAppliedSeed('')
  }

  function handleClose() {
    onClose()
    resetState()
  }

  // Lock body scroll while the modal is open so scroll events inside
  // the modal don't propagate to the page underneath on mobile.
  useBodyScrollLock(open)

  const isCreating = addProviderMutation.isPending
  // A create that spins past the deadline stops locking the modal — the
  // operator can close and refresh instead of being trapped on a spinner.
  // ⚠️ Hooks MUST run on every render: this sits ABOVE the `!open` early
  // return (placing it below crashed the modal open with React #310 —
  // more hooks than the previous closed render).
  const createOverdue = useOverdueDeadline(isCreating, CREATE_OVERDUE_MS)

  if (!open) return null

  const titles: Record<WizardStep, string> = {
    picker: t('integrations.newIntegration'),
    config: t('integrations.configureIntegration'),
    discovery: t('integrations.importDevices'),
    broker: t('integrations.connectBroker', {
      defaultValue: 'Connect a broker',
    }),
  }

  const pendingAddonId = isCreating ? selectedAddonId : null
  const createError = addProviderMutation.error
  // Lock the modal (disable close) ONLY while a create is genuinely in
  // flight AND still within the deadline. Once overdue, close is re-enabled.
  const lockModal = isCreating && !createOverdue

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={lockModal ? undefined : handleClose} />
      <div
        className={`relative z-10 w-full ${step === 'picker' ? 'max-w-5xl' : 'max-w-lg'} max-h-[calc(85dvh-2*max(env(safe-area-inset-top),env(safe-area-inset-bottom)))] rounded-xl border border-border bg-background shadow-2xl flex flex-col overflow-hidden`}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-4 flex-shrink-0">
          <h2 className="text-sm font-semibold text-foreground">{titles[step]}</h2>
          <button
            onClick={handleClose}
            disabled={lockModal}
            className="rounded-md p-1 text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 py-4 flex-1 overflow-y-auto overscroll-contain">
          {createError && !isCreating && (
            <div className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {createError instanceof Error ? createError.message : String(createError)}
            </div>
          )}
          {step === 'picker' && (
            <>
              {pickerError && (
                <div className="mb-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {pickerError}
                </div>
              )}
              <ProviderPicker
                onSelect={handlePickerSelect}
                onClose={handleClose}
                pendingAddonId={pendingAddonId}
              />
            </>
          )}
          {step === 'config' && selectedAddonId && (
            <ProviderConfigForm
              key={`${seedIdentity.length > 0 ? seedIdentity : selectedAddonId}:${scanFills}`}
              addonId={selectedAddonId}
              configSchema={(configSchema ?? null) as ConfigUISchema | null}
              canTest={canTest}
              initialName={
                pendingName.length > 0 && Object.keys(formSeed).length > 0 ? pendingName : undefined
              }
              initialConfig={{ ...formSeed }}
              onScan={
                canScan
                  ? () => {
                      setScanLabel(pendingName.length > 0 ? pendingName : selectedAddonId)
                      setScanOpen(true)
                    }
                  : undefined
              }
              onSave={handleConfigSave}
              onBack={() => {
                setFormSeed({})
                setStep('picker')
              }}
            />
          )}
          {step === 'broker' && brokerKind && (
            <BrokerStep
              kind={brokerKind}
              onResolved={(brokerId) => {
                void handleBrokerResolved(brokerId)
              }}
              onBack={() => setStep('picker')}
            />
          )}
          {step === 'discovery' && createdProviderId && (
            <DeviceDiscoveryStep
              providerId={createdProviderId}
              onImport={handleImport}
              onSkip={finish}
            />
          )}
        </div>
        {/* Creating overlay: anchored to the fixed-size modal box (NOT the
            scrollable content), so it always covers the visible viewport
            regardless of how far the form is scrolled. */}
        {isCreating && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 rounded-xl bg-background/85 backdrop-blur-sm px-6 text-center">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
            <p className="text-xs font-medium text-foreground">
              {t('integrations.creating', {
                defaultValue: 'Creating integration…',
              })}
            </p>
            {!createOverdue && (
              <p className="text-[10px] text-foreground-subtle">
                {t('integrations.creatingHint', {
                  defaultValue: 'Waiting for the addon to restart and register',
                })}
              </p>
            )}
            {createOverdue && (
              <>
                <p className="text-[10px] text-foreground-subtle max-w-xs">
                  {t('integrations.creatingOverdue', {
                    defaultValue:
                      'This is taking longer than expected. The integration may already have been created — close this dialog and refresh to check.',
                  })}
                </p>
                <button
                  onClick={handleClose}
                  className="mt-1 rounded-md border border-border bg-surface px-3 py-1.5 text-[11px] font-medium text-foreground hover:bg-surface-hover transition-colors"
                >
                  {t('integrations.closeAndRefresh', { defaultValue: 'Close' })}
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {scanOpen && selectedAddonId !== null && (
        <ScanNetworkModal
          open={scanOpen}
          scope={{ addonId: selectedAddonId, label: scanLabel }}
          pickMode="fill"
          onClose={() => setScanOpen(false)}
          onSetupIntegration={(picked) => {
            setPendingName(picked.name)
            setFormSeed({ ...picked.config })
            setScanFills((n) => n + 1)
          }}
        />
      )}
    </div>
  )
}
