/**
 * "Found on the network" tab of the Add device modal: ONE list of the devices
 * this integration could take, merged from what its adoption provider lists,
 * what a network scan scoped to it finds, and what passive discovery proposed.
 *
 * A row that needs parameters the provider cannot guess (an encryption key, a
 * password) does not add on click: it opens the provider's creation form
 * prefilled with what was found, and adds through the same call afterwards.
 */
import type { DiscoveredChildDevice } from '@camstack/types'
import {
  Button,
  DialogBody,
  DialogFooter,
  useDeviceManagerAdoptDevice,
  useDeviceManagerAdoptionListCandidates,
  useDeviceManagerAdoptionStartJob,
  useDeviceManagerDiscoverProvider,
  useDeviceManagerGetCreationSchema,
  useDeviceManagerListAll,
  useDeviceManagerListDiscoveryProposals,
  useDeviceManagerProviderCreationType,
  useDeviceManagerProviderDiscoveryParamsSchema,
} from '@camstack/ui-library'
import { DeviceType } from '@camstack/types'
import { useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft, Check, Download, Loader2, Radar } from 'lucide-react'
import { type ReactElement, useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ConfigUISchema } from '../../types/config-ui'
import { FormBuilder } from '../form-builder/FormBuilder'
import { integrationSetupSeed, type IntegrationFormSeed } from './integration-setup-seed'
import { mergeNetworkCandidates, type NetworkCandidate } from './network-candidates'
import { ScanSubnetEditor } from './ScanSubnetEditor'

/** The adoption list is only read to flag and merge rows: one page is enough. */
const ADOPTION_PAGE_SIZE = 500

interface NetworkCandidatesPanelProps {
  readonly addonId: string
  readonly integrationId: string
  readonly onClose: () => void
  /** A candidate flagged `setupIntegration` opens the integration form instead. */
  readonly onSetupIntegration?: (seed: IntegrationFormSeed) => void
  /**
   * The adopt surface is drawn right below this one: only what the scan and
   * passive discovery found is listed here, and a device the adoption list
   * already holds is left to it, so it is shown once.
   */
  readonly alongsideAdoption?: boolean
}

type ScanData = NonNullable<ReturnType<typeof useDeviceManagerDiscoverProvider>['data']>
type Hit = ScanData['candidates'][number]
type Row = NetworkCandidate<Hit>

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Seed the creation form: schema defaults, then what the candidate was found with. */
function seedValues(schema: ConfigUISchema | null, found: Readonly<Record<string, unknown>>) {
  const values: Record<string, unknown> = {}
  for (const section of schema?.sections ?? []) {
    for (const field of section.fields) {
      if ('key' in field && field.key && 'default' in field && field.default !== undefined) {
        values[field.key] = field.default
      }
    }
  }
  return { ...values, ...found }
}

