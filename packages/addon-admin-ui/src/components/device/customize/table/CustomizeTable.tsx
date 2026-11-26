/**
 * The Customize tab's ONE table: every parameter the catalog offers for this
 * device, grouped by section. A row is listed when something is linked or
 * served for it (value + source); the rest are attached from the "+ Add
 * customization" picker. Editing a scalar link opens the existing
 * ScalarOverrideDialog; an event, a list or an extension opens its own editor
 * (D315: unread applicability is said, never read as "nothing to add").
 */
import {
  CAP_CUSTOMIZE_CATALOG,
  type CustomizeCatalog,
  type DeviceInfo,
  DeviceType,
} from '@camstack/types'
import {
  Button,
  type DataColumn,
  DataTable,
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownTrigger,
  ErrorBox,
  IconButton,
  SectionCard,
} from '@camstack/ui-library'
import { Pencil, SlidersHorizontal } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AssignmentFacts } from '../assignment-availability'
import { currentComposition } from '../customization-read'
import { featureOf } from '../customization-save'
import type { DefaultConsumable } from '../default-consumables'
import {
  isLinkedActionLine,
  LinkedActionButtons,
  LinkedActionItem,
  LinkedActionSource,
  type LinkedActionsState,
  type LinkedActionTableLine,
  LinkedActionValue,
  linkedActionTableLines,
  useLinkedActions,
} from '../kinds/LinkedActionsCard'
import {
  hasLinkedCameras,
  isLinkedCameraLine,
  LinkedCameraButtons,
  LinkedCameraItem,
  type LinkedCamerasState,
  LinkedCameraValue,
  type LinkedCameraTableLine,
  useLinkedCameras,
} from '../kinds/LinkedCamerasRows'
import { EXTENSION_SLOT_ROWS } from '../kinds/ExtensionSlotSections'
import {
  isLinkedDeviceLine,
  LinkedDeviceButtons,
  LinkedDeviceItem,
  LinkedDeviceSource,
  type LinkedDevicesState,
  type LinkedDeviceTableLine,
  LinkedDeviceValue,
} from '../kinds/LinkedDevicesRows'
import type { Known } from '../known'
import {
  TriggerButtons,
  TriggerItem,
  TriggerSource,
  TriggerValue,
} from '../triggers/TriggerRowCells'
import {
  isTriggerLine,
  type TriggeredByState,
  type TriggerTableLine,
  useTriggeredBy,
} from '../triggers/useTriggeredBy'
import { followSwitchRowListed } from '../scalar/follow-switch'
import { scalarRowTitle, storedScalarFeature } from '../scalar/use-scalar-row'
import type { CameraSensorsRead } from '../use-camera-sensors-presence'
import type { CustomizationHandle } from '../use-customization'
import {
  CapLinkActionsCell,
  CapLinkDialog,
  CapLinkSourceCell,
  CapLinkValueCell,
} from './CapLinkRow'
import { ConfigSourceCell, ConfigValueCell } from './ConfigRowCells'
import { capLinkOfferedOn, type OfferedCapLink } from './cap-link-edit'
import {
  CUSTOMIZE_SECTIONS,
  type CustomizeRowPlan,
  type CustomizeRowSpec,
  type CustomizeSection,
  offeredRows,
  planRows,
  splitRows,
} from './customize-rows'
import { EventActionsCell, EventSourceCell, EventValueCell } from './EventRowCells'
import {
  CapActionsCell,
  capGroupTitle,
  FieldActionsCell,
  FieldRowDialog,
  FieldSourceCell,
  FieldValueCell,
  fieldRowTitle,
} from './ExtraRowCells'
import { catalogCoveredCaps, offCatalogCards } from './extra-rows'
import { FillFromDeviceDialog } from './FillFromDeviceDialog'
import {
  type FieldGroup,
  type FieldRow,
  fieldGroups,
  fieldRowState,
  itemFieldRows,
} from './field-rows'
import { KeyedActionsCell } from './KeyedActionsCell'
import { KeyedValueCell } from './KeyedValueCell'
import { ManagedRowDialog } from './ManagedRowDialog'
import {
  ScalarActionsCell,
  ScalarDialogHost,
  ScalarSourceCell,
  ScalarValueCell,
} from './ScalarRowParts'
import { useFieldSources } from './use-field-sources'

