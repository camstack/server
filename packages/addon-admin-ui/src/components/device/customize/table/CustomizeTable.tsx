/**
 * The Customize tab's ONE table: every parameter the catalog offers for this
 * device, grouped by section. A row is listed when something is linked or
 * served for it (value + source); the rest are attached from the "+ Add
 * customization" picker. Editing a scalar link opens the existing
 * ScalarOverrideDialog; an event, a list or an extension opens its own editor
 * (D315: unread applicability is said, never read as "nothing to add").
 */
import { type DeviceInfo, DeviceType } from '@camstack/types'
import {
  DataTable,
  type DataColumn,
  Button,
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
import type { Known } from '../known'
import { storedScalarFeature, scalarRowTitle } from '../scalar/use-scalar-row'
import type { CameraSensorsRead } from '../use-camera-sensors-presence'
import type { CustomizationHandle } from '../use-customization'
import {
  activeSections,
  type CustomizeRowPlan,
  type CustomizeRowSpec,
  type CustomizeSection,
  offeredRows,
  planRows,
  splitRows,
} from './customize-rows'
import { ConfigSourceCell, ConfigValueCell } from './ConfigRowCells'
import { EventSourceCell, EventValueCell } from './EventRowCells'
import { catalogCoveredCaps, offCatalogCards } from './extra-rows'
import {
  CapActionsCell,
  capGroupTitle,
  FieldActionsCell,
  FieldRowDialog,
  FieldSourceCell,
  FieldValueCell,
  fieldRowTitle,
} from './ExtraRowCells'
import {
  type FieldGroup,
  type FieldRow,
  fieldGroups,
  fieldRowState,
  itemFieldRows,
} from './field-rows'
import { useFieldSources } from './use-field-sources'
import { KeyedValueCell } from './KeyedValueCell'
import {
  isLinkedActionLine,
  LinkedActionButtons,
  LinkedActionItem,
  LinkedActionSource,
  LinkedActionValue,
  type LinkedActionsState,
  type LinkedActionTableLine,
  linkedActionTableLines,
  useLinkedActions,
} from '../kinds/LinkedActionsCard'
import { ManagedRowDialog } from './ManagedRowDialog'
import {
  ScalarActionsCell,
  ScalarDialogHost,
  ScalarSourceCell,
  ScalarValueCell,
} from './ScalarRowParts'

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
  | { readonly kind: 'field'; readonly row: FieldRow }
  | {
      readonly kind: 'advanced'
      readonly cap: string
      readonly rows: readonly FieldRow[]
    }
  | LinkedActionTableLine

function lineKey(line: TableLine): string {
  switch (line.kind) {
    case 'section':
      return `section:${line.section}`
    case 'row':
      return line.plan.spec.key
    case 'capSection':
      return `capSection:${line.cap}`
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
  }
}

function buildLines(
  active: readonly CustomizeRowPlan[],
  groups: readonly FieldGroup[],
  advancedOpen: ReadonlySet<string>,
  itemLines: (cap: string) => readonly TableLine[],
  actions: readonly LinkedActionTableLine[],
): readonly TableLine[] {
  const catalog = activeSections(active).flatMap((section) => [
    { kind: 'section' as const, section },
    ...active
      .filter((plan) => plan.spec.section === section)
      .flatMap((plan): TableLine[] => [
        { kind: 'row' as const, plan },
        ...(plan.spec.kind === 'keyed' ? itemLines(plan.spec.cap) : []),
      ]),
  ])
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
  return [...catalog, ...rest, ...actions]
}

export function CustomizeTable(props: CustomizeTableProps): ReactNode {
  if (props.device.type === DeviceType.Camera) return <CameraCustomizeTable {...props} />
  return <CustomizeTableBody {...props} actions={null} />
}

function CameraCustomizeTable(props: CustomizeTableProps): ReactNode {
  const actions = useLinkedActions(props.device)
  return <CustomizeTableBody {...props} actions={actions} />
}

interface CustomizeTableBodyProps extends CustomizeTableProps {
  readonly actions: LinkedActionsState | null
}

function CustomizeTableBody(props: CustomizeTableBodyProps): ReactNode {
  const { device, handle, facts, actions } = props
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
        return storedScalarFeature(handle, spec.cap, spec.target.id) !== null
      case 'keyed':
        return featureOf(current, spec.cap) !== null || defaultsListed
      case 'event':
        // A camera-sensors event has no stored feature: it is listed when the sensors answer.
        return spec.target.applyAuthority?.kind === 'camera-sensors'
          ? true
          : featureOf(current, spec.cap) !== null
      case 'config':
        return true
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
  const actionLines = actions === null ? [] : linkedActionTableLines(actions)
  if (specs.length === 0 && groups.length === 0 && actionLines.length === 0) return null
  const titleOf = (spec: CustomizeRowSpec): string =>
    spec.kind === 'scalar'
      ? scalarRowTitle(t, i18n.language, spec.cap, spec.target)
      : t(`customize.table.caps.${spec.cap}`)
  const openPlan = [...split.active, ...split.addable].find((plan) => plan.spec.key === open)
  const lines = buildLines(
    split.active,
    groups,
    advancedOpen,
    (cap) =>
      itemFieldRows(featureOf(current, cap)).map((row): TableLine => ({ kind: 'field', row })),
    actionLines,
  )
  const openField = groups
    .flatMap((group) => [...group.rows, ...group.advanced])
    .find((row) => row.key === open)
  const scalarProps = (
    spec: CustomizeRowSpec,
  ): { cap: string; target: CustomizeRowSpec['target'] } => ({
    cap: spec.cap,
    target: spec.target,
  })

  const columns: readonly DataColumn<TableLine>[] = [
    {
      key: 'item',
      header: t('customize.table.col.item'),
      notSortableReason: t('customize.table.col.item'),
      nowrap: false,
      render: (line) => {
        if (isLinkedActionLine(line)) return <LinkedActionItem line={line} />
        if (line.kind === 'section' || line.kind === 'capSection') {
          return (
            <span className="text-[11px] font-medium uppercase tracking-wide text-foreground-muted">
              {line.kind === 'section'
                ? t(`customize.table.section.${line.section}`)
                : capGroupTitle(i18n.language, line.cap)}
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
        return (
          <span className="text-xs text-foreground">
            {line.kind === 'row' ? titleOf(line.plan.spec) : fieldRowTitle(i18n.language, line.row)}
          </span>
        )
      },
    },
    {
      key: 'value',
      header: t('customize.table.col.value'),
      notSortableReason: t('customize.table.col.value'),
      render: (line) => {
        if (isLinkedActionLine(line)) return <LinkedActionValue line={line} />
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
      key: 'source',
      header: t('customize.table.col.source'),
      notSortableReason: t('customize.table.col.source'),
      nowrap: false,
      render: (line) => {
        if (isLinkedActionLine(line)) return <LinkedActionSource line={line} />
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
      key: 'actions',
      header: t('customize.table.col.actions'),
      notSortableReason: t('customize.table.col.actions'),
      align: 'right',
      render: (line) => {
        if (isLinkedActionLine(line)) {
          return actions === null ? null : <LinkedActionButtons line={line} state={actions} />
        }
        if (line.kind === 'section' || line.kind === 'advanced') return null
        if (line.kind === 'capSection') {
          return (
            <CapActionsCell
              cap={line.cap}
              title={capGroupTitle(i18n.language, line.cap)}
              handle={handle}
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
              line.kind === 'section' || line.kind === 'capSection' || line.kind === 'actionSection'
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
      {actions?.dialog}
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
}

/** "+ Add customization": every offered row that is not linked yet, by section. */
function AddPicker({ rows, titleOf, disabled, onPick }: AddPickerProps): ReactNode {
  const { t } = useTranslation()
  // A picker with nothing to pick is not rendered.
  if (rows.length === 0) return null
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
      </DropdownContent>
    </Dropdown>
  )
}
