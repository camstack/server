/**
 * Network-discovery modal — TWO modes:
 *
 * - GENERIC (no `scope`): fans `deviceManager.discoverAllProviders` across every
 *   device-provider that reports `supportsDiscovery` and shows ONE combined
 *   "scan → quick add" view, one section per integration. Providers that
 *   returned NO candidates are hidden.
 *
 * - PER-INTEGRATION (`scope` set): scans just that provider via
 *   `deviceManager.discoverProvider`, and first renders the provider's optional
 *   extra-param form (`providerDiscoveryParamsSchema`) — e.g. a broadcast
 *   address so Gree can find ACs on a DIFFERENT subnet than the addon node's.
 *
 * A device found behind a gateway (`parentStableId`) is nested under it. Rows
 * that can be adopted as they are carry a checkbox, so several boards go in
 * with one click; a candidate flagged `setupIntegration`, or any pick in
 * `pickMode="fill"`, hands its prefilled config to `onSetupIntegration`.
 */
import {
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  TEXT_SECTION_LABEL,
  useDeviceManagerAdoptDevice,
  useDeviceManagerDiscoverAllProviders,
  useDeviceManagerDiscoverProvider,
  useDeviceManagerListAll,
  useDeviceManagerProviderDiscoveryParamsSchema,
} from '@camstack/ui-library'
import { AlertTriangle, Check, Download, Loader2, Radar, RefreshCw } from 'lucide-react'
import { type ReactElement, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ConfigUISchema } from '../../types/config-ui'
import { FormBuilder } from '../form-builder/FormBuilder'
import { ProviderIcon } from '../shared/ProviderIcon'
import {
  integrationSetupSeed,
  needsIntegrationSetup,
  seedFromCandidate,
  type IntegrationFormSeed,
} from './integration-setup-seed'
import {
  buildCandidateTree,
  flattenCandidateNodes,
  type CandidateNode,
} from './scan-candidate-tree'
import { ScanSubnetEditor } from './ScanSubnetEditor'

interface ScanScope {
  readonly addonId: string
  readonly label: string
}

interface ScanNetworkModalProps {
  readonly open: boolean
  readonly onClose: () => void
  /** When set, the modal scans ONLY this provider and shows its extra-param form. */
  readonly scope?: ScanScope
  /**
   * A candidate flagged `setupIntegration` opens the add-integration form
   * (config prefilled) instead of adopting a device. Pairing stays on that form.
   */
  readonly onSetupIntegration?: (seed: IntegrationFormSeed) => void
  /**
   * `fill`: every pick hands its config to `onSetupIntegration` (the wizard's
   * Scan button fills the form it is open on). Default `adopt`.
   */
  readonly pickMode?: 'adopt' | 'fill'
}

type AllScanData = NonNullable<ReturnType<typeof useDeviceManagerDiscoverAllProviders>['data']>
type Group = AllScanData['groups'][number]
type Candidate = Group['candidates'][number]

interface BulkEntry {
  readonly addonId: string
  readonly candidate: Candidate
}

interface ScanSelection {
  readonly selected: ReadonlySet<string>
  readonly toggle: (stableId: string) => void
}

