/**
 * Network-discovery modal — TWO modes:
 *
 * - GENERIC (no `scope`): fans `deviceManager.discoverAllProviders` across every
 *   device-provider that reports `supportsDiscovery` and shows ONE combined
 *   "scan → quick add" view. Providers that returned NO candidates are hidden.
 *
 * - PER-INTEGRATION (`scope` set): scans just that provider via
 *   `deviceManager.discoverProvider`, and first renders the provider's optional
 *   extra-param form (`providerDiscoveryParamsSchema`) — e.g. a broadcast
 *   address so Gree can find ACs on a DIFFERENT subnet than the addon node's.
 *
 * A picked candidate is adopted via the existing `deviceManager.adoptDevice`
 * (addonId-routed). Per-provider errors surface inline without failing the scan.
 */
import {
  useDeviceManagerAdoptDevice,
  useDeviceManagerDiscoverAllProviders,
  useDeviceManagerDiscoverProvider,
  useDeviceManagerListAll,
  useDeviceManagerProviderDiscoveryParamsSchema,
} from '@camstack/ui-library'
import { AlertTriangle, Check, Download, Loader2, Radar, RefreshCw, X } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import type { ConfigUISchema } from '../../types/config-ui'
import { FormBuilder } from '../form-builder/FormBuilder'
import { useTranslation } from 'react-i18next'

interface ScanScope {
  readonly addonId: string
  readonly label: string
}

interface ScanNetworkModalProps {
  readonly open: boolean
  readonly onClose: () => void
  /** When set, the modal scans ONLY this provider and shows its extra-param form. */
  readonly scope?: ScanScope
}

type AllScanData = NonNullable<ReturnType<typeof useDeviceManagerDiscoverAllProviders>['data']>
type Group = AllScanData['groups'][number]
type Candidate = Group['candidates'][number]

