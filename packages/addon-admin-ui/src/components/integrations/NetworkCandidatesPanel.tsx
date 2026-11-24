/**
 * The standalone "Found on the network" list of the Add device modal, for an integration whose
 * devices are found by a scan and not listed by an adoption provider: ONE list of the devices this
 * integration could take, merged from what a network scan scoped to it finds and what passive
 * discovery proposed. An integration that also has an adoption provider draws its single list in
 * `AdoptDevicesPanel`, reading the same `useNetworkScan` state.
 *
 * A row that needs parameters the provider cannot guess (an encryption key, a password) does not add
 * on click: it opens the provider's creation form prefilled with what was found, and adds through the
 * same call afterwards.
 */
import type { DiscoveredChildDevice } from '@camstack/types'
import { DeviceType } from '@camstack/types'
import {
  Button,
  DialogBody,
  DialogFooter,
  useDeviceManagerAdoptionListCandidates,
  useDeviceManagerGetCreationSchema,
  useDeviceManagerProviderCreationType,
} from '@camstack/ui-library'
import { AlertTriangle, ArrowLeft, Download, Loader2, Radar } from 'lucide-react'
import { type ReactElement, useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ConfigUISchema } from '../../types/config-ui'
import { FormBuilder } from '../form-builder/FormBuilder'
import { AdoptedMark } from './AdoptedMark'
import { ScanSubnetEditor } from './ScanSubnetEditor'
import { type NetworkRow, type NetworkScan, useNetworkScan } from './use-network-scan'

/** The adoption list is only read to flag and merge rows: one page is enough. */
const ADOPTION_PAGE_SIZE = 500

interface NetworkCandidatesPanelProps {
  readonly addonId: string
  readonly integrationId: string
  readonly onClose: () => void
}

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
}: NetworkCandidatesPanelProps): ReactElement {
  const { t } = useTranslation()
  const adoptionQuery = useDeviceManagerAdoptionListCandidates(
    { addonId, integrationId, page: 1, pageSize: ADOPTION_PAGE_SIZE },
    { retry: false },
  )
  const adoption = useMemo(
    () =>
      (adoptionQuery.data?.candidates ?? []).map((c: DiscoveredChildDevice) => ({
        childNativeId: c.childNativeId,
        name: c.name,
        alreadyAdopted: c.alreadyAdopted,
        adoptedDeviceId: c.adoptedDeviceId,
        parentStableId: c.parentStableId,
      })),
    [adoptionQuery.data],
  )
  const scan = useNetworkScan({ addonId, integrationId, adoption })
  const { rows, paramsFor, busy, added, error } = scan

  const depthOf = useCallback(
    (row: NetworkRow): number => {
      const byKey = new Map(rows.map((r) => [r.key, r]))
      let depth = 0
      let cursor: NetworkRow | undefined = row
      while (cursor?.parentKey != null && depth < 8) {
        cursor = byKey.get(cursor.parentKey)
        if (cursor === undefined) break
        depth += 1
      }
      return depth
    },
    [rows],
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
        embedded={false}
        onBack={() => scan.setParamsFor(null)}
        onSubmit={(values) => void scan.addRow(paramsFor, values)}
      />
    )
  }

  const answered = scan.proposals === 'answered' && !scan.scanning
  return (
    <>
      <DialogBody className="space-y-3">
        <ScanControls scan={scan} listed={rows.length} />
        {rows.length === 0 && answered && (
          <p className="py-6 text-center text-xs text-foreground-subtle">
            {scan.scanAnswered
              ? t('integrations.addDeviceModal.nothingFound', 'No devices responded to the scan.')
              : t(
                  'integrations.addDeviceModal.scanHint',
                  'Scan the network to find devices to add.',
                )}
          </p>
        )}
        <div className="space-y-1.5" data-testid="network-candidates">
          {rows.map((row) => (
            <CandidateRow
              key={row.key}
              row={row}
              depth={depthOf(row)}
              busy={busy.has(row.key)}
              added={added.has(row.key)}
              devicesKnown={scan.devices === 'answered'}
              onPick={scan.pick}
              onNavigate={onClose}
            />
          ))}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" size="sm" onClick={onClose}>
          {t('integrations.close', 'Close')}
        </Button>
      </DialogFooter>
    </>
  )
}