export function ScanNetworkModal({
  open,
  onClose,
  scope,
  onSetupIntegration,
  pickMode = 'adopt',
}: ScanNetworkModalProps): ReactElement {
  const { t } = useTranslation()
  const adopt = useDeviceManagerAdoptDevice()
  const [adopted, setAdopted] = useState<ReadonlySet<string>>(new Set())
  // A SET (not a single id) so concurrent adopts each keep their own spinner —
  // clicking a second row must not clear the first row's in-flight state.
  const [adopting, setAdopting] = useState<ReadonlySet<string>>(new Set())
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())

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

  const adoptOne = useCallback(
    async (addonId: string, candidate: Candidate) => {
      setAdopting((prev) => new Set(prev).add(candidate.stableId))
      try {
        await adopt.mutateAsync({ addonId, candidate })
        setAdopted((prev) => new Set(prev).add(candidate.stableId))
        setSelected((prev) => {
          const next = new Set(prev)
          next.delete(candidate.stableId)
          return next
        })
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

  const handlePick = useCallback(
    async (addonId: string, candidate: Candidate) => {
      const seed =
        pickMode === 'fill'
          ? seedFromCandidate(addonId, candidate)
          : integrationSetupSeed(addonId, candidate)
      if (seed !== null) {
        onSetupIntegration?.(seed)
        onClose()
        return
      }
      await adoptOne(addonId, candidate)
    },
    [adoptOne, onClose, onSetupIntegration, pickMode],
  )

  const toggle = useCallback((stableId: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(stableId)) next.delete(stableId)
      else next.add(stableId)
      return next
    })
  }, [])

  const reset = useCallback(() => {
    setAdopted(new Set())
    setSelected(new Set())
  }, [])

  const rowContext = useMemo<RowContext>(
    () => ({
      existingStableIds,
      adopted,
      adopting,
      selection: { selected, toggle },
      pick: handlePick,
      adoptOne,
      fill: pickMode === 'fill',
    }),
    [existingStableIds, adopted, adopting, selected, toggle, handlePick, pickMode],
  )

  const title = scope
    ? t('integrations.scanNetworkModal.titleScoped', 'Scan network — {{label}}', {
        label: scope.label,
      })
    : t('integrations.scanNetworkModal.title', 'Scan network for devices')

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent width="lg" placement="sheet-on-mobile" scroll="body">
        <DialogHeader>
          <DialogTitle>
            <span className="flex items-center gap-2">
              <Radar className="h-4 w-4 text-primary" />
              {title}
            </span>
          </DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <ScanSubnetEditor />
          {scope ? (
            <ScopedScan scope={scope} row={rowContext} onReset={reset} />
          ) : (
            <GenericScan row={rowContext} onReset={reset} />
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface RowContext {
  readonly existingStableIds: ReadonlySet<string>
  readonly adopted: ReadonlySet<string>
  readonly adopting: ReadonlySet<string>
  readonly selection: ScanSelection
  readonly pick: (addonId: string, candidate: Candidate) => Promise<void>
  readonly adoptOne: (addonId: string, candidate: Candidate) => Promise<void>
  readonly fill: boolean
}

/** Whether a row can be ticked and added in bulk. */
function isBulkSelectable(candidate: Candidate, fill: boolean): boolean {
  return !fill && candidate.selectable !== false && !needsIntegrationSetup(candidate)
}

function CandidateRows({
  addonId,
  nodes,
  row,
  depth,
}: {
  readonly addonId: string
  readonly nodes: readonly CandidateNode<Candidate>[]
  readonly row: RowContext
  readonly depth: number
}): ReactElement {
  return (
    <div
      className={depth === 0 ? 'space-y-1.5' : 'ml-4 space-y-1.5 border-l border-border pl-3'}
      data-testid={depth === 0 ? undefined : 'scan-children'}
    >
      {nodes.map((node) => (
        <div key={node.candidate.stableId} className="space-y-1.5">
          <CandidateRow addonId={addonId} candidate={node.candidate} row={row} />
          {node.children.length > 0 && (
            <CandidateRows addonId={addonId} nodes={node.children} row={row} depth={depth + 1} />
          )}
        </div>
      ))}
    </div>
  )
}

function CandidateRow({
  addonId,
  candidate,
  row,
}: {
  readonly addonId: string
  readonly candidate: Candidate
  readonly row: RowContext
}): ReactElement {
  const { t } = useTranslation()
  const host = candidate.prefilledConfig['host']
  const address = typeof host === 'string' ? host : null
  // The provider matches a candidate to a stored device by more than the scan key
  // (Reolink scans `host-<ip>`, stores `mac-<mac>`), so its verdict counts too:
  // re-adding would overwrite the stored settings.
  const alreadyExists =
    row.existingStableIds.has(candidate.stableId) ||
    candidate.alreadyOnboarded === true ||
    candidate.onboardedDeviceId !== undefined
  const isAdopted = row.adopted.has(candidate.stableId) || alreadyExists
  const isBusy = row.adopting.has(candidate.stableId)
  const setup = row.fill || needsIntegrationSetup(candidate)
  const actionable = !isAdopted && (setup || candidate.selectable !== false)
  const bulk = actionable && isBulkSelectable(candidate, row.fill)

  return (
    <div
      className="flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2"
      data-testid={`scan-row-${candidate.stableId}`}
    >
      {bulk && (
        <Checkbox
          checked={row.selection.selected.has(candidate.stableId)}
          onChange={() => row.selection.toggle(candidate.stableId)}
          disabled={isBusy}
          aria-label={t('integrations.scanNetworkModal.select', 'Select {{name}}', {
            name: candidate.suggestedName,
          })}
        />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-foreground">{candidate.suggestedName}</p>
        {address && (
          <p className="truncate font-mono text-[10px] text-foreground-subtle">{address}</p>
        )}
        {alreadyExists && candidate.onboardedName !== undefined && (
          <p className="truncate text-[10px] text-foreground-subtle">{candidate.onboardedName}</p>
        )}
      </div>
      {isAdopted ? (
        <span className="flex items-center gap-1 text-[11px] text-foreground-subtle">
          <Check className="h-3.5 w-3.5" />{' '}
          {alreadyExists
            ? t('integrations.scanNetworkModal.alreadyAdded', 'Already added')
            : t('integrations.scanNetworkModal.added', 'Added')}
        </span>
      ) : actionable ? (
        <Button
          size="sm"
          variant={setup ? 'outline' : 'primary'}
          onClick={() => void row.pick(addonId, candidate)}
          disabled={isBusy}
        >
          {isBusy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : setup ? null : (
            <Download className="h-3.5 w-3.5" />
          )}
          {setup
            ? row.fill
              ? t('integrations.scanNetworkModal.use', 'Use')
              : t('integrations.scanNetworkModal.setUp', 'Set up')
            : t('common.add', 'Add')}
        </Button>
      ) : null}
    </div>
  )
}

function IntegrationGroup({
  addonId,
  label,
  candidates,
  row,
}: {
  readonly addonId: string
  readonly label: string
  readonly candidates: readonly Candidate[]
  readonly row: RowContext
}): ReactElement {
  const nodes = useMemo(() => buildCandidateTree(candidates), [candidates])
  return (
    <section className="space-y-2" data-testid={`scan-group-${addonId}`}>
      <h3 className="flex items-center gap-2">
        <ProviderIcon type={addonId} size="sm" />
        <span className={TEXT_SECTION_LABEL}>{label}</span>
        <span className="text-[10px] text-foreground-subtle">({candidates.length})</span>
      </h3>
      <CandidateRows addonId={addonId} nodes={nodes} row={row} depth={0} />
    </section>
  )
}

/** Candidates of a group the footer can add in bulk, in tree order. */
function bulkCandidates(
  groups: readonly { addonId: string; candidates: readonly Candidate[] }[],
  fill: boolean,
): readonly BulkEntry[] {
  return groups.flatMap((g) =>
    flattenCandidateNodes(buildCandidateTree(g.candidates))
      .filter((c) => isBulkSelectable(c, fill))
      .map((candidate) => ({ addonId: g.addonId, candidate })),
  )
}

// ---------------------------------------------------------------------------
// Generic — every provider, hide empty groups
// ---------------------------------------------------------------------------

function GenericScan({
  row,
  onReset,
}: {
  readonly row: RowContext
  readonly onReset: () => void
}): ReactElement {
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

  const bulk = useMemo(() => bulkCandidates(groups, row.fill), [groups, row.fill])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-foreground-subtle">
          {!scan.isPending && groups.length > 0
            ? t('integrations.scanNetworkModal.found', { count: totalFound })
            : null}
        </p>
        <div className="flex items-center gap-2">
          <AddSelectedButton entries={bulk} row={row} />
          <Button variant="outline" size="sm" onClick={runScan} disabled={scan.isPending}>
            <RefreshCw className={`h-3.5 w-3.5 ${scan.isPending ? 'animate-spin' : ''}`} />
            {t('integrations.scanNetworkModal.reScan', 'Re-scan')}
          </Button>
        </div>
      </div>
      {scan.isPending && (
        <Spinner
          label={t(
            'integrations.scanNetworkModal.scanningTheLocalNetwork',
            'Scanning the local network…',
          )}
        />
      )}
      {!scan.isPending && scan.isError && <ScanError />}
      {!scan.isPending && scan.data && groups.length === 0 && <NothingFound />}
      {!scan.isPending &&
        groups.map((group) => (
          <IntegrationGroup
            key={group.addonId}
            addonId={group.addonId}
            label={group.label}
            candidates={group.candidates}
            row={row}
          />
        ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Per-integration — one provider, with an optional extra-param form
// ---------------------------------------------------------------------------

function ScopedScan({
  scope,
  row,
  onReset,
}: {
  readonly scope: ScanScope
  readonly row: RowContext
  readonly onReset: () => void
}): ReactElement {
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

  const candidates = useMemo(() => scan.data?.candidates ?? [], [scan.data])

  const bulk = useMemo(
    () => bulkCandidates([{ addonId: scope.addonId, candidates }], row.fill),
    [scope.addonId, candidates, row.fill],
  )

  return (
    <div className="space-y-4">
      {paramsSchema && <FormBuilder schema={paramsSchema} values={params} onChange={setParams} />}

      <Button onClick={runScan} disabled={scan.isPending}>
        {scan.isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Radar className="h-3.5 w-3.5" />
        )}
        {scan.isPending
          ? t('integrations.scanNetworkModal.scanning', 'Scanning…')
          : t('integrations.scanNetworkModal.scan', 'Scan')}
      </Button>

      <AddSelectedButton entries={bulk} row={row} />

      {scan.isError && <ScanError />}
      {!scan.isPending && scan.data && candidates.length === 0 && <NothingFound />}
      {!scan.isPending && candidates.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-foreground-subtle">
            {t('integrations.scanNetworkModal.foundShort', {
              count: candidates.length,
            })}
          </p>
          <IntegrationGroup
            addonId={scope.addonId}
            label={scope.label}
            candidates={candidates}
            row={row}
          />
        </div>
      )}
    </div>
  )
}

/** Adds every ticked row of the section in one go; hidden until something is ticked. */
function AddSelectedButton({
  entries,
  row,
}: {
  readonly entries: readonly BulkEntry[]
  readonly row: RowContext
}): ReactElement | null {
  const { t } = useTranslation()
  const picked = entries.filter((e) => row.selection.selected.has(e.candidate.stableId))
  if (picked.length === 0) return null
  const addAll = async (): Promise<void> => {
    for (const e of picked) await row.adoptOne(e.addonId, e.candidate)
  }
  return (
    <Button size="sm" onClick={() => void addAll()} data-testid="scan-add-selected">
      <Download className="h-3.5 w-3.5" />
      {t('integrations.scanNetworkModal.addSelected', 'Add selected ({{count}})', {
        count: picked.length,
      })}
    </Button>
  )
}

function NothingFound(): ReactElement {
  const { t } = useTranslation()
  return (
    <p className="py-6 text-center text-xs text-foreground-subtle">
      {t(
        'integrations.scanNetworkModal.noDevicesRespondedToThe',
        'No devices responded to the scan.',
      )}
    </p>
  )
}

function Spinner({ label }: { readonly label: string }): ReactElement {
  return (
    <div className="flex flex-col items-center py-12">
      <Loader2 className="h-6 w-6 animate-spin text-primary" />
      <p className="mt-3 text-xs text-foreground-subtle">{label}</p>
    </div>
  )
}

function ScanError(): ReactElement {
  const { t } = useTranslation()
  return (
    <div className="flex items-start gap-3 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
      <p className="text-xs text-danger">
        {t('integrations.scanNetworkModal.theScanFailedTryAgain', 'The scan failed. Try again.')}
      </p>
    </div>
  )
}