export function ScanNetworkModal({ open, onClose, scope }: ScanNetworkModalProps) {
  const { t } = useTranslation()
  const adopt = useDeviceManagerAdoptDevice()
  const [adopted, setAdopted] = useState<ReadonlySet<string>>(new Set())
  // A SET (not a single id) so concurrent adopts each keep their own spinner —
  // clicking a second row must not clear the first row's in-flight state.
  const [adopting, setAdopting] = useState<ReadonlySet<string>>(new Set())

  // Candidates whose stableId already exists as a device are shown as
  // "Already added" (not offered for re-adoption) instead of a live Add
  // button. Only `stableId` is read across every device type, so `slim`
  // (no config/metadata) plus the query client's fleet window (D274) — the fleet does not
  // change every second, and this converges onto the same cache entry
  // Devices.tsx / GlobalSearch already populate.
  const { data: allDevices } = useDeviceManagerListAll({ projection: 'slim' })
  const existingStableIds = useMemo(
    () => new Set((allDevices ?? []).map((d) => d.stableId)),
    [allDevices],
  )

  const handleAdopt = useCallback(
    async (addonId: string, candidate: Candidate) => {
      setAdopting((prev) => new Set(prev).add(candidate.stableId))
      try {
        await adopt.mutateAsync({ addonId, candidate })
        setAdopted((prev) => new Set(prev).add(candidate.stableId))
      } catch {
        // surfaced via the row staying actionable
      } finally {
        setAdopting((prev) => {
          const next = new Set(prev)
          next.delete(candidate.stableId)
          return next
        })
      }
    },
    [adopt],
  )

  const renderCandidate = useCallback(
    (addonId: string, candidate: Candidate) => {
      const address =
        typeof candidate.prefilledConfig['host'] === 'string'
          ? (candidate.prefilledConfig['host'] as string)
          : null
      const alreadyExists = existingStableIds.has(candidate.stableId)
      const isAdopted = adopted.has(candidate.stableId) || alreadyExists
      const isBusy = adopting.has(candidate.stableId)
      return (
        <div
          key={candidate.stableId}
          className="flex items-center justify-between rounded-lg border border-border bg-surface px-3 py-2"
        >
          <div className="min-w-0">
            <p className="truncate text-xs font-medium text-foreground">
              {candidate.suggestedName}
            </p>
            {address && (
              <p className="truncate text-[10px] font-mono text-foreground-subtle">{address}</p>
            )}
          </div>
          {isAdopted ? (
            <span className="flex items-center gap-1 text-[11px] text-foreground-subtle">
              <Check className="h-3.5 w-3.5" />{' '}
              {alreadyExists
                ? t('integrations.scanNetworkModal.alreadyAdded', 'Already added')
                : t('integrations.scanNetworkModal.added', 'Added')}
            </span>
          ) : (
            <button
              type="button"
              onClick={() => void handleAdopt(addonId, candidate)}
              disabled={isBusy}
              className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground disabled:opacity-50"
            >
              {isBusy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {t('common.add', 'Add')}
            </button>
          )}
        </div>
      )
    },
    [adopted, adopting, existingStableIds, handleAdopt, t],
  )

  if (!open) return null

  const title = scope ? `Scan network — ${scope.label}` : 'Scan network for devices'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative z-10 flex w-full max-w-2xl flex-col max-h-[calc(90dvh-2*max(env(safe-area-inset-top),env(safe-area-inset-bottom)))] rounded-xl border border-border bg-background shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-4 shrink-0">
          <div className="flex items-center gap-2">
            <Radar className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {scope ? (
          <ScopedScan
            scope={scope}
            onAdopt={renderCandidate}
            onReset={() => setAdopted(new Set())}
          />
        ) : (
          <GenericScan onAdopt={renderCandidate} onReset={() => setAdopted(new Set())} />
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Generic — every provider, hide empty groups
// ---------------------------------------------------------------------------

function GenericScan({
  onAdopt,
  onReset,
}: {
  readonly onAdopt: (addonId: string, c: Candidate) => ReactNode
  readonly onReset: () => void
}) {
  const { t } = useTranslation()
  const scan = useDeviceManagerDiscoverAllProviders()
  const runScan = useCallback(() => {
    onReset()
    scan.mutate({})
  }, [scan, onReset])

  useEffect(() => {
    if (!scan.isPending && !scan.data) runScan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Only groups that actually found devices — an installed-but-empty provider
  // is noise in the aggregated view.
  const groups = useMemo(
    () => (scan.data?.groups ?? []).filter((g) => g.candidates.length > 0),
    [scan.data],
  )
  const totalFound = useMemo(() => groups.reduce((n, g) => n + g.candidates.length, 0), [groups])

  return (
    <>
      <div className="flex items-center justify-end gap-2 border-b border-border px-5 py-2 shrink-0">
        <button
          onClick={runScan}
          disabled={scan.isPending}
          className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${scan.isPending ? 'animate-spin' : ''}`} />
          {t('integrations.scanNetworkModal.reScan', 'Re-scan')}
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
        {scan.isPending && (
          <Spinner
            label={t(
              'integrations.scanNetworkModal.scanningTheLocalNetwork',
              'Scanning the local network…',
            )}
          />
        )}
        {!scan.isPending && scan.isError && <ScanError />}
        {!scan.isPending && scan.data && groups.length === 0 && (
          <p className="py-8 text-center text-xs text-foreground-subtle">
            {t(
              'integrations.scanNetworkModal.noDevicesRespondedToThe',
              'No devices responded to the scan.',
            )}
          </p>
        )}
        {!scan.isPending && groups.length > 0 && (
          <p className="text-xs text-foreground-subtle">
            {t('integrations.scanNetworkModal.found', { count: totalFound })}
          </p>
        )}
        {!scan.isPending &&
          groups.map((group) => (
            <div key={group.addonId} className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-semibold text-foreground">{group.label}</span>
                <span className="text-[10px] text-foreground-subtle">
                  ({group.candidates.length})
                </span>
              </div>
              {group.candidates.map((c: Candidate) => onAdopt(group.addonId, c))}
            </div>
          ))}
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Per-integration — one provider, with an optional extra-param form
// ---------------------------------------------------------------------------

function ScopedScan({
  scope,
  onAdopt,
  onReset,
}: {
  readonly scope: ScanScope
  readonly onAdopt: (addonId: string, c: Candidate) => ReactNode
  readonly onReset: () => void
}) {
  const { t } = useTranslation()
  const paramsSchemaQuery = useDeviceManagerProviderDiscoveryParamsSchema({
    addonId: scope.addonId,
  })
  const paramsSchema = (paramsSchemaQuery.data ?? null) as ConfigUISchema | null
  const [params, setParams] = useState<Record<string, unknown>>({})
  const scan = useDeviceManagerDiscoverProvider()

  const runScan = useCallback(() => {
    onReset()
    scan.mutate({ addonId: scope.addonId, params })
  }, [scan, scope.addonId, params, onReset])

  const candidates = scan.data?.candidates ?? []

  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
        {paramsSchema && <FormBuilder schema={paramsSchema} values={params} onChange={setParams} />}

        <button
          onClick={runScan}
          disabled={scan.isPending}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {scan.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Radar className="h-3.5 w-3.5" />
          )}
          {scan.isPending
            ? t('integrations.scanNetworkModal.scanning', 'Scanning…')
            : t('integrations.scanNetworkModal.scan', 'Scan')}
        </button>

        {scan.isError && <ScanError />}
        {!scan.isPending && scan.data && candidates.length === 0 && (
          <p className="py-6 text-center text-xs text-foreground-subtle">
            {t(
              'integrations.scanNetworkModal.noDevicesRespondedToThe',
              'No devices responded to the scan.',
            )}
          </p>
        )}
        {!scan.isPending && candidates.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs text-foreground-subtle">
              {t('integrations.scanNetworkModal.foundShort', { count: candidates.length })}
            </p>
            {candidates.map((c: Candidate) => onAdopt(scope.addonId, c))}
          </div>
        )}
      </div>
    </>
  )
}

function Spinner({ label }: { readonly label: string }) {
  return (
    <div className="flex flex-col items-center py-12">
      <Loader2 className="h-6 w-6 animate-spin text-primary" />
      <p className="mt-3 text-xs text-foreground-subtle">{label}</p>
    </div>
  )
}

function ScanError() {
  const { t } = useTranslation()
  return (
    <div className="flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3">
      <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
      <p className="text-xs text-destructive">
        {t('integrations.scanNetworkModal.theScanFailedTryAgain', 'The scan failed. Try again.')}
      </p>
    </div>
  )
}