export interface CustomizeTableProps {
  readonly device: DeviceInfo
  readonly handle: CustomizationHandle
  readonly facts: AssignmentFacts
  readonly sensors: CameraSensorsRead
  readonly defaults: Known<readonly DefaultConsumable[]>
}

/** One line of the table: a catalog section, a catalog row, or the per-field rows of a cap. */
type TableLine =
  | { readonly kind: 'section'; readonly section: CustomizeSection }
  | { readonly kind: 'row'; readonly plan: CustomizeRowPlan }
  | { readonly kind: 'capSection'; readonly cap: string }
  | { readonly kind: 'capLink'; readonly offered: OfferedCapLink }
  | { readonly kind: 'field'; readonly row: FieldRow }
  | {
      readonly kind: 'advanced'
      readonly cap: string
      readonly rows: readonly FieldRow[]
    }
  | LinkedActionTableLine
  | LinkedCameraTableLine
  | LinkedDeviceTableLine
  | TriggerTableLine

function lineKey(line: TableLine): string {
  switch (line.kind) {
    case 'section':
      return `section:${line.section}`
    case 'row':
      return line.plan.spec.key
    case 'capSection':
      return `capSection:${line.cap}`
    case 'capLink':
      return `capLink:${line.offered.cap}:${line.offered.link.id}`
    case 'field':
      return `field:${line.row.key}`
    case 'advanced':
      return `advanced:${line.cap}`
    case 'actionSection':
      return 'action-section'
    case 'actionPending':
      return 'action-pending'
    case 'actionEmpty':
      return 'action-empty'
    case 'actionError':
      return 'action-error'
    case 'actionEntry':
      return `action:${line.entry.id}`
    case 'cameraSection':
      return 'camera-section'
    case 'cameraPending':
      return 'camera-pending'
    case 'cameraError':
      return 'camera-error'
    case 'cameraEntry':
      return `camera:${line.camera.id}`
    case 'deviceSection':
      return 'device-section'
    case 'devicePending':
      return 'device-pending'
    case 'deviceEmpty':
      return 'device-empty'
    case 'deviceNotice':
      return `device-notice:${line.message}`
    case 'deviceEntry':
      return `device:${line.row.deviceId}:${line.row.orphan ? 'orphan' : 'linked'}`
    case 'deviceHint':
      return `device-hint:${line.hint}`
    case 'triggerSection':
      return 'trigger-section'
    case 'triggerPending':
      return 'trigger-pending'
    case 'triggerEmpty':
      return 'trigger-empty'
    case 'triggerNotice':
      return `trigger-notice:${line.message}`
    case 'triggerEntry':
      return `trigger:${line.row.key}`
  }
}

const catalog: CustomizeCatalog = CAP_CUSTOMIZE_CATALOG

/** A whole-capability link the table offers (D1076), and the section it sits in. */
interface OfferedLine {
  readonly offered: OfferedCapLink
  readonly section: CustomizeSection
}

/**
 * The links the catalog declares for the caps this device is offered, once each.
 * A `project` link sits with the scalar rows of its cap (offered where one of
 * them is); a `reference` link has no rows and is offered by the device types
 * it names, in "extensions".
 */
function offeredLinks(
  plans: readonly CustomizeRowPlan[],
  deviceType: string,
): readonly OfferedLine[] {
  const found = new Map<string, OfferedLine>()
  for (const [cap, entry] of Object.entries(catalog)) {
    for (const link of entry.links ?? []) {
      if (!capLinkOfferedOn(link, deviceType)) continue
      const row = plans.find((plan) => plan.spec.kind === 'scalar' && plan.spec.cap === cap)
      if (link.mode === 'project' && row === undefined) continue
      found.set(`${cap}:${link.id}`, {
        offered: { cap, link },
        section: row === undefined ? 'extensions' : row.spec.section,
      })
    }
  }
  return [...found.values()]
}

function linkLine(line: OfferedLine): TableLine {
  return { kind: 'capLink', offered: line.offered }
}

