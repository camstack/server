/**
 * A preset's wizard: one pick per entity the preset names, then the result
 * shown before it is created. Entities in the same container (else the same
 * location) as the first pick are suggested in the picker — the operator
 * still picks every one (D356). Everything it asks is read from the preset
 * registry, so a new preset needs no code here.
 */
import { compositionSourceKey, type CompositionSourceRef } from '@camstack/types'
import { Button, Input } from '@camstack/ui-library'
import { type ReactNode, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CustomizeDevicePickerDialog } from '../device/customize/assignments/CustomizeDevicePickerDialog'
import { useCandidateDevices } from '../device/customize/assignments/use-source-candidates'
import { vocabularyCapTitle } from '../device/customize/vocabulary-field-label'
import { deviceCandidates, entitySuggestions } from './command-sources'
import {
  type CompositionPreset,
  firstPick,
  missingSlots,
  type PresetPicks,
  type PresetSlot,
} from './composition-presets'
import type { HelperSaveResult } from './helper-form-model'
import { RefusalList } from './RefusalList'

export interface PresetWizardProps {
  readonly preset: CompositionPreset
  readonly saving: boolean
  readonly onSave: (
    composition: NonNullable<ReturnType<CompositionPreset['build']>>,
    name: string,
  ) => Promise<HelperSaveResult>
  readonly onBack: () => void
}

export function PresetWizard({ preset, saving, onSave, onBack }: PresetWizardProps): ReactNode {
  const { t, i18n } = useTranslation()
  const fleet = useCandidateDevices(true)
  const [picks, setPicks] = useState<PresetPicks>({})
  const [name, setName] = useState(t(preset.nameKey))
  const [picking, setPicking] = useState<PresetSlot | null>(null)
  const [refusals, setRefusals] = useState<Extract<HelperSaveResult, { kind: 'refused' }>['lines']>(
    [],
  )
  const [busy, setBusy] = useState(false)

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
  const taken = useMemo(
    () =>
      new Set(
        Object.values(picks).flatMap((ref) =>
          ref === undefined ? [] : [compositionSourceKey(ref)],
        ),
      ),
    [picks],
  )
  const candidates = useMemo(
    () =>
      fleet.kind === 'known'
        ? ({ kind: 'known', value: deviceCandidates(fleet.value, taken) } as const)
        : fleet,
    [fleet, taken],
  )
  const anchor = firstPick(preset, picks)
  const room = fleet.kind === 'known' ? entitySuggestions(fleet.value, anchor, false) : null
  const composition = preset.build(picks)
  const missing = missingSlots(preset, picks)

  const setPick = (key: string, ref: CompositionSourceRef | undefined): void => {
    setRefusals([])
    setPicks((current) => ({ ...current, [key]: ref }))
  }
  const nameOf = (ref: CompositionSourceRef): string =>
    names.get(compositionSourceKey(ref)) ?? ref.stableId

  const create = (): void => {
    if (composition === null || busy) return
    setBusy(true)
    void onSave(composition, name.trim())
      .then((result) => {
        if (result.kind === 'refused') setRefusals(result.lines)
      })
      .finally(() => setBusy(false))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="preset-wizard">
      <p className="text-[11px] text-foreground-muted">{t(preset.descriptionKey)}</p>
      <label className="flex flex-col gap-1 text-[11px]">
        {t('preset.name')}
        <Input
          aria-label={t('preset.name')}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <ul className="flex flex-col gap-2" aria-label={t('preset.slots')}>
        {preset.slots.map((s) => {
          const picked = picks[s.key]
          return (
            <li
              key={s.key}
              className="grid grid-cols-1 gap-1 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
              data-testid={`preset-slot-${s.key}`}
            >
              <div className="min-w-0">
                <div className="text-xs text-foreground">
                  {t(s.labelKey)}
                  {s.optionalGroup === undefined ? ' *' : ''}
                </div>
                <div className="text-[11px] text-foreground-muted break-words">
                  {vocabularyCapTitle(s.expectedCap, i18n.language)}
                  {s.optionalGroup === undefined ? '' : ` · ${t('preset.optional')}`}
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                <Button variant="outline" size="sm" onClick={() => setPicking(s)}>
                  {picked === undefined ? t('preset.choose') : nameOf(picked)}
                </Button>
                {picked !== undefined && s.optionalGroup !== undefined && (
                  <Button variant="ghost" size="sm" onClick={() => setPick(s.key, undefined)}>
                    {t('preset.clear')}
                  </Button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
      {composition === null && missing.length > 0 && (
        <p className="text-[11px] text-foreground-muted" data-testid="preset-missing">
          {t('preset.missing', { slots: missing.map((s) => t(s.labelKey)).join(', ') })}
        </p>
      )}
      {composition !== null && (
        <section className="flex flex-col gap-1" data-testid="preset-preview">
          <h3 className="text-xs font-medium text-foreground">{t('preset.preview')}</h3>
          <ul className="flex flex-col gap-1 text-[11px] text-foreground-muted">
            {composition.features.map((feature) =>
              feature.kind === 'fields' ? (
                <li key={feature.cap}>
                  {t('preset.previewFeature', {
                    cap: vocabularyCapTitle(feature.cap, i18n.language),
                    fields: Object.keys(feature.fields).length,
                    commands:
                      Object.keys(feature.commands ?? {}).length +
                      Object.values(feature.items ?? {}).filter((item) => item.reset !== undefined)
                        .length,
                  })}
                </li>
              ) : null,
            )}
          </ul>
        </section>
      )}
      <RefusalList lines={refusals} testId="preset-refusals" />
      <div className="mt-auto flex flex-wrap gap-2">
        <Button
          disabled={composition === null || saving || busy}
          onClick={create}
          data-testid="preset-create"
        >
          {t('preset.create')}
        </Button>
        <Button variant="ghost" onClick={onBack}>
          {t('preset.back')}
        </Button>
      </div>
      <CustomizeDevicePickerDialog
        open={picking !== null}
        title={picking === null ? '' : t('preset.pickTitle', { slot: t(picking.labelKey) })}
        selection="single"
        candidates={candidates}
        room={room}
        confirmLabel={() => t('preset.pickConfirm')}
        onConfirm={(picked) => {
          const chosen = picked[0]
          const slot = picking
          setPicking(null)
          if (chosen !== undefined && slot !== null) setPick(slot.key, chosen.ref)
        }}
        onClose={() => setPicking(null)}
      />
    </div>
  )
}
