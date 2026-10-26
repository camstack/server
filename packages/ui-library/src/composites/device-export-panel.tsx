/**
 * DeviceExportPanel — generic, addon-agnostic surface for the
 * `device-export` capability.
 *
 * Renders the COMMON device-export surface for a single export addon
 * (HomeAssistant via MQTT, HomeKit/HAP, Alexa Smart Home, …):
 *
 *   - a link-state status badge + exposed-device count from `getStatus`,
 *   - an optional "Setup" section (pairing QR + copyable fields) from
 *     the cap's `setup` block,
 *   - ONE unified devices overview — the shared `<DeviceList>` in its
 *     GENERIC mode (the same table `/integrations` renders), restricted
 *     to this exporter's `listSupportedDeviceKinds`.
 *
 * ── What an entry shows, and what it deliberately does not ───────────
 *
 * Three columns plus a selection box: device TYPE, NAME, EXPORT. That is
 * the whole row.
 *
 * It used to be the full device-mode row — Hardware (manufacturer ·
 * model), Features, and the merged Preview cell carrying the per-type
 * live control, the battery/charging pills, the snapshot eye, the reboot
 * quick-action, the PTZ button and the reachability dot. Every one of
 * those is reachable on `/devices` and on the device's own page; none of
 * them existed only here, which is the ONLY reason they were removable.
 * The Expose toggle is the affordance this surface owns, so it stays —
 * and the row click still opens the device page.
 *
 * ── Multi-select, and why every run reports ──────────────────────────
 *
 * Selecting rows exposes (or unexposes) them in one go. The toolbar
 * always names the COUNT the buttons will act on, and every run — bulk
 * or single-row — ends in a summary that names the devices on both
 * sides. A generic "export failed" would leave the operator re-running
 * the whole set to discover which half landed; and the previous
 * single-row toggle used `mutate` with no `onError`, so a refused
 * accessory changed nothing on screen at all.
 *
 * This composite is the reusable replacement for the per-addon
 * Module-Federation overview tables that each export addon used to
 * ship. It is driven entirely by the `device-export` cap — there are no
 * Alexa / HAP / MQTT specifics here. Mount it next to an export addon's
 * standard settings form (e.g. in the addon-settings modal).
 *
 * Routing note: `device-export` is a collection cap. Export addons are
 * all `hub-only`, so the panel queries `nodeId: 'hub'`. It also passes
 * `addonId` so the codegen'd cap-router resolves THIS addon's provider
 * within the local collection — when multiple device-export addons are
 * co-installed each panel shows its own provider, not provider[0].
 */

import { useUiText, type UiTextFn } from '../contexts/ui-text'
import { DeviceExportStatusSchema, ExposedDeviceSchema } from '@camstack/types'
import { useQueryClient } from '@tanstack/react-query'
import { Eye, EyeOff, Loader2, QrCode as QrCodeIcon, Share2, Unlink2 } from 'lucide-react'
import { type MouseEvent, type ReactElement, useCallback, useMemo, useState } from 'react'
import { z } from 'zod'
import {
  useDeviceExportExposeDevice,
  useDeviceExportGetStatus,
  useDeviceExportListExposedDevices,
  useDeviceExportListSupportedDeviceKinds,
  useDeviceExportUnexposeDevice,
  useDeviceManagerListAll,
} from '../generated/system-hooks'
import { Badge } from '../primitives/badge'
import { Button } from '../primitives/button'
import { CopyButton } from './copy-button'
import type { DeviceItemDevice } from './device-item/helpers'
import { DeviceName, useDeviceLabel } from './device-name'
import { DeviceList } from './device-list'
import type { DeviceListColumn, GenericPageSizeSelector } from './device-list/generic-mode'
import { PAGE_SIZE_ALL } from '../hooks/use-persisted-page-size'
import { MultiSelectDropdown, type MultiSelectOption } from './device-list/multi-select'
import {
  NO_EXPORT_FILTERS,
  applyExportFilters,
  deselectShown,
  providerFilterOptions,
  roleFilterOptions,
  selectShown,
  type ExportBulkFilters,
} from './export-bulk-selection'
import { deviceTypeMetaOf } from './device-meta'
import { EmptyState } from './empty-state'
import { ErrorBox } from './error-box'
import { QrCode } from './qr-code'
import { SettingRow } from './setting-row'

