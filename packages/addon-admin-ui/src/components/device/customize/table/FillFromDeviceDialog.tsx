/**
 * "Fill from device": one device for a cap, each field still to fill proposes its
 * best fitting value, the operator confirms or changes each row, then applies.
 * The device list is the shared device → value picker; the right-hand side is the
 * proposals instead of a value list.
 */
import { liveWireableCatalog } from '../source-picker-model'
import type { DeviceInfo } from '@camstack/types'
import {
  Button,
  DeviceValueField,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  useDeviceManagerGetWireableFields,
  useDeviceManagerListAll,
  useDeviceStateGetSnapshot,
  useDeviceValueSource,
} from '@camstack/ui-library'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { currentComposition } from '../customization-read'
import { compositionWithField } from '../override-row/merge-override'
import { type PickerDevice, type WireableCatalog, toPickerDevices } from '../source-picker-model'
import type { CustomizationHandle } from '../use-customization'
import { vocabularyCapTitle, vocabularyFieldLabel } from '../vocabulary-field-label'
import { type FillProposal, proposeFills } from './fill-from-device'
import type { FieldRow } from './field-rows'

const SKIP = ''

export interface FillFromDeviceDialogProps {
  readonly cap: string
  readonly title: string
  /** The rows still to fill; rows with a source are ignored. */
  readonly rows: readonly FieldRow[]
  readonly device: DeviceInfo
  readonly handle: CustomizationHandle
  readonly onClose: () => void
}

function candidateKey(cap: string, path: string): string {
  return `${cap}.${path}`
}

/** What the operator confirmed: the proposal's best value unless the row was changed. */
function chosenKey(proposal: FillProposal, choices: ReadonlyMap<string, string>): string {
  const best = proposal.candidates[0]
  return (
    choices.get(proposal.row.key) ?? (best === undefined ? SKIP : candidateKey(best.cap, best.path))
  )
}

export function FillFromDeviceDialog(props: FillFromDeviceDialogProps): ReactNode {
  const { t, i18n } = useTranslation()
  const [deviceId, setDeviceId] = useState<number | null>(null)
  const [choices, setChoices] = useState<ReadonlyMap<string, string>>(new Map())
  const source = useDeviceValueSource({
    deviceId,
    capNames: [props.cap],
    fit: () => '',
    capTitle: (cap) => vocabularyCapTitle(cap, i18n.language),
    fieldLabel: (cap, path) => vocabularyFieldLabel(cap, path, i18n.language),
  })
  const all = useDeviceManagerListAll({ projection: 'slim' })
  const wireable = useDeviceManagerGetWireableFields(
    { deviceId: deviceId ?? 0 },
    { enabled: deviceId !== null },
  )
  const snapshot = useDeviceStateGetSnapshot(
    { deviceId: deviceId ?? 0 },
    { enabled: deviceId !== null },
  )
  const picked: PickerDevice | null =
    deviceId === null || all.data === undefined
      ? null
      : (toPickerDevices(all.data).find((d) => d.id === deviceId) ?? null)
  const catalog: WireableCatalog = liveWireableCatalog(
    wireable.status === 'success' ? wireable.data : { caps: [] },
    snapshot.status === 'success' ? snapshot.data : null,
  )
  const proposals =
    picked === null
      ? []
      : proposeFills(
          props.rows,
          picked,
          catalog,
          snapshot.status === 'success' ? snapshot.data : null,
        )
  const confirmed = proposals.flatMap((proposal) => {
    const key = chosenKey(proposal, choices)
    const candidate = proposal.candidates.find((c) => candidateKey(c.cap, c.path) === key)
    return candidate === undefined ? [] : [{ proposal, candidate }]
  })

  const apply = (): void => {
    const base = currentComposition(props.handle.state)
    const next = confirmed.reduce(
      (acc, { proposal, candidate }) =>
        compositionWithField(
          acc,
          props.handle.target,
          props.cap,
          proposal.row.path,
          candidate.source,
          [],
        ),
      base,
    )
    if (next === null) return
    void props.handle.save(next).then(() => props.onClose())
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : props.onClose())}>
      <DialogContent width="lg" placement="sheet-on-mobile" scroll="body" aria-label={props.title}>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-3 p-2 sm:p-4">
          <DeviceValueField
            testId="fill-from-device"
            requires={source.requires}
            contextDeviceId={props.device.id}
            deviceId={deviceId}
            onDeviceChange={setDeviceId}
            deviceLabel={picked?.name ?? ''}
            valuesState={
              wireable.status === 'error'
                ? 'failed'
                : wireable.status === 'success'
                  ? 'ready'
                  : 'loading'
            }
            groups={[]}
            value={null}
            onValueChange={() => undefined}
            valuesOverride={
              <ul className="flex flex-col gap-2" data-testid="fill-proposals">
                {proposals.map((proposal) => (
                  <ProposalRow
                    key={proposal.row.key}
                    proposal={proposal}
                    chosen={chosenKey(proposal, choices)}
                    onChoose={(key) => setChoices(new Map(choices).set(proposal.row.key, key))}
                  />
                ))}
              </ul>
            }
            heading={t('customize.table.fillHeading')}
            noDeviceText={t('customize.table.fillNoDevice')}
            noValuesText={t('customize.table.fillNothing')}
          />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>
            {t('customize.table.close')}
          </Button>
          <Button
            data-testid="fill-apply"
            disabled={confirmed.length === 0 || props.handle.saving}
            onClick={apply}
          >
            {t('customize.table.fillApply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ProposalRow({
  proposal,
  chosen,
  onChoose,
}: {
  readonly proposal: FillProposal
  readonly chosen: string
  readonly onChoose: (key: string) => void
}): ReactNode {
  const { t, i18n } = useTranslation()
  const label = vocabularyFieldLabel(proposal.row.cap, proposal.row.path, i18n.language)
  return (
    <li className="flex flex-col gap-1 text-[11px]" data-testid={`fill-row-${proposal.row.key}`}>
      <span className="font-medium text-foreground">{label}</span>
      {proposal.candidates.length === 0 ? (
        <span className="text-foreground-subtle">{t('customize.table.fillNothing')}</span>
      ) : (
        <Select
          value={chosen}
          aria-label={label}
          options={[
            ...proposal.candidates.map((candidate) => ({
              value: candidateKey(candidate.cap, candidate.path),
              label: `${vocabularyFieldLabel(candidate.cap, candidate.path, i18n.language)} · ${String(candidate.value ?? '—')}`,
            })),
            { value: SKIP, label: t('customize.table.fillSkip') },
          ]}
          onChange={(e) => onChoose(e.target.value)}
        />
      )}
    </li>
  )
}
