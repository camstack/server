/**
 * The Customize tab's ONE table: every parameter the catalog offers for this
 * device, grouped by section. A row is listed when something is linked or
 * served for it (value + source); the rest are attached from the "+ Add
 * customization" picker. Editing a scalar link opens the existing
 * ScalarOverrideDialog; an event, a list or an extension opens its own editor
 * (D315: unread applicability is said, never read as "nothing to add").
 */
import type { DeviceInfo } from '@camstack/types'
import {
  Badge,
  DataTable,
  type DataColumn,
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
  ExtraActionsCell,
  type ExtraRow,
  ExtraRowDialog,
  LinkedSourceCell,
  LinkedValueCell,
  OffCatalogSourceCell,
  OffCatalogValueCell,
  offCatalogTitle,
} from './ExtraRowCells'
import { ManagedRowDialog } from './ManagedRowDialog'
import { useLinkedRow } from './use-linked-row'
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

/** The catalog sections, then the two groups that are not catalog targets. */
type TableSection = CustomizeSection | 'offCatalog' | 'linked'

type TableLine =
  | { readonly kind: 'section'; readonly section: TableSection }
  | { readonly kind: 'row'; readonly plan: CustomizeRowPlan }
  | { readonly kind: 'extra'; readonly row: ExtraRow }

function lineKey(line: TableLine): string {
  switch (line.kind) {
    case 'section':
      return `section:${line.section}`
    case 'row':
      return line.plan.spec.key
    case 'extra':
      return line.row.key
  }
}

function buildLines(
  active: readonly CustomizeRowPlan[],
  extras: readonly ExtraRow[],
): readonly TableLine[] {
  const catalog = activeSections(active).flatMap((section) => [
    { kind: 'section' as const, section },
    ...active
      .filter((plan) => plan.spec.section === section)
      .map((plan) => ({ kind: 'row' as const, plan })),
  ])
  const groups: readonly (readonly [TableSection, ExtraRow['kind']])[] = [
    ['offCatalog', 'offCatalog'],
    ['linked', 'linked'],
  ]
  const rest = groups.flatMap(([section, kind]) => {
    const rows = extras.filter((row) => row.kind === kind)
    return rows.length === 0
      ? []
      : [
          { kind: 'section' as const, section },
          ...rows.map((row) => ({ kind: 'extra' as const, row })),
        ]
  })
  return [...catalog, ...rest]
}

export function CustomizeTable(props: CustomizeTableProps): ReactNode {
  const { device, handle, facts } = props
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
  const linkedRead = useLinkedRow(device)
  const offCatalog = useMemo(
    () => offCatalogCards(current, catalogCoveredCaps(device.type)),
    [current, device.type],
  )
  const extras: readonly ExtraRow[] = [
    ...offCatalog.map((card) => ({
      kind: 'offCatalog' as const,
      key: `offcatalog.${card.cap}`,
      card,
    })),
    ...(linkedRead.kind === 'hidden'
      ? []
      : [{ kind: 'linked' as const, key: 'linked-devices' as const }]),
  ]
  const split = splitRows(planRows(specs, facts, isLinked))
  if (specs.length === 0 && extras.length === 0) return null
  const titleOf = (spec: CustomizeRowSpec): string =>
    spec.kind === 'scalar'
      ? scalarRowTitle(t, i18n.language, spec.cap, spec.target)
      : t(`customize.table.caps.${spec.cap}`)
  const openPlan = [...split.active, ...split.addable].find((plan) => plan.spec.key === open)
  const lines = buildLines(split.active, extras)
  const openExtra = extras.find((row) => row.key === open)
  const extraTitle = (row: ExtraRow): string =>
    row.kind === 'linked'
      ? t('customize.table.section.linked')
      : offCatalogTitle(i18n.language, row.card)
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
      render: (line) =>
        line.kind === 'section' ? (
          <span className="text-[11px] font-medium uppercase tracking-wide text-foreground-muted">
            {t(`customize.table.section.${line.section}`)}
          </span>
        ) : (
          <span className="text-xs text-foreground">
            {line.kind === 'row' ? titleOf(line.plan.spec) : extraTitle(line.row)}
          </span>
        ),
    },
    {
      key: 'value',
      header: t('customize.table.col.value'),
      notSortableReason: t('customize.table.col.value'),
      render: (line) => {
        if (line.kind === 'section') return null
        if (line.kind === 'extra') {
          return line.row.kind === 'linked' ? (
            <LinkedValueCell read={linkedRead} />
          ) : (
            <OffCatalogValueCell device={device} card={line.row.card} />
          )
        }
        const { spec } = line.plan
        if (spec.kind === 'scalar') {
          return <ScalarValueCell device={device} handle={handle} {...scalarProps(spec)} />
        }
        if (spec.kind === 'event') {
          return (
            <EventValueCell spec={spec} device={device} handle={handle} sensors={props.sensors} />
          )
        }
        if (spec.kind === 'config') return <ConfigValueCell spec={spec} device={device} />
        return <Badge>{t('customize.table.customized')}</Badge>
      },
    },
    {
      key: 'source',
      header: t('customize.table.col.source'),
      notSortableReason: t('customize.table.col.source'),
      nowrap: false,
      render: (line) => {
        if (line.kind === 'section') return null
        if (line.kind === 'extra') {
          return line.row.kind === 'linked' ? (
            <LinkedSourceCell read={linkedRead} />
          ) : (
            <OffCatalogSourceCell card={line.row.card} />
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
        if (line.kind === 'section') return null
        if (line.kind === 'extra') {
          return (
            <ExtraActionsCell
              row={line.row}
              title={extraTitle(line.row)}
              handle={handle}
              onEdit={() => setOpen(line.row.key)}
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
            rowClassName={(line) => (line.kind === 'section' ? 'bg-surface-hover' : undefined)}
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
      {openExtra !== undefined && (
        <ExtraRowDialog
          key={openExtra.key}
          row={openExtra}
          title={extraTitle(openExtra)}
          device={device}
          handle={handle}
          onClose={() => setOpen(null)}
        />
      )}
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