type DeviceExportStatus = z.infer<typeof DeviceExportStatusSchema>
type ExposedDevice = z.infer<typeof ExposedDeviceSchema>
type ExportSetup = NonNullable<DeviceExportStatus['setup']>
type ExportSetupField = NonNullable<ExportSetup['fields']>[number]

const ExposedDeviceArraySchema = z.array(ExposedDeviceSchema)

// `deviceManager.listAll` rows are codegen'd with the loose collection
// wire output. Parse each row into the exact `DeviceItemDevice` shape
// `<DeviceList>` needs — this both validates the wire data and yields a
// typed row without an `as` cast (matching the file's safeParse style).
const DeviceItemRowSchema = z.object({
  id: z.number(),
  stableId: z.string(),
  addonId: z.string(),
  type: z.string(),
  name: z.string(),
  online: z.boolean(),
  disabled: z.boolean(),
  parentDeviceId: z.number().nullable(),
  role: z.string().nullable().optional(),
  features: z.array(z.string()).optional(),
  isCamera: z.boolean().optional(),
  // NO `sourceInfo`. The fleet read below is SLIM, and slim does not carry it
  // — leaving the key here would be a field this surface claims and can never
  // receive. Nothing on this surface reads it either: its only reader is
  // `resolveContainerPrimary`, reached from a `container` row, and a container
  // cannot appear in `candidateDevices` (every `device-export` provider's
  // `listSupportedDeviceKinds` is a set of leaf types). If a provider ever
  // declares `container`, this read must stop being slim in the same commit.
})
const SupportedKindsSchema = z.array(z.string())

const STATUS_POLL_INTERVAL_MS = 10_000

/** Where the viewer's "rows per page" choice for this table is remembered. */
export const DEVICE_EXPORT_PAGE_SIZE_KEY = 'camstack.device-export.pageSize'

/**
 * The exposed-devices table's page sizes. Its own key and options, not the
 * Devices page's (25/50/100/200, default 50): the operator asked for a short
 * default here (25) and an "All" for a quick scan of every exportable device.
 */
const DEVICE_EXPORT_PAGE_SIZE: GenericPageSizeSelector = {
  options: [10, 25, 50, 100, PAGE_SIZE_ALL],
  defaultSize: 25,
  storageKey: DEVICE_EXPORT_PAGE_SIZE_KEY,
}

/**
 * The fleet-list poll. Deliberately the same 30 s as the window
 * `applyFleetQueryDefaults` registers for `deviceManager.listAll` (D274) —
 * this surface wants live data, not a window of its own, so the interval
 * matches the cadence at which every other consumer of the same key is
 * already willing to see a change.
 */
const FLEET_POLL_INTERVAL_MS = 30_000

export interface DeviceExportPanelProps {
  /**
   * Addon id of the export addon whose surface is rendered. Used for
   * labelling and to scope cache invalidation; the underlying cap
   * router resolves the (hub-resident) provider by `nodeId`.
   */
  readonly addonId: string
  /**
   * Optional callback to open a device-details page.
   *
   * There is no `trpc` prop. It existed to feed the device-mode list's per-row
   * capability atoms (snapshot, switch, live control); this surface renders
   * type + name + export and asks a device nothing, so the prop was removed
   * rather than left as a parameter every caller still threads and nothing
   * reads.
   */
  readonly onOpenDevice?: (deviceId: string) => void
  /**
   * Render the exporter's error and Setup block (pairing QR, copyable fields)
   * inside the panel. Default true. A page that places the devices table at
   * the bottom renders `<DeviceExportSetup>` near the top instead and passes
   * false, so the pairing code is not buried under settings and logs.
   */
  readonly showSetup?: boolean
}

function statusVariant(state: DeviceExportStatus['linkState']): 'success' | 'warning' | 'danger' {
  if (state === 'linked') return 'success'
  if (state === 'error') return 'danger'
  return 'warning'
}

function capitaliseLinkState(t: UiTextFn, state: string): string {
  if (state === 'linked') return t('uiLibrary.deviceExport.linked', 'Linked')
  if (state === 'unlinked') return t('uiLibrary.deviceExport.unlinked', 'Unlinked')
  if (state === 'error') return t('uiLibrary.deviceExport.error', 'Error')
  return state
}

/**
 * A single label/value row in the Setup section. `secret` rows mask the
 * value behind a reveal toggle; every row gets a copy button.
 *
 * Layout — including the L1 stack that keeps a long token readable on a phone
 * — is owned by the shared `<SettingRow>`; this component only decides what
 * the value and the affordances are.
 */
