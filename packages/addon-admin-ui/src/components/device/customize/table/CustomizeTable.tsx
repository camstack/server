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

type TableLine =
  | { readonly kind: 'section'; readonly section: CustomizeSection }
  | { readonly kind: 'row'; readonly plan: CustomizeRowPlan }

function lineKey(line: TableLine): string {
  return line.kind === 'section' ? `section:${line.section}` : line.plan.spec.key
}

function buildLines(active: readonly CustomizeRowPlan[]): readonly TableLine[] {
  return activeSections(active).flatMap((section) => [
    { kind: 'section' as const, section },
    ...active
      .filter((plan) => plan.spec.section === section)
      .map((plan) => ({ kind: 'row' as const, plan })),
  ])
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
  const split = splitRows(planRows(specs, facts, isLinked))
  if (specs.length === 0) return null
  const titleOf = (spec: CustomizeRowSpec): string =>
    spec.kind === 'scalar'
      ? scalarRowTitle(t, i18n.language, spec.cap, spec.target)
      : t(`customize.table.caps.${spec.cap}`)
  const openPlan = [...split.active, ...split.addable].find((plan) => plan.spec.key === open)
  const lines = buildLines(split.active)
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
          <span className="text-xs text-foreground">{titleOf(line.plan.spec)}</span>
        ),
    },
    {
      key: 'value',
      header: t('customize.table.col.value'),
      notSortableReason: t('customize.table.col.value'),
      render: (line) => {
        if (line.kind === 'section') return null
        const { spec } = line.plan
        if (spec.kind === 'scalar') {
          return <ScalarValueCell device={device} handle={handle} {...scalarProps(spec)} />
        }
        // A camera-sensors event keeps its state in the sensors editor, not in the composition.
        if (spec.target.applyAuthority?.kind === 'camera-sensors') {
          return <span className="text-xs text-foreground-subtle">—</span>
        }
        return (
          <Badge>
            {t(
              spec.kind === 'config' ? 'customize.table.configured' : 'customize.table.customized',
            )}
          </Badge>
        )
      },
    },
    {
      key: 'source',
      header: t('customize.table.col.source'),
      notSortableReason: t('customize.table.col.source'),
      nowrap: false,
      render: (line) => {
        if (line.kind === 'section') return null
        const { spec } = line.plan
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
