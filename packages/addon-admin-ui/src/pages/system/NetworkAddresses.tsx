/**
 * Network Addresses — operator-managed allowlist of local interfaces, and the
 * Addresses table: every address this hub is reached at (detected, custom,
 * and the CamStack app link), each ticked for the roles it serves — app connections,
 * notification taps, public endpoint, internal.
 *
 * The roles are the hub's (`local-network.getAddresses` / `setAddressRole`):
 * this page renders what the hub resolved and never ranks an address itself.
 */

import {
  Button,
  SECTION_BODY,
  SectionCard,
  useLocalNetworkAddCustomAddress,
  useLocalNetworkGetAddresses,
  useLocalNetworkGetAllowedAddresses,
  useLocalNetworkList,
  useLocalNetworkRemoveCustomAddress,
  useLocalNetworkResetAllowlistToBestMatch,
  useLocalNetworkSetAddressRole,
  useLocalNetworkSetAllowedAddresses,
} from '@camstack/ui-library'
import { useQueryClient } from '@tanstack/react-query'
import { RefreshCw, RotateCcw, Save, Sparkles } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { AdminPage } from '../../components/AdminPage'
import { AddressSelector } from '../../components/shared/AddressSelector'
import { AddressesCard } from './AddressesCard'
import { useTranslation } from 'react-i18next'

export function NetworkAddressesPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: [['localNetwork']] })
  }

  const listQuery = useLocalNetworkList(undefined, { refetchInterval: 30_000 })
  const allowedQuery = useLocalNetworkGetAllowedAddresses(undefined)
  const setAllowed = useLocalNetworkSetAllowedAddresses({ onSuccess: invalidate })
  const resetToBestMatch = useLocalNetworkResetAllowlistToBestMatch({
    onSuccess: (res) => {
      setDraft(res.addresses)
      invalidate()
    },
  })

  const interfaces = useMemo(() => listQuery.data?.interfaces ?? [], [listQuery.data])

  const resolvedScheme: 'http' | 'https' =
    typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'https' : 'http'

  const addressesQuery = useLocalNetworkGetAddresses(
    { scheme: resolvedScheme },
    { refetchInterval: 30_000 },
  )
  const setAddressRole = useLocalNetworkSetAddressRole({ onSuccess: invalidate })
  const addCustomAddress = useLocalNetworkAddCustomAddress({ onSuccess: invalidate })
  const removeCustomAddress = useLocalNetworkRemoveCustomAddress({ onSuccess: invalidate })

  const addressError =
    setAddressRole.error?.message ??
    addCustomAddress.error?.message ??
    removeCustomAddress.error?.message ??
    null
  const addressSaving =
    setAddressRole.isPending || addCustomAddress.isPending || removeCustomAddress.isPending

  const [draft, setDraft] = useState<readonly string[]>([])
  const [seeded, setSeeded] = useState(false)

  useEffect(() => {
    if (!seeded && allowedQuery.data) {
      setDraft(allowedQuery.data.addresses)
      setSeeded(true)
    }
  }, [allowedQuery.data, seeded])

  const serverValue = allowedQuery.data?.addresses ?? []
  const isDirty = useMemo(() => {
    if (draft.length !== serverValue.length) return true
    const a = [...draft].toSorted()
    const b = [...serverValue].toSorted()
    return a.some((x, i) => x !== b[i])
  }, [draft, serverValue])

  const handleSave = () => {
    setAllowed.mutate({ addresses: [...draft] })
  }
  const handleReset = () => {
    setDraft(serverValue)
  }
  const handleClear = () => {
    setDraft([])
  }
  const refresh = () => {
    void listQuery.refetch()
    void allowedQuery.refetch()
    void addressesQuery.refetch()
  }

  return (
    <AdminPage embedded>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs text-foreground-subtle max-w-2xl">
          {t(
            'system.networkAddresses.pinWhichHostInterfacesExist',
            'Pin which host interfaces exist, then tick what each address is used for. Add a custom address when this hub is reached at one it cannot detect.',
          )}
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <Button size="sm" variant="secondary" onClick={refresh} disabled={listQuery.isLoading}>
            <RefreshCw className={`h-3 w-3 ${listQuery.isLoading ? 'animate-spin' : ''}`} />
            {t('common.refresh', 'Refresh')}
          </Button>
        </div>
      </div>

      <SectionCard
        headingId="network-allowed-addresses"
        title={t('system.networkAddresses.allowedAddresses', 'Allowed addresses')}
        actions={
          <div className="flex flex-wrap items-center gap-1">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => resetToBestMatch.mutate(undefined)}
              disabled={resetToBestMatch.isPending || setAllowed.isPending}
              title={t(
                'system.networkAddresses.reRunTheAutoDetection',
                'Re-run the auto-detection heuristic + overwrite the current allowlist with the best matches.',
              )}
            >
              <Sparkles className="h-3 w-3" />
              {resetToBestMatch.isPending
                ? t('system.networkAddresses.detecting', 'Detecting…')
                : t('system.networkAddresses.bestMatch', 'Best match')}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={handleClear}
              disabled={draft.length === 0 || setAllowed.isPending}
            >
              <RotateCcw className="h-3 w-3" />
              {t('system.networkAddresses.clear', 'Clear')}
            </Button>
            {isDirty && (
              <Button
                size="sm"
                variant="secondary"
                onClick={handleReset}
                disabled={setAllowed.isPending}
              >
                {t('system.networkAddresses.discard', 'Discard')}
              </Button>
            )}
            <Button
              size="sm"
              variant="primary"
              onClick={handleSave}
              disabled={!isDirty || setAllowed.isPending}
            >
              <Save className="h-3 w-3" />
              {setAllowed.isPending
                ? t('system.networkAddresses.saving', 'Saving…')
                : t('common.save', 'Save')}
            </Button>
          </div>
        }
      >
        <div className={SECTION_BODY}>
          <p className="mb-3 text-xs text-foreground-subtle">
            {draft.length === 0
              ? t(
                  'system.networkAddresses.autoEveryNonLoopbackNon',
                  'Auto — every non-loopback / non-link-local interface participates.',
                )
              : t('system.networkAddresses.pinned', '{{value1}} pinned', {
                  value1: String(draft.length),
                })}
          </p>
          <AddressSelector
            mode="multiple"
            interfaces={interfaces}
            value={draft}
            onChange={setDraft}
            disabled={setAllowed.isPending}
            emptyMessage={
              listQuery.isLoading
                ? t('system.networkAddresses.loadingInterfaces', 'Loading interfaces…')
                : t('system.networkAddresses.noInterfacesDetected', 'No interfaces detected.')
            }
          />
        </div>
      </SectionCard>

      <AddressesCard
        book={addressesQuery.data}
        loading={addressesQuery.isLoading}
        saving={addressSaving}
        error={addressError}
        onSetRole={(input) => setAddressRole.mutate({ ...input })}
        onAdd={(baseUrl, label) => addCustomAddress.mutate({ baseUrl, label })}
        onRemove={(baseUrl) => removeCustomAddress.mutate({ baseUrl })}
      />
    </AdminPage>
  )
}