function SetupFieldRow({ field }: { readonly field: ExportSetupField }): ReactElement {
  const t = useUiText()
  const [revealed, setRevealed] = useState(false)
  const isSecret = field.secret === true
  const masked = isSecret && !revealed
  const displayValue = masked ? '•'.repeat(Math.min(field.value.length, 24)) : field.value

  return (
    <SettingRow
      label={field.label}
      valueClassName="font-mono"
      actions={
        <>
          {isSecret && (
            <Button
              size="sm"
              variant="ghost"
              type="button"
              aria-label={
                revealed
                  ? t('uiLibrary.deviceExport.hideValue', 'Hide value')
                  : t('uiLibrary.deviceExport.revealValue', 'Reveal value')
              }
              onClick={() => setRevealed((v) => !v)}
            >
              {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </Button>
          )}
          {/* srLabel, not label: the row's own header already names the field,
              and rendering it again inside the button is what pushed the text
              over the value on a narrow screen. */}
          <CopyButton value={field.value} srLabel={field.label} />
        </>
      }
    >
      {displayValue || '—'}
    </SettingRow>
  )
}

/**
 * Generic "Setup" section — pairing QR + copyable label/value rows +
 * operator note. Driven entirely by the cap's `setup` block; renders
 * nothing addon-specific.
 */
function SetupSection({ setup }: { readonly setup: ExportSetup }): ReactElement {
  const t = useUiText()
  const fields = setup.fields ?? []
  return (
    <div className="border-b border-border bg-surface-hover/10">
      <div className="flex items-center gap-2 px-2 sm:px-4 py-2 border-b border-border">
        <QrCodeIcon className="h-3.5 w-3.5 text-foreground-subtle shrink-0" />
        <span className="text-[11px] font-semibold text-foreground-subtle uppercase tracking-wide">
          {t('uiLibrary.deviceExport.setup', 'Setup')}
        </span>
      </div>
      <div className="flex flex-col gap-3 p-2 sm:p-4 sm:flex-row sm:items-start">
        {setup.qr && (
          <div className="shrink-0">
            <QrCode value={setup.qr} alt={t('uiLibrary.deviceExport.qr', 'Pairing QR code')} />
          </div>
        )}
        <div className="flex-1 min-w-0">
          {setup.note && (
            <p className="text-xs text-foreground-muted whitespace-pre-line mb-2">{setup.note}</p>
          )}
          {fields.length > 0 && (
            <div className="divide-y divide-border-subtle">
              {fields.map((field) => (
                <SetupFieldRow key={field.label} field={field} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** Parse `getStatus` against the canonical cap schema (loose wire output). */
function parseStatus(data: unknown): DeviceExportStatus | null {
  const parsed = DeviceExportStatusSchema.safeParse(data)
  return parsed.success ? parsed.data : null
}

/**
 * The exporter's error and Setup block on their own — for a page that shows
 * them above its settings while the devices table sits at the bottom. Renders
 * nothing when the exporter reports neither. Shares `getStatus`'s query key
 * with the panel, so mounting both costs one request.
 */
export function DeviceExportSetup({ addonId }: { readonly addonId: string }): ReactElement | null {
  const statusQuery = useDeviceExportGetStatus(
    { nodeId: 'hub', addonId },
    { refetchInterval: STATUS_POLL_INTERVAL_MS, retry: false },
  )
  const status = useMemo(() => parseStatus(statusQuery.data), [statusQuery.data])
  if (!status?.error && !status?.setup) return null
  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden">
      {status.error && (
        <div className="px-2 sm:px-4 py-3 border-b border-border">
          <ErrorBox message={status.error} />
        </div>
      )}
      {status.setup && <SetupSection setup={status.setup} />}
    </div>
  )
}

/** What a run did, per device, so the summary can name both sides. */
interface BulkOutcome {
  readonly action: ExportAction
  readonly total: number
  readonly succeeded: readonly string[]
  readonly failed: readonly BulkFailure[]
}

interface BulkFailure {
  readonly label: string
  readonly message: string
}

type ExportAction = 'expose' | 'unexpose'

interface ExportRowToggleProps {
  readonly addonId: string
  readonly device: DeviceItemDevice
  readonly exposed: boolean
  readonly busy: boolean
  readonly onToggle: (device: DeviceItemDevice, action: ExportAction) => void
}

interface ExportSelectCellProps {
  readonly device: DeviceItemDevice
  readonly checked: boolean
  readonly onToggle: () => void
}

function ExportSelectCell({ device, checked, onToggle }: ExportSelectCellProps): ReactElement {
  const t = useUiText()
  const label = useDeviceLabel(device, 'compact')
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={onToggle}
      onClick={(e) => e.stopPropagation()}
      aria-label={t('uiLibrary.deviceExport.select', 'Select {{name}}', { name: label })}
    />
  )
}

/**
 * Per-row Expose/Exposed toggle. Reflects whether the row's device is exposed
 * to THIS exporter and flips it through the SAME runner the bulk buttons use —
 * so a single-row refusal is reported by name instead of vanishing, which is
 * what the previous fire-and-forget `mutate` did.
 *
 * The accessible name carries the device name (`Expose Garden cam`): several
 * of these live in one table, and "Expose" alone names none of them.
 */
function ExportRowToggle({
  addonId,
  device,
  exposed,
  busy,
  onToggle,
}: ExportRowToggleProps): ReactElement {
  const t = useUiText()
  const deviceLabel = useDeviceLabel(device, 'compact')
  const handleClick = (e: MouseEvent): void => {
    e.stopPropagation()
    if (busy) return
    onToggle(device, exposed ? 'unexpose' : 'expose')
  }
  return (
    <Button
      size="sm"
      variant={exposed ? 'ghost' : 'primary'}
      disabled={busy}
      onClick={handleClick}
      aria-label={
        exposed
          ? t('uiLibrary.deviceExport.unexposeDevice', 'Unexpose {{name}}', { name: deviceLabel })
          : t('uiLibrary.deviceExport.exposeDevice', 'Expose {{name}}', { name: deviceLabel })
      }
      title={
        exposed
          ? t('uiLibrary.deviceExport.stopTitle', 'Stop exposing to "{{addon}}"', {
              addon: addonId,
            })
          : t('uiLibrary.deviceExport.exposeTitle', 'Expose to "{{addon}}"', { addon: addonId })
      }
    >
      {exposed ? (
        <>
          <Unlink2 className="mr-1 h-3.5 w-3.5" />
          {t('uiLibrary.deviceExport.exposed', 'Exposed')}
        </>
      ) : (
        <>
          <Share2 className="mr-1 h-3.5 w-3.5" />
          {t('uiLibrary.deviceExport.expose', 'Expose')}
        </>
      )}
    </Button>
  )
}

/**
 * The result of the last run, named device by device.
 *
 * Rendered for a CLEAN run too. "It probably worked" is not something an
 * operator should have to infer from silence, and a summary that appears only
 * on failure trains them to read no news as good news right up until the one
 * time the render itself was what failed.
 */
function BulkSummary({
  outcome,
  onDismiss,
}: {
  readonly outcome: BulkOutcome
  readonly onDismiss: () => void
}): ReactElement {
  const t = useUiText()
  const clean = outcome.failed.length === 0
  return (
    <div
      data-testid="export-bulk-summary"
      className={`flex flex-col gap-1 px-2 sm:px-4 py-2 border-b border-border text-[11px] ${
        clean ? 'text-foreground-subtle' : 'text-danger'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">
          {outcome.action === 'expose'
            ? t(
                'uiLibrary.deviceExport.bulkExposed',
                {
                  one: 'Exposed {{done}} of {{count}} selected device.',
                  other: 'Exposed {{done}} of {{count}} selected devices.',
                },
                { done: outcome.succeeded.length, count: outcome.total },
              )
            : t(
                'uiLibrary.deviceExport.bulkUnexposed',
                {
                  one: 'Unexposed {{done}} of {{count}} selected device.',
                  other: 'Unexposed {{done}} of {{count}} selected devices.',
                },
                { done: outcome.succeeded.length, count: outcome.total },
              )}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={onDismiss}
          aria-label={t('uiLibrary.deviceExport.dismissAria', 'Dismiss export result')}
        >
          {t('uiLibrary.deviceExport.dismiss', 'Dismiss')}
        </Button>
      </div>
      {outcome.succeeded.length > 0 && (
        <span className="text-foreground-subtle">
          {t('uiLibrary.deviceExport.succeeded', 'Succeeded: {{devices}}', {
            devices: outcome.succeeded.join(', '),
          })}
        </span>
      )}
      {outcome.failed.map((failure) => (
        <span key={failure.label}>
          {t('uiLibrary.deviceExport.failed', 'Failed: {{device}} — {{message}}', {
            device: failure.label,
            message: failure.message,
          })}
        </span>
      ))}
    </div>
  )
}

/**
 * Generic device-export panel. Addon-agnostic — only the `device-export`
 * cap drives it.
 */
export function DeviceExportPanel({
  addonId,
  onOpenDevice,
  showSetup = true,
}: DeviceExportPanelProps): ReactElement {
  const t = useUiText()
  const queryClient = useQueryClient()

  const statusQuery = useDeviceExportGetStatus(
    { nodeId: 'hub', addonId },
    { refetchInterval: STATUS_POLL_INTERVAL_MS, retry: false },
  )
  const exposedQuery = useDeviceExportListExposedDevices(
    { nodeId: 'hub', addonId },
    { refetchInterval: STATUS_POLL_INTERVAL_MS, retry: false },
  )
  const kindsQuery = useDeviceExportListSupportedDeviceKinds(
    { nodeId: 'hub', addonId },
    { retry: false },
  )
  // The fleet, SLIM and on the fleet window.
  //
  // This asked for the unprojected fleet every 5 s — the most frequent
  // whole-collection read in either UI tree (2026-08-31 audit, defect #1).
  // The full projection costs twice: every device's `config` blob on the
  // wire, and a SECOND settings-store phase server-side to produce it
  // (`device-queries.ts#readDeviceConfigs`). Measured on the reference hub
  // 2026-08-31: 5.6 s full, 2.9 s slim, `/health` 0.055 s.
  //
  // `{ projection: 'slim' }` is the SAME key Devices, GlobalSearch,
  // ScanNetworkModal, ScopePreview and IntegrationDetail already hold warm,
  // so this is a cache merge and not merely a smaller payload — with any of
  // them mounted inside the window this costs no round trip at all.
  //
  // Slim drops exactly `config`, `metadata` and `sourceInfo`. The row parse
  // below never asked for the first two; `sourceInfo` is gone from it for
  // the reason stated there.
  //
  // The interval matches the fleet's own window (D274) rather than the 10 s
  // status cadence: the FLEET is not what changes when an operator exposes a
  // device — `listExposedDevices` is, and it keeps its own poll.
  const devicesQuery = useDeviceManagerListAll(
    { projection: 'slim' },
    { refetchInterval: FLEET_POLL_INTERVAL_MS },
  )

  const invalidate = useCallback((): void => {
    queryClient.invalidateQueries({ queryKey: [['deviceExport']] })
  }, [queryClient])

  const exposeMutation = useDeviceExportExposeDevice({ onSuccess: invalidate })
  const unexposeMutation = useDeviceExportUnexposeDevice({ onSuccess: invalidate })

  // `getStatus` / `listExposedDevices` are codegen'd with loose wire
  // output schemas (collection-cap framework methods). Validate against
  // the canonical cap schemas so the panel gets typed values without an
  // `as` cast — a mismatch silently degrades to the empty/loading view.
  const status: DeviceExportStatus | null = useMemo(
    () => parseStatus(statusQuery.data),
    [statusQuery.data],
  )

  const exposed: readonly ExposedDevice[] = useMemo(() => {
    const parsed = ExposedDeviceArraySchema.safeParse(exposedQuery.data)
    return parsed.success ? parsed.data : []
  }, [exposedQuery.data])

  const exposedIds = useMemo(() => new Set(exposed.map((e) => e.deviceId)), [exposed])

  const supportedKinds = useMemo<ReadonlySet<string>>(() => {
    const parsed = SupportedKindsSchema.safeParse(kindsQuery.data)
    return new Set(parsed.success ? parsed.data : [])
  }, [kindsQuery.data])

  // Only the exporter's supported device kinds appear as type-filter
  // chips. Sorted for a stable chip order across renders.
  const supportedKindList = useMemo<readonly string[]>(
    () => [...supportedKinds].toSorted(),
    [supportedKinds],
  )

  // Restricted type-filter options for this surface — built from the same
  // shared device-type meta as every other list, so labels + icons match,
  // but scoped to the exporter's supported kinds (the only types that can
  // appear in `candidateDevices`).
  const supportedTypeOptions = useMemo<readonly MultiSelectOption[]>(
    () =>
      supportedKindList.map((kind) => {
        const meta = deviceTypeMetaOf(kind, t)
        return { id: kind, label: meta.label, icon: meta.icon }
      }),
    [supportedKindList, t],
  )

  // Rows restricted to supported kinds. Each wire row is parsed into the
  // typed `DeviceItemDevice` shape (no `as` cast); rows that fail the
  // parse or fall outside the exporter's supported kinds are dropped.
  const candidateDevices = useMemo<readonly DeviceItemDevice[]>(() => {
    const data = devicesQuery.data
    if (!Array.isArray(data)) return []
    const rows: DeviceItemDevice[] = []
    for (const raw of data) {
      const parsed = DeviceItemRowSchema.safeParse(raw)
      if (parsed.success && supportedKinds.has(parsed.data.type)) {
        rows.push(parsed.data)
      }
    }
    return rows
  }, [devicesQuery.data, supportedKinds])

  const linkState: DeviceExportStatus['linkState'] = status?.linkState ?? 'unlinked'
  const loading =
    statusQuery.isLoading ||
    exposedQuery.isLoading ||
    kindsQuery.isLoading ||
    devicesQuery.isLoading
  const exposedCount = status?.exposedDeviceCount ?? exposedIds.size
  const busy = exposeMutation.isPending || unexposeMutation.isPending

  // ── Selection + the one runner every export goes through ──────────

  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [outcome, setOutcome] = useState<BulkOutcome | null>(null)
  const [running, setRunning] = useState(false)

  const toggleSelection = useCallback((deviceId: string): void => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(deviceId)) next.delete(deviceId)
      else next.add(deviceId)
      return next
    })
  }, [])

  const clearSelection = useCallback((): void => setSelectedIds(new Set()), [])
  const dismissOutcome = useCallback((): void => setOutcome(null), [])

  /** Display label for a device id — its name, or the raw id if it left the fleet. */
  const labelFor = useCallback(
    (deviceId: string): string =>
      candidateDevices.find((d) => String(d.id) === deviceId)?.name ?? `#${deviceId}`,
    [candidateDevices],
  )

  /**
   * The ONE path an expose/unexpose takes — a single row's toggle is a run of
   * one. Every device is dispatched, every result is recorded, and a failure is
   * both logged (with `deviceId`, so it can be asked about per-camera) and
   * named on screen. Nothing here can drop a device quietly: the loop visits
   * the whole input and each visit lands in `succeeded` or in `failed`.
   */
  const runExport = useCallback(
    async (action: ExportAction, deviceIds: readonly string[]): Promise<void> => {
      if (deviceIds.length === 0 || running) return
      setRunning(true)
      setOutcome(null)
      const succeeded: string[] = []
      const failed: BulkFailure[] = []
      const mutation = action === 'expose' ? exposeMutation : unexposeMutation
      const results = await Promise.allSettled(
        deviceIds.map((deviceId) => mutation.mutateAsync({ deviceId, nodeId: 'hub', addonId })),
      )
      results.forEach((result, index) => {
        const deviceId = deviceIds[index] ?? ''
        const label = labelFor(deviceId)
        if (result.status === 'fulfilled') {
          succeeded.push(label)
          return
        }
        const message =
          result.reason instanceof Error ? result.reason.message : String(result.reason)
        console.error(`[device-export] ${action} failed`, {
          tags: { deviceId: Number.parseInt(deviceId, 10) },
          addonId,
          error: message,
        })
        failed.push({ label, message })
      })
      setOutcome({ action, total: deviceIds.length, succeeded, failed })
      setSelectedIds(new Set())
      setRunning(false)
    },
    [addonId, exposeMutation, unexposeMutation, labelFor, running],
  )

  // D875: role / provider filters narrow the rows; "select shown" then acts on
  // what the search, the type filter and these leave, across every page.
  const [bulkFilters, setBulkFilters] = useState<ExportBulkFilters>(NO_EXPORT_FILTERS)
  const roleOptions = useMemo(() => roleFilterOptions(candidateDevices), [candidateDevices])
  const providerOptions = useMemo(() => providerFilterOptions(candidateDevices), [candidateDevices])
  const shownDevices = useMemo(
    () => applyExportFilters(candidateDevices, bulkFilters),
    [candidateDevices, bulkFilters],
  )
  const setRoleFilter = useCallback(
    (roles: readonly string[]): void => setBulkFilters((f) => ({ ...f, roles })),
    [],
  )
  const setProviderFilter = useCallback(
    (providers: readonly string[]): void => setBulkFilters((f) => ({ ...f, providers })),
    [],
  )

  const selectedList = useMemo(() => [...selectedIds], [selectedIds])
  const exposeSelected = useCallback((): void => {
    void runExport('expose', selectedList)
  }, [runExport, selectedList])
  const unexposeSelected = useCallback((): void => {
    void runExport('unexpose', selectedList)
  }, [runExport, selectedList])

  const onRowToggle = useCallback(
    (device: DeviceItemDevice, action: ExportAction): void => {
      void runExport(action, [String(device.id)])
    },
    [runExport],
  )

  const onRowClick = useCallback(
    (device: DeviceItemDevice): void => onOpenDevice?.(String(device.id)),
    [onOpenDevice],
  )

  // ── The three columns, plus the selection box ─────────────────────

  const getKey = useCallback((device: DeviceItemDevice): string => String(device.id), [])
  // `stableId` is searchable but NOT a column: the operator asked for three
  // fields on screen, and a filter input is not a field. Dropping it from the
  // search too would have removed the only way to find a device whose name is
  // ambiguous.
  const getSearchText = useCallback(
    (device: DeviceItemDevice): string => `${device.name} ${device.stableId}`,
    [],
  )
  const getFilterType = useCallback((device: DeviceItemDevice): string => device.type, [])

  const columns = useMemo<readonly DeviceListColumn<DeviceItemDevice>[]>(
    () => [
      {
        key: 'select',
        header: '',
        headerClassName: 'w-8',
        cell: (device) => (
          <ExportSelectCell
            device={device}
            checked={selectedIds.has(String(device.id))}
            onToggle={() => toggleSelection(String(device.id))}
          />
        ),
      },
      {
        key: 'type',
        header: t('uiLibrary.deviceExport.colType', 'Type'),
        headerClassName: 'w-32',
        cell: (device) => {
          const meta = deviceTypeMetaOf(device.type, t)
          const TypeIcon = meta.icon
          return (
            <span className="inline-flex items-center gap-1.5 text-[11px] text-foreground-subtle">
              <TypeIcon className="h-3.5 w-3.5 shrink-0" />
              {meta.label}
            </span>
          )
        },
      },
      {
        key: 'name',
        header: t('uiLibrary.deviceExport.colName', 'Name'),
        cell: (device) => (
          <DeviceName
            device={device}
            form="compact"
            className="text-xs font-medium text-foreground"
          />
        ),
      },
      {
        key: 'export',
        header: t('uiLibrary.deviceExport.colExport', 'Export'),
        headerClassName: 'w-32 text-right',
        cellClassName: 'text-right',
        cell: (device) => (
          <ExportRowToggle
            addonId={addonId}
            device={device}
            exposed={exposedIds.has(String(device.id))}
            busy={busy}
            onToggle={onRowToggle}
          />
        ),
      },
    ],
    [addonId, busy, exposedIds, onRowToggle, selectedIds, toggleSelection, t],
  )

  const renderToolbar = useCallback(
    ({ filtered }: { readonly filtered: readonly DeviceItemDevice[] }) => (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <MultiSelectDropdown
          label={t('uiLibrary.deviceExport.filterRole', 'Role')}
          options={roleOptions}
          selected={bulkFilters.roles}
          onChange={setRoleFilter}
        />
        <MultiSelectDropdown
          label={t('uiLibrary.deviceExport.filterProvider', 'Provider')}
          options={providerOptions}
          selected={bulkFilters.providers}
          onChange={setProviderFilter}
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={filtered.length === 0}
          onClick={() => setSelectedIds((current) => selectShown(current, filtered))}
        >
          {t('uiLibrary.deviceExport.selectShown', 'Select {{count}} shown', {
            count: filtered.length,
          })}
        </Button>
        {selectedIds.size > 0 && (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setSelectedIds((current) => deselectShown(current, filtered))}
            >
              {t('uiLibrary.deviceExport.deselectShown', 'Deselect shown')}
            </Button>
            <span
              data-testid="export-selection-count"
              className="text-[11px] text-foreground-subtle"
            >
              {t('uiLibrary.deviceExport.selected', '{{count}} selected', {
                count: selectedIds.size,
              })}
            </span>
            <Button size="sm" variant="primary" disabled={busy} onClick={exposeSelected}>
              {t('uiLibrary.deviceExport.exposeN', 'Expose {{count}}', {
                count: selectedIds.size,
              })}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={unexposeSelected}>
              {t('uiLibrary.deviceExport.unexposeN', 'Unexpose {{count}}', {
                count: selectedIds.size,
              })}
            </Button>
            <Button size="sm" variant="ghost" onClick={clearSelection}>
              {t('uiLibrary.deviceExport.clear', 'Clear')}
            </Button>
          </>
        )}
      </span>
    ),
    [
      t,
      roleOptions,
      providerOptions,
      bulkFilters,
      setRoleFilter,
      setProviderFilter,
      selectedIds.size,
      busy,
      exposeSelected,
      unexposeSelected,
      clearSelection,
    ],
  )

  const hasSupportedKinds = supportedKindList.length > 0

  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-2 sm:px-4 py-2.5 border-b border-border bg-surface-hover/20">
        <div className="flex items-center gap-2 min-w-0">
          <Share2 className="h-3.5 w-3.5 text-foreground-subtle shrink-0" />
          <span className="text-[11px] font-semibold text-foreground-subtle uppercase tracking-wide">
            {t('uiLibrary.deviceExport.title', 'Exported devices')}
          </span>
          <Badge variant={statusVariant(linkState)}>{capitaliseLinkState(t, linkState)}</Badge>
          <span className="text-[11px] text-foreground-subtle">
            {t('uiLibrary.deviceExport.exposedCount', '{{count}} exposed', { count: exposedCount })}
          </span>
        </div>
        {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-foreground-subtle" />}
      </div>

      {showSetup && status?.error && (
        <div className="px-2 sm:px-4 py-3 border-b border-border">
          <ErrorBox message={status.error} />
        </div>
      )}

      {showSetup && status?.setup && <SetupSection setup={status.setup} />}

      {outcome !== null && <BulkSummary outcome={outcome} onDismiss={dismissOutcome} />}

      <div className="p-2 sm:p-3">
        {/* An unanswered query is not an empty answer. Until the kinds and
            device reads settle, `hasSupportedKinds` is false and
            `candidateDevices` is empty for the same reason a genuinely empty
            exporter looks that way — so rendering the EmptyState here told the
            operator this addon "reports no exportable device kinds" before it
            had been asked. Same defect as the storage-migration gate
            (2026-08-31): loading and absent are different facts. */}
        {loading && candidateDevices.length === 0 ? (
          <div className="flex items-center gap-2 px-1 py-6 text-xs text-foreground-subtle">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('uiLibrary.deviceExport.loading', 'Loading exportable devices…')}
          </div>
        ) : hasSupportedKinds && candidateDevices.length > 0 ? (
          // Generic mode — the SAME table `/integrations` renders, driven by an
          // explicit column list rather than the device-mode column matrix.
          // That is what lets this surface show three fields and no more
          // without inventing a fourth `TableContext` that only one caller ever
          // selects.
          <DeviceList<DeviceItemDevice>
            mode="generic"
            items={shownDevices}
            getKey={getKey}
            getSearchText={getSearchText}
            getFilterType={getFilterType}
            filterOptions={supportedTypeOptions}
            columns={columns}
            onRowClick={onOpenDevice ? onRowClick : undefined}
            toolbar={renderToolbar}
            pageSizeSelector={DEVICE_EXPORT_PAGE_SIZE}
            searchPlaceholder={t('uiLibrary.deviceExport.search', 'Search by name or stableId')}
            emptyLabel={t('uiLibrary.deviceExport.noMatch', 'No device matches this search.')}
          />
        ) : (
          <EmptyState
            icon={Share2}
            title={t('uiLibrary.deviceExport.emptyTitle', 'No exportable devices')}
            description={
              hasSupportedKinds
                ? t(
                    'uiLibrary.deviceExport.emptyKinds',
                    'No devices of the supported kinds ({{kinds}}) are available to expose to "{{addon}}".',
                    { kinds: supportedKindList.join(', '), addon: addonId },
                  )
                : t(
                    'uiLibrary.deviceExport.emptyNoKinds',
                    '"{{addon}}" reports no exportable device kinds yet.',
                    { addon: addonId },
                  )
            }
          />
        )}
      </div>
    </div>
  )
}