function buildLines(
  active: readonly CustomizeRowPlan[],
  offered: readonly OfferedLine[],
  groups: readonly FieldGroup[],
  advancedOpen: ReadonlySet<string>,
  itemLines: (cap: string) => readonly TableLine[],
  actions: readonly LinkedActionTableLine[],
  devices: readonly LinkedDeviceTableLine[],
  cameras: readonly LinkedCameraTableLine[],
  triggers: readonly TriggerTableLine[],
): readonly TableLine[] {
  // A link sits right above the first listed row of its cap; a cap with nothing listed yet
  // (every reading still in "+ Add") gets it at the end of its section.
  const catalog = CUSTOMIZE_SECTIONS.filter(
    (section) =>
      active.some((plan) => plan.spec.section === section) ||
      offered.some((row) => row.section === section),
  ).flatMap((section): TableLine[] => {
    const inSection = active.filter((plan) => plan.spec.section === section)
    const placed = new Set<string>()
    const lines = inSection.flatMap((plan): TableLine[] => {
      const heads = offered
        .filter(
          (row) =>
            row.offered.cap === plan.spec.cap &&
            !placed.has(`${row.offered.cap}:${row.offered.link.id}`),
        )
        .map((row): TableLine => {
          placed.add(`${row.offered.cap}:${row.offered.link.id}`)
          return linkLine(row)
        })
      return [
        ...heads,
        { kind: 'row' as const, plan },
        ...(plan.spec.kind === 'keyed' ? itemLines(plan.spec.cap) : []),
      ]
    })
    const rest = offered
      .filter(
        (row) =>
          row.section === section && !placed.has(`${row.offered.cap}:${row.offered.link.id}`),
      )
      .map(linkLine)
    return [{ kind: 'section' as const, section }, ...lines, ...rest]
  })
  const rest: TableLine[] = groups.flatMap((group): TableLine[] => [
    { kind: 'capSection', cap: group.cap },
    ...group.rows.map((row): TableLine => ({ kind: 'field', row })),
    ...(group.advanced.length === 0
      ? []
      : [
          {
            kind: 'advanced',
            cap: group.cap,
            rows: group.advanced,
          } satisfies TableLine,
        ]),
    ...(advancedOpen.has(group.cap)
      ? group.advanced.map((row): TableLine => ({ kind: 'field', row }))
      : []),
  ])
  return [...catalog, ...rest, ...actions, ...devices, ...cameras, ...triggers]
}

/** The rows of the kinds that are not catalog rows: each is a hook, so a device class calls a fixed set. */
interface TableKinds {
  readonly actions: LinkedActionsState | null
  readonly devices: LinkedDevicesState | null
  readonly cameras: LinkedCamerasState | null
  readonly triggers: TriggeredByState
}

export function CustomizeTable(props: CustomizeTableProps): ReactNode {
  if (props.device.type === DeviceType.Camera) return <CameraCustomizeTable {...props} />
  if (hasLinkedCameras(props.device.type)) return <GuestCustomizeTable {...props} />
  return <PlainCustomizeTable {...props} />
}

/** A device a camera can link: the cameras that link it are lines of this table. */
function GuestCustomizeTable(props: CustomizeTableProps): ReactNode {
  const cameras = useLinkedCameras(props.device)
  const triggers = useTriggeredBy(props.device)
  return (
    <CustomizeTableBody {...props} kinds={{ actions: null, devices: null, cameras, triggers }} />
  )
}

/** A camera: its linked actions, the devices it links (the slot it hosts) and its triggers. */
function CameraCustomizeTable(props: CustomizeTableProps): ReactNode {
  const actions = useLinkedActions(props.device)
  const devices = EXTENSION_SLOT_ROWS['linked-devices'].useRows(props.device)
  const triggers = useTriggeredBy(props.device)
  return <CustomizeTableBody {...props} kinds={{ actions, devices, cameras: null, triggers }} />
}

function PlainCustomizeTable(props: CustomizeTableProps): ReactNode {
  const triggers = useTriggeredBy(props.device)
  return (
    <CustomizeTableBody
      {...props}
      kinds={{ actions: null, devices: null, cameras: null, triggers }}
    />
  )
}

interface CustomizeTableBodyProps extends CustomizeTableProps {
  readonly kinds: TableKinds
}