export function NetworkCandidatesPanel({
  addonId,
  integrationId,
  onClose,
  onSetupIntegration,
  alongsideAdoption = false,
}: NetworkCandidatesPanelProps): ReactElement {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const paramsSchemaQuery = useDeviceManagerProviderDiscoveryParamsSchema({ addonId })
  const scanParamsSchema = (paramsSchemaQuery.data ?? null) as ConfigUISchema | null
  const [scanParams, setScanParams] = useState<Record<string, unknown>>({})
  const scan = useDeviceManagerDiscoverProvider()

  const proposalsQuery = useDeviceManagerListDiscoveryProposals({})
  const adoptionQuery = useDeviceManagerAdoptionListCandidates(
    { addonId, integrationId, page: 1, pageSize: ADOPTION_PAGE_SIZE },
    { retry: false },
  )
  const { data: allDevices } = useDeviceManagerListAll({ projection: 'slim' })

  const adoptDevice = useDeviceManagerAdoptDevice()
  const startJob = useDeviceManagerAdoptionStartJob()
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [paramsFor, setParamsFor] = useState<Row | null>(null)

  const rows = useMemo<readonly Row[]>(() => {
    const adoption = (adoptionQuery.data?.candidates ?? []).map((c: DiscoveredChildDevice) => ({
      childNativeId: c.childNativeId,
      name: c.name,
      alreadyAdopted: c.alreadyAdopted,
      parentStableId: c.parentStableId,
    }))
    const proposals = (proposalsQuery.data?.proposals ?? [])
      .filter((p) => p.addonId === addonId)
      .map((p) => ({ id: p.id, candidate: p.candidate }))
    return mergeNetworkCandidates<Hit>({
      adoption,
      scan: scan.data?.candidates ?? [],
      proposals,
      existingStableIds: new Set((allDevices ?? []).map((d) => d.stableId)),
    })
  }, [adoptionQuery.data, proposalsQuery.data, scan.data, allDevices, addonId])

  // Next to the adopt list, a row it already holds is left to it — unless the scan hit
  // carries what only this block can act on: a parameter to ask for, or an integration to set up.
  const holdsScanOnlyAction = (r: Row): boolean =>
    r.hit !== null && (r.needsParams.length > 0 || r.hit.setupIntegration === true)
  const visibleRows = useMemo(
    () =>
      alongsideAdoption
        ? rows.filter((r) => !r.sources.includes('adoption') || holdsScanOnlyAction(r))
        : rows,
    [rows, alongsideAdoption],
  )
  const inAdoptionList = alongsideAdoption
    ? rows.filter(
        (r) => r.sources.includes('adoption') && r.hit !== null && !visibleRows.includes(r),
      ).length
    : 0

  const depthOf = useCallback(
    (row: Row): number => {
      const byKey = new Map(visibleRows.map((r) => [r.key, r]))
      let depth = 0
      let cursor: Row | undefined = row
      while (cursor?.parentKey != null && depth < 8) {
        cursor = byKey.get(cursor.parentKey)
        if (cursor === undefined) break
        depth += 1
      }
      return depth
    },
    [visibleRows],
  )

  const runScan = useCallback(() => {
    setError(null)
    scan.mutate({ addonId, params: scanParams })
  }, [scan, addonId, scanParams])

  const withBusy = useCallback(
    async (key: string, work: () => Promise<void>) => {
      setBusy((prev) => new Set(prev).add(key))
      setError(null)
      try {
        await work()
        setAdded((prev) => new Set(prev).add(key))
        void queryClient.invalidateQueries({ queryKey: [['deviceManager']] })
        void queryClient.invalidateQueries({ queryKey: [['integrations']] })
      } catch (err) {
        setError(errorText(err))
      } finally {
        setBusy((prev) => {
          const next = new Set(prev)
          next.delete(key)
          return next
        })
      }
    },
    [queryClient],
  )

  const addRow = useCallback(
    async (row: Row, config?: Readonly<Record<string, unknown>>) => {
      const hit = row.hit
      if (hit !== null) {
        const seed = integrationSetupSeed(addonId, hit)
        if (seed !== null) {
          onSetupIntegration?.(seed)
          onClose()
          return
        }
        await withBusy(row.key, async () => {
          await adoptDevice.mutateAsync({
            addonId,
            integrationId,
            candidate: { ...hit, prefilledConfig: { ...hit.prefilledConfig, ...config } },
          })
          setParamsFor(null)
        })
        return
      }
      if (row.adoptionId !== null) {
        const childNativeId = row.adoptionId
        await withBusy(row.key, async () => {
          await startJob.mutateAsync({ addonId, integrationId, childNativeIds: [childNativeId] })
        })
      }
    },
    [adoptDevice, startJob, addonId, integrationId, onClose, onSetupIntegration, withBusy],
  )

  const pick = useCallback(
    (row: Row) => {
      if (row.needsParams.length > 0 && row.hit !== null) {
        setError(null)
        setParamsFor(row)
        return
      }
      void addRow(row)
    },
    [addRow],
  )

  if (paramsFor !== null && paramsFor.hit !== null) {
    return (
      <CandidateParamsStep
        addonId={addonId}
        integrationId={integrationId}
        row={paramsFor}
        found={paramsFor.hit.prefilledConfig}
        busy={busy.has(paramsFor.key)}
        error={error}
        embedded={alongsideAdoption}
        onBack={() => setParamsFor(null)}
        onSubmit={(values) => void addRow(paramsFor, values)}
      />
    )
  }

  const empty = visibleRows.length === 0
  const content = (
    <>
      <ScanSubnetEditor />
      {scanParamsSchema && (
        <FormBuilder schema={scanParamsSchema} values={scanParams} onChange={setScanParams} />
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-foreground-subtle">
          {scan.isPending
            ? t('integrations.addDeviceModal.scanning', 'Scanning the local network…')
            : visibleRows.length > 0
              ? t('integrations.addDeviceModal.found', {
                  defaultValue_one: '{{count}} device found',
                  defaultValue_other: '{{count}} devices found',
                  count: visibleRows.length,
                })
              : ''}
          {!scan.isPending && inAdoptionList > 0
            ? ` · ${t('integrations.addDeviceModal.alsoAdopted', {
                defaultValue_one: '{{count}} also in the adoption list',
                defaultValue_other: '{{count}} also in the adoption list',
                count: inAdoptionList,
              })}`
            : ''}
        </p>
        <Button variant="outline" size="sm" onClick={runScan} disabled={scan.isPending}>
          {scan.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Radar className="h-3.5 w-3.5" />
          )}
          {t('integrations.addDeviceModal.scanNow', 'Scan now')}
        </Button>
      </div>
      {scan.isError && (
        <ErrorLine
          text={t('integrations.addDeviceModal.scanFailed', 'The scan failed. Try again.')}
        />
      )}
      {error !== null && <ErrorLine text={error} />}
      {empty && !scan.isPending && (
        <p className="py-6 text-center text-xs text-foreground-subtle">
          {scan.data
            ? t('integrations.addDeviceModal.nothingFound', 'No devices responded to the scan.')
            : t('integrations.addDeviceModal.scanHint', 'Scan the network to find devices to add.')}
        </p>
      )}
      <div
        className={alongsideAdoption ? 'max-h-48 space-y-1.5 overflow-y-auto' : 'space-y-1.5'}
        data-testid="network-candidates"
      >
        {visibleRows.map((row) => (
          <CandidateRow
            key={row.key}
            row={row}
            depth={depthOf(row)}
            busy={busy.has(row.key)}
            added={added.has(row.key)}
            onPick={pick}
          />
        ))}
      </div>
    </>
  )
  if (alongsideAdoption) {
    return <div className="shrink-0 space-y-3 border-b border-border pb-3">{content}</div>
  }
  return (
    <>
      <DialogBody className="space-y-3">{content}</DialogBody>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>
          {t('integrations.close', 'Close')}
        </Button>
      </DialogFooter>
    </>
  )
}

function ErrorLine({ text }: { readonly text: string }): ReactElement {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
      <p className="text-xs text-danger">{text}</p>
    </div>
  )
}