/**
 * The scan side of the list: the extra networks, the provider's scan parameters, what is known so far
 * and the scan button. Drawn above the standalone list and above the single adoption list alike.
 */
export function ScanControls({
  scan,
  listed,
}: {
  readonly scan: NetworkScan
  /** How many rows the list below shows, for the count line. */
  readonly listed: number
}): ReactElement {
  const { t } = useTranslation()
  return (
    <div className="shrink-0 space-y-3 pb-3" data-testid="scan-controls">
      <ScanSubnetEditor />
      {scan.scanParamsSchema && (
        <FormBuilder
          schema={scan.scanParamsSchema}
          values={scan.scanParams}
          onChange={scan.setScanParams}
        />
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-foreground-subtle">
          {scan.scanning
            ? t('integrations.addDeviceModal.scanning', 'Scanning the local network…')
            : listed > 0
              ? t('integrations.addDeviceModal.found', {
                  defaultValue_one: '{{count}} device found',
                  defaultValue_other: '{{count}} devices found',
                  count: listed,
                })
              : ''}
        </p>
        <Button variant="outline" size="sm" onClick={scan.runScan} disabled={scan.scanning}>
          {scan.scanning ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Radar className="h-3.5 w-3.5" />
          )}
          {t('integrations.addDeviceModal.scanNow', 'Scan now')}
        </Button>
      </div>
      {scan.scanFailed && (
        <ErrorLine
          text={t('integrations.addDeviceModal.scanFailed', 'The scan failed. Try again.')}
        />
      )}
      {scan.proposals === 'failed' && (
        <ErrorLine
          text={t(
            'integrations.addDeviceModal.proposalsFailed',
            'The devices found in the background could not be read. Scan now to look again.',
          )}
        />
      )}
      {scan.error !== null && <ErrorLine text={scan.error} />}
    </div>
  )
}

export function ErrorLine({ text }: { readonly text: string }): ReactElement {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
      <p className="text-xs text-danger">{text}</p>
    </div>
  )
}

/**
 * The add action of a found row: Add, or Enter details when the provider needs a value it cannot
 * guess. Disabled until the hub's device list has answered, so a device that is already added is
 * never offered as new (D315).
 */
export function RowAddButton({
  row,
  busy,
  devicesKnown,
  onPick,
}: {
  readonly row: NetworkRow
  readonly busy: boolean
  readonly devicesKnown: boolean
  readonly onPick: (row: NetworkRow) => void
}): ReactElement | null {
  const { t } = useTranslation()
  if (row.hit?.selectable === false) return null
  const asks = row.needsParams.length > 0
  return (
    <Button
      size="sm"
      variant={asks ? 'outline' : 'primary'}
      onClick={() => onPick(row)}
      disabled={busy || !devicesKnown}
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : asks ? null : (
        <Download className="h-3.5 w-3.5" />
      )}
      {asks
        ? t('integrations.addDeviceModal.enterDetails', 'Enter details')
        : t('common.add', 'Add')}
    </Button>
  )
}

function CandidateRow({
  row,
  depth,
  busy,
  added,
  devicesKnown,
  onPick,
  onNavigate,
}: {
  readonly row: NetworkRow
  readonly depth: number
  readonly busy: boolean
  readonly added: boolean
  readonly devicesKnown: boolean
  readonly onPick: (row: NetworkRow) => void
  readonly onNavigate: () => void
}): ReactElement {
  const already = row.alreadyAdded || added
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
      </div>
      {already ? (
        <AdoptedMark deviceId={row.deviceId} deviceName={row.addedName} onNavigate={onNavigate} />
      ) : (
        <RowAddButton row={row} busy={busy} devicesKnown={devicesKnown} onPick={onPick} />
      )}
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
  readonly row: NetworkRow
  readonly found: Readonly<Record<string, unknown>>
  readonly busy: boolean
  readonly error: string | null
  readonly onBack: () => void
  readonly onSubmit: (values: Record<string, unknown>) => void
  /** Drawn inside the adopt surface: no dialog body or footer of its own. */
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