function CustomizeTableBody(props: CustomizeTableBodyProps): ReactNode {
  const { device, handle, facts } = props
  const { actions, devices, cameras, triggers } = props.kinds
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const answered = handle.state.kind === 'none' || handle.state.kind === 'present'
  const current = currentComposition(handle.state)
  // Native consumables are listed once read; an unread list claims neither way (D315).
  const defaultsListed = props.defaults.kind === 'known' && props.defaults.value.length > 0
  const specs = useMemo(() => offeredRows(device.type), [device.type])
  const isLinked = (spec: CustomizeRowSpec): boolean => {
    switch (spec.kind) {
      case 'scalar':
        // A running row that follows the device's switch is listed with nothing stored: it is the default.
        return (
          storedScalarFeature(handle, spec.cap, spec.target.id) !== null ||
          followSwitchRowListed(spec.cap, spec.target.id, current)
        )
      case 'keyed':
        return featureOf(current, spec.cap) !== null || defaultsListed
      case 'event':
        // A camera-sensors event has no stored feature: it is listed when the sensors answer.
        return spec.target.applyAuthority?.kind === 'camera-sensors'
          ? true
          : featureOf(current, spec.cap) !== null
      case 'config':
        return true
      case 'link':
        return false
    }
  }
  const offCatalog = useMemo(
    () => offCatalogCards(current, catalogCoveredCaps(device.type)),
    [current, device.type],
  )
  const groups = useMemo(() => fieldGroups(offCatalog), [offCatalog])
  const sources = useFieldSources(groups.length > 0)
  const [advancedOpen, setAdvancedOpen] = useState<ReadonlySet<string>>(new Set())
  const toggleAdvanced = (cap: string): void =>
    setAdvancedOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(cap)) next.add(cap)
      return next
    })
  const split = splitRows(planRows(specs, facts, isLinked))
  const linkLines = offeredLinks([...split.active, ...split.addable], device.type)
  const actionLines = actions === null ? [] : linkedActionTableLines(actions)
  const cameraLines = cameras === null ? [] : cameras.lines
  const deviceLines = devices === null ? [] : devices.lines
  if (
    specs.length === 0 &&
    groups.length === 0 &&
    actionLines.length === 0 &&
    cameraLines.length === 0 &&
    deviceLines.length === 0 &&
    triggers.lines.length === 0 &&
    cameras?.canAdd !== true &&
    linkLines.length === 0
  )
    return null
  const titleOf = (spec: CustomizeRowSpec): string =>
    spec.kind === 'scalar'
      ? scalarRowTitle(t, i18n.language, spec.cap, spec.target)
      : t(`customize.table.caps.${spec.cap}`)
  const openPlan = [...split.active, ...split.addable].find((plan) => plan.spec.key === open)
  const lines = buildLines(
    split.active,
    linkLines,
    groups,
    advancedOpen,
    (cap) =>
      itemFieldRows(featureOf(current, cap)).map((row): TableLine => ({ kind: 'field', row })),
    actionLines,
    deviceLines,
    cameraLines,
    triggers.lines,
  )
  const openField = groups
    .flatMap((group) => [...group.rows, ...group.advanced])
    .find((row) => row.key === open)
  const fillRows = (cap: string): readonly FieldRow[] =>
    (groups.find((group) => group.cap === cap)?.rows ?? []).filter((row) => row.entry === null)
  const fillGroup = groups.find((group) => `fill:${group.cap}` === open)
  const scalarProps = (
    spec: CustomizeRowSpec,
  ): { cap: string; target: CustomizeRowSpec['target'] } => ({
    cap: spec.cap,
    target: spec.target,
  })

  const columns: readonly DataColumn<TableLine>[] = [
    {
      mobile: 'primary',
      key: 'item',
      header: t('customize.table.col.item'),
      notSortableReason: t('customize.table.col.item'),
      nowrap: false,
      render: (line) => {
        if (isLinkedActionLine(line)) return <LinkedActionItem line={line} />
        if (isLinkedCameraLine(line)) return <LinkedCameraItem line={line} />
        if (isLinkedDeviceLine(line)) return <LinkedDeviceItem line={line} />
        if (isTriggerLine(line)) return <TriggerItem line={line} />
        if (line.kind === 'section' || line.kind === 'capSection') {
          return (
            <span className="text-[11px] font-medium uppercase tracking-wide text-foreground-muted">
              {line.kind === 'section'
                ? t(`customize.table.section.${line.section}`)
                : capGroupTitle(i18n.language, line.cap)}
            </span>
          )
        }
        if (line.kind === 'capLink') {
          return (
            <span className="text-xs font-medium text-foreground">
              {t('customize.table.capLink.sourceDevice')}
            </span>
          )
        }
        if (line.kind === 'advanced') {
          return (
            <Button
              variant="ghost"
              size="sm"
              className="whitespace-nowrap"
              data-testid={`customize-advanced-${line.cap}`}
              aria-expanded={advancedOpen.has(line.cap)}
              onClick={() => toggleAdvanced(line.cap)}
            >
              {t('customize.table.advanced', { count: line.rows.length })}
            </Button>
          )
        }
        const hintKey = line.kind === 'row' ? `customize.scalar.hints.${line.plan.spec.cap}` : ''
        const hint = line.kind === 'row' && i18n.exists(hintKey) ? t(hintKey) : null
        return (
          <span className="flex flex-col gap-0.5">
            <span className="text-xs text-foreground">
              {line.kind === 'row'
                ? titleOf(line.plan.spec)
                : fieldRowTitle(i18n.language, line.row)}
            </span>
            {hint !== null && <span className="text-[11px] text-foreground-muted">{hint}</span>}
          </span>
        )
      },
    },
    {
      mobile: 'keep',
      key: 'value',
      header: t('customize.table.col.value'),
      notSortableReason: t('customize.table.col.value'),
      render: (line) => {
        if (isLinkedActionLine(line)) return <LinkedActionValue line={line} />
        if (isLinkedCameraLine(line)) return <LinkedCameraValue line={line} />
        if (isLinkedDeviceLine(line)) return <LinkedDeviceValue line={line} />
        if (isTriggerLine(line)) return <TriggerValue line={line} />
        if (line.kind === 'capLink') {
          return <CapLinkValueCell device={device} handle={handle} offered={line.offered} />
        }
        if (line.kind === 'section' || line.kind === 'capSection' || line.kind === 'advanced')
          return null
        if (line.kind === 'field') {
          return (
            <FieldValueCell
              device={device}
              row={line.row}
              state={fieldRowState(line.row, sources.presence)}
            />
          )
        }
        const { spec } = line.plan
        if (spec.kind === 'scalar') {
          return <ScalarValueCell device={device} handle={handle} {...scalarProps(spec)} />
        }
        if (spec.kind === 'keyed') {
          return (
            <KeyedValueCell device={device} handle={handle} spec={spec} defaults={props.defaults} />
          )
        }
        if (spec.kind === 'event') {
          return (
            <EventValueCell spec={spec} device={device} handle={handle} sensors={props.sensors} />
          )
        }
        return <ConfigValueCell spec={spec} device={device} />
      },
    },
    {
      mobile: 'detail',
      key: 'source',
      header: t('customize.table.col.source'),
      notSortableReason: t('customize.table.col.source'),
      nowrap: false,
      render: (line) => {
        if (isLinkedActionLine(line)) return <LinkedActionSource line={line} />
        if (isLinkedCameraLine(line)) return null
        if (isLinkedDeviceLine(line)) {
          return devices === null ? null : <LinkedDeviceSource line={line} state={devices} />
        }
        if (isTriggerLine(line)) return <TriggerSource line={line} state={triggers} />
        if (line.kind === 'capLink') {
          return <CapLinkSourceCell device={device} handle={handle} offered={line.offered} />
        }
        if (line.kind === 'section' || line.kind === 'capSection' || line.kind === 'advanced')
          return null
        if (line.kind === 'field') {
          return (
            <FieldSourceCell
              row={line.row}
              state={fieldRowState(line.row, sources.presence)}
              names={sources.names}
            />
          )
        }
        const { spec } = line.plan
        if (spec.kind === 'event') {
          return (
            <EventSourceCell spec={spec} device={device} handle={handle} sensors={props.sensors} />
          )
        }
        if (spec.kind === 'config') return <ConfigSourceCell spec={spec} device={device} />
        if (spec.kind !== 'scalar') return <span className="text-xs text-foreground-subtle">—</span>
        return <ScalarSourceCell device={device} handle={handle} {...scalarProps(spec)} />
      },
    },
    {
      mobile: 'keep',
      key: 'actions',
      // The pencil and the bin need no caption on a phone: the header would only push the
      // table past the viewport (D43 — the concession names its breakpoint).
      headerRender: () => (
        <span className="sr-only sm:not-sr-only">{t('customize.table.col.actions')}</span>
      ),
      notSortableReason: t('customize.table.col.actions'),
      align: 'right',
      width: 'w-px',
      render: (line) => {
        if (isLinkedActionLine(line)) {
          return actions === null ? null : <LinkedActionButtons line={line} state={actions} />
        }
        if (isLinkedCameraLine(line)) {
          return cameras === null ? null : <LinkedCameraButtons line={line} state={cameras} />
        }
        if (isLinkedDeviceLine(line)) {
          return devices === null ? null : <LinkedDeviceButtons line={line} state={devices} />
        }
        if (isTriggerLine(line)) return <TriggerButtons line={line} state={triggers} />
        if (line.kind === 'capLink') {
          return (
            <CapLinkActionsCell
              device={device}
              handle={handle}
              offered={line.offered}
              title={t('customize.table.capLink.sourceDevice')}
              onEdit={() => setOpen(lineKey(line))}
              onError={setError}
            />
          )
        }
        if (line.kind === 'section' || line.kind === 'advanced') {
          return null
        }
        if (line.kind === 'capSection') {
          return (
            <CapActionsCell
              cap={line.cap}
              title={capGroupTitle(i18n.language, line.cap)}
              handle={handle}
              onFill={
                fillRows(line.cap).length === 0 ? undefined : () => setOpen(`fill:${line.cap}`)
              }
            />
          )
        }
        if (line.kind === 'field') {
          return (
            <FieldActionsCell
              row={line.row}
              title={fieldRowTitle(i18n.language, line.row)}
              onEdit={() =>
                setOpen(line.row.item === null ? line.row.key : `${line.row.cap}.items`)
              }
            />
          )
        }
        const { spec } = line.plan
        if (spec.kind === 'scalar') {
          return (
            <ScalarActionsCell
              device={device}
              handle={handle}
              {...scalarProps(spec)}
              onEdit={() => setOpen(spec.key)}
              onError={setError}
            />
          )
        }
        if (spec.kind === 'event') {
          return (
            <EventActionsCell
              spec={spec}
              title={titleOf(spec)}
              device={device}
              handle={handle}
              sensors={props.sensors}
              onEdit={() => setOpen(spec.key)}
              onError={setError}
            />
          )
        }
        if (spec.kind === 'keyed') {
          return (
            <KeyedActionsCell
              spec={spec}
              title={titleOf(spec)}
              handle={handle}
              onEdit={() => setOpen(spec.key)}
              onError={setError}
            />
          )
        }
        return (
          <IconButton
            variant="ghost"
            size="sm"
            icon={Pencil}
            aria-label={t('customize.table.editWhat', { title: titleOf(spec) })}
            data-testid={`customize-manage-${spec.key}`}
            onClick={() => setOpen(spec.key)}
          />
        )
      },
    },
  ]

  return (
    <SectionCard
      headingId="customize-table"
      icon={SlidersHorizontal}
      title={t('customize.table.title')}
      testId="customize-table"
      actions={
        <AddPicker
          rows={split.addable}
          titleOf={titleOf}
          disabled={!answered || handle.saving}
          onPick={(key) => setOpen(key)}
          extras={[
            ...(devices !== null && devices.canAdd
              ? [
                  {
                    key: 'linked-device',
                    label: t('customize.linked.deviceOption'),
                    onPick: devices.openPicker,
                  },
                ]
              : []),
            ...(cameras !== null && cameras.canAdd
              ? [
                  {
                    key: 'linked-camera',
                    label: t('customize.linked.cameraOption'),
                    onPick: cameras.openPicker,
                  },
                ]
              : []),
            ...(triggers.canAdd
              ? [{ key: 'trigger', label: t('customize.triggers.add'), onPick: triggers.openAdd }]
              : []),
          ]}
        />
      }
    >
      <div className="flex flex-col gap-2 p-2 sm:p-3">
        {!answered || split.pending ? (
          <p role="status" className="text-xs text-foreground-subtle">
            {t('customize.scalar.checking')}
          </p>
        ) : null}
        {split.unknownReason !== null && (
          <ErrorBox title={t('customize.scalar.unreadable')} message={split.unknownReason} />
        )}
        {error !== null && (
          <p role="alert" className="text-xs text-danger break-words">
            {error}
          </p>
        )}
        {answered && lines.length > 0 && (
          <DataTable
            columns={columns}
            rows={lines}
            rowKey={lineKey}
            bordered={false}
            minWidthPx={320}
            rowClassName={(line) =>
              line.kind === 'section' ||
              line.kind === 'capSection' ||
              line.kind === 'actionSection' ||
              line.kind === 'cameraSection' ||
              line.kind === 'deviceSection' ||
              line.kind === 'triggerSection'
                ? 'bg-surface-hover'
                : undefined
            }
          />
        )}
        {answered && lines.length === 0 && !split.pending && split.unknownReason === null && (
          <p className="text-xs text-foreground-subtle">
            {t(split.addable.length > 0 ? 'customize.table.empty' : 'customize.table.nothingToAdd')}
          </p>
        )}
      </div>
      {openPlan !== undefined &&
        openPlan.spec.kind === 'scalar' &&
        openPlan.availability.kind === 'present' && (
          <ScalarDialogHost
            key={openPlan.spec.key}
            device={device}
            handle={handle}
            {...scalarProps(openPlan.spec)}
            mode={openPlan.availability.mode}
            onClose={() => setOpen(null)}
            onError={setError}
          />
        )}
      {openField !== undefined && (
        <FieldRowDialog
          key={openField.key}
          row={openField}
          title={fieldRowTitle(i18n.language, openField)}
          device={device}
          handle={handle}
          names={sources.names}
          onClose={() => setOpen(null)}
        />
      )}
      {fillGroup !== undefined && (
        <FillFromDeviceDialog
          key={fillGroup.cap}
          cap={fillGroup.cap}
          title={t('customize.table.fillTitle', {
            cap: capGroupTitle(i18n.language, fillGroup.cap),
          })}
          rows={fillRows(fillGroup.cap)}
          device={device}
          handle={handle}
          onClose={() => setOpen(null)}
        />
      )}
      {linkLines.map((line) => (
        <CapLinkDialog
          key={`${line.offered.cap}:${line.offered.link.id}`}
          device={device}
          handle={handle}
          offered={line.offered}
          open={open === `capLink:${line.offered.cap}:${line.offered.link.id}`}
          onClose={() => setOpen(null)}
          onError={setError}
        />
      ))}
      {actions?.dialog}
      {devices?.dialog}
      {cameras?.dialog}
      {triggers.dialog}
      {openPlan !== undefined && openPlan.spec.kind !== 'scalar' && (
        <ManagedRowDialog
          key={openPlan.spec.key}
          spec={openPlan.spec}
          title={titleOf(openPlan.spec)}
          device={device}
          handle={handle}
          facts={facts}
          sensors={props.sensors}
          defaults={props.defaults}
          onClose={() => setOpen(null)}
        />
      )}
    </SectionCard>
  )
}