function CandidateRow({
  row,
  depth,
  busy,
  added,
  onPick,
}: {
  readonly row: Row
  readonly depth: number
  readonly busy: boolean
  readonly added: boolean
  readonly onPick: (row: Row) => void
}): ReactElement {
  const { t } = useTranslation()
  const already = row.alreadyAdded || added
  const setup = row.hit !== null && integrationSetupSeed('', row.hit) !== null
  const selectable = row.hit?.selectable !== false
  const asks = row.needsParams.length > 0
  return (
    <div
      className={`flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2 ${
        depth > 0 ? 'ml-4' : ''
      }`}
      data-testid={`network-row-${row.key}`}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-foreground">{row.name}</p>
        {row.address !== null && (
          <p className="truncate font-mono text-[10px] text-foreground-subtle">{row.address}</p>
        )}
        {already && row.addedName !== null && (
          <p className="truncate text-[10px] text-foreground-subtle">{row.addedName}</p>
        )}
      </div>
      {already ? (
        <span className="flex items-center gap-1 text-[11px] text-foreground-subtle">
          <Check className="h-3.5 w-3.5" />
          {row.alreadyAdded
            ? t('integrations.scanNetworkModal.alreadyAdded', 'Already added')
            : t('integrations.scanNetworkModal.added', 'Added')}
        </span>
      ) : selectable ? (
        <Button
          size="sm"
          variant={setup || asks ? 'outline' : 'primary'}
          onClick={() => onPick(row)}
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : setup || asks ? null : (
            <Download className="h-3.5 w-3.5" />
          )}
          {setup
            ? t('integrations.scanNetworkModal.setUp', 'Set up')
            : asks
              ? t('integrations.addDeviceModal.enterDetails', 'Enter details')
              : t('common.add', 'Add')}
        </Button>
      ) : null}
    </div>
  )
}

