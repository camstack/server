/**
 * The commands of a built device (D967), one card per capability that serves
 * methods. A built cap answers a method only through a forward to a source
 * device; every method that needs one is a row here, with the validator's
 * refusal on the row it concerns. The device picker suggests the entities
 * next to the ones the card already reads — it never links one on its own.
 */
import {
  type Composition,
  compositionSourceKey,
  type CompositionFieldsFeature,
  type CompositionForwardCommand,
  type CompositionSourceRef,
  featureFieldEntries,
  fieldReads,
} from '@camstack/types'
import { Terminal } from 'lucide-react'
import { type ReactNode, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { CustomizeCard } from '../device/customize/CustomizeCard'
import { useCandidateDevices } from '../device/customize/assignments/use-source-candidates'
import type { CustomizationSaveOutcome } from '../device/customize/use-customization'
import { vocabularyCapTitle } from '../device/customize/vocabulary-field-label'
import {
  capabilityDefOf,
  type CommandRow,
  commandRows,
  unservedMethods,
  withRowCommand,
} from './command-model'
import { deviceCandidates, entitySuggestions } from './command-sources'
import { CommandRowEditor } from './CommandRowEditor'

export interface CommandsSectionProps {
  readonly composition: Composition
  readonly saving: boolean
  readonly save: (next: Composition) => Promise<CustomizationSaveOutcome>
}

/** The device the card already reads or calls first: where the picker's suggestions start. */
function anchorOf(feature: CompositionFieldsFeature): CompositionSourceRef | null {
  const forward = Object.values(feature.commands ?? {}).find((c) => c.kind === 'forward')
  if (forward !== undefined) return forward.source
  const read = featureFieldEntries(feature)
    .flatMap((entry) => fieldReads(entry.source))
    .at(0)
  return read === undefined ? null : read.source
}

export function CommandsSection({ composition, saving, save }: CommandsSectionProps): ReactNode {
  const { t, i18n } = useTranslation()
  const fleet = useCandidateDevices(true)
  const names = useMemo(
    () =>
      fleet.kind === 'known'
        ? new Map(
            fleet.value.map((d) => [
              compositionSourceKey({ addonId: d.addonId, stableId: d.stableId }),
              d.name,
            ]),
          )
        : new Map<string, string>(),
    [fleet],
  )
  const candidates = useMemo(
    () =>
      fleet.kind === 'known'
        ? ({ kind: 'known', value: deviceCandidates(fleet.value) } as const)
        : fleet,
    [fleet],
  )

  const apply = async (
    featureIndex: number,
    row: CommandRow,
    command: CompositionForwardCommand | null,
  ): Promise<CustomizationSaveOutcome> => {
    const feature = composition.features[featureIndex]
    if (feature === undefined || feature.kind !== 'fields') {
      return { kind: 'refused', reason: 'the feature is gone' }
    }
    const features = composition.features.map((f, i) =>
      i === featureIndex ? withRowCommand(feature, row, command) : f,
    )
    return save({ ...composition, features })
  }

  return (
    <>
      {composition.features.map((feature, featureIndex) => {
        if (feature.kind !== 'fields') return null
        const def = capabilityDefOf(feature.cap)
        if (def === null) return null
        const rows = commandRows(def, feature)
        if (rows.length === 0) return null
        const unserved = unservedMethods(def, feature)
        const room =
          fleet.kind === 'known' ? entitySuggestions(fleet.value, anchorOf(feature), true) : null
        const capTitle = vocabularyCapTitle(feature.cap, i18n.language)
        return (
          <CustomizeCard
            key={feature.cap}
            id={`commands-${feature.cap}`}
            icon={Terminal}
            title={t('commands.title', { cap: capTitle })}
            testId={`commands-card-${feature.cap}`}
          >
            <div className="flex flex-col gap-3 px-3 py-2 sm:px-4">
              <p className="text-xs text-foreground-muted">{t('commands.hint')}</p>
              {unserved.length > 0 && (
                <p role="alert" className="text-xs text-danger" data-testid="commands-has-commands">
                  <span className="font-medium">has-commands</span>
                  {` — ${t('commands.unserved', { methods: unserved.join(', ') })}`}
                </p>
              )}
              <ul className="flex flex-col gap-3">
                {rows.map((row) => (
                  <CommandRowEditor
                    key={row.id}
                    def={def}
                    feature={feature}
                    featureIndex={featureIndex}
                    row={row}
                    itemLabel={
                      row.itemKey === null
                        ? null
                        : (feature.items?.[row.itemKey]?.label ?? row.itemKey)
                    }
                    fleet={fleet}
                    names={names}
                    candidates={candidates}
                    room={room}
                    saving={saving}
                    onApply={(r, command) => apply(featureIndex, r, command)}
                  />
                ))}
              </ul>
            </div>
          </CustomizeCard>
        )
      })}
    </>
  )
}