interface AddPickerProps {
  readonly rows: readonly CustomizeRowPlan[]
  readonly titleOf: (spec: CustomizeRowSpec) => string
  readonly disabled: boolean
  readonly onPick: (key: string) => void
  /** Kinds that are not catalog rows (linked devices, cameras, triggers): each its own picker. */
  readonly extras: readonly AddPickerExtra[]
}

interface AddPickerExtra {
  readonly key: string
  readonly label: string
  readonly onPick: () => void
}

/** "+ Add customization": every offered row that is not linked yet, by section. */
function AddPicker({ rows, titleOf, disabled, onPick, extras }: AddPickerProps): ReactNode {
  const { t } = useTranslation()
  // A picker with nothing to pick is not rendered.
  if (rows.length === 0 && extras.length === 0) return null
  return (
    <Dropdown>
      <DropdownTrigger
        className="h-7 px-2.5 text-xs rounded-md border border-border bg-surface text-foreground"
        disabled={disabled}
        aria-label={t('customize.table.addAria')}
        data-testid="customize-table-add"
      >
        {t('customize.table.add')}
      </DropdownTrigger>
      <DropdownContent>
        {rows.map((plan) => (
          <DropdownItem
            key={plan.spec.key}
            data-testid={`customize-table-add-${plan.spec.key}`}
            onClick={() => onPick(plan.spec.key)}
          >
            {titleOf(plan.spec)}
          </DropdownItem>
        ))}
        {extras.map((extra) => (
          <DropdownItem
            key={extra.key}
            data-testid={`customize-table-add-${extra.key}`}
            onClick={extra.onPick}
          >
            {extra.label}
          </DropdownItem>
        ))}
      </DropdownContent>
    </Dropdown>
  )
}