/**
 * The parameters a candidate still needs: the provider's creation form,
 * prefilled with what was found. The provider decides whether what was typed is
 * enough and refuses with the reason when it is not.
 */
export function CandidateParamsStep({
  addonId,
  integrationId,
  row,
  found,
  busy,
  error,
  onBack,
  onSubmit,
  embedded,
}: {
  readonly addonId: string
  readonly integrationId: string
  readonly row: Row
  readonly found: Readonly<Record<string, unknown>>
  readonly busy: boolean
  readonly error: string | null
  readonly onBack: () => void
  readonly onSubmit: (values: Record<string, unknown>) => void
  /** Drawn above the adopt surface: no dialog body or footer of its own. */
  readonly embedded: boolean
}): ReactElement {
  const { t } = useTranslation()
  const typeQuery = useDeviceManagerProviderCreationType({ addonId, integrationId })
  const type = typeQuery.data?.deviceType ?? null
  const schemaQuery = useDeviceManagerGetCreationSchema(
    { addonId, integrationId, type: type ?? DeviceType.Camera },
    { enabled: typeQuery.isSuccess && type !== null },
  )
  const schema = (schemaQuery.data ?? null) as ConfigUISchema | null
  const [values, setValues] = useState<Record<string, unknown> | null>(null)
  const current = values ?? seedValues(schema, found)
  // Pending, answered with no creation type, and failed are three different
  // states: only the first one is a spinner.
  const failure = typeQuery.error ?? schemaQuery.error
  const noType = typeQuery.isSuccess && type === null
  const ready = schema !== null
  const stateBody = ready ? (
    <FormBuilder schema={schema} values={current} onChange={setValues} />
  ) : failure ? (
    <ErrorLine text={errorText(failure)} />
  ) : noType ? (
    <p className="text-xs text-foreground-muted">
      {t(
        'integrations.addDeviceModal.noCreationType',
        'This integration cannot create a device from this candidate.',
      )}
    </p>
  ) : (
    <Loader2 className="mx-auto h-5 w-5 animate-spin text-primary" />
  )
  const body = (
    <>
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft className="h-3.5 w-3.5" />
        {t('integrations.addDeviceModal.back', 'Back to the list')}
      </Button>
      <p className="text-xs font-medium text-foreground">{row.name}</p>
      {stateBody}
      {error !== null && <ErrorLine text={error} />}
    </>
  )
  const footer = (
    <>
      <Button variant="outline" size="sm" onClick={onBack}>
        {t('integrations.cancel', 'Cancel')}
      </Button>
      <Button
        variant="primary"
        size="sm"
        onClick={() => onSubmit(current)}
        disabled={busy || !ready}
      >
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {t('common.add', 'Add')}
      </Button>
    </>
  )
  if (embedded) {
    return (
      <div className="shrink-0 space-y-3 border-b border-border pb-3">
        {body}
        <div className="flex justify-end gap-2">{footer}</div>
      </div>
    )
  }
  return (
    <>
      <DialogBody className="space-y-3">{body}</DialogBody>
      <DialogFooter>{footer}</DialogFooter>
    </>
  )
}
