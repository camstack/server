/**
 * Create step inside the Build dialog. `blank` is the Device section (a naked
 * device, D1004); `helper` is the picker whose other tiles are the aggregators.
 * The room is set later, on the device.
 */
import { useCreateComposition } from '../../lib/create-composition'
import { type Composition, groupTemplate } from '@camstack/types'
import { useDeviceManagerListPersistedByAddon, useDeviceManagerSetName } from '@camstack/ui-library'
import type { TFunction } from 'i18next'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { customizePath, devicePath } from '../../lib/customization-routes'
import { awaitDeviceIdForBlock } from './await-device-id'
import { DeviceCreateForm } from './DeviceCreateForm'
import { presetById } from './composition-presets'
import { HelperWizard } from './HelperWizard'
import { PresetWizard } from './PresetWizard'
import {
  type HelperDraft,
  type HelperSaveIntent,
  type HelperSaveResult,
  type RefusalLine,
  refusalFromMessage,
  writeHelper,
} from './helper-form-model'

const PRESET_PARAM = 'preset'

export type CompositionCreateMode = 'blank' | 'helper'

export interface CompositionCreateFormProps {
  readonly mode: CompositionCreateMode
  readonly onTitle: (title: string) => void
}

interface TitleSink {
  readonly onTitle: (title: string) => void
}

export function CompositionCreateForm({ mode, onTitle }: CompositionCreateFormProps): ReactNode {
  if (mode === 'helper') return <HelperCreate onTitle={onTitle} />
  return <DeviceCreateForm onTitle={onTitle} />
}

function HelperCreate({ onTitle }: TitleSink): ReactNode {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const create = useCreateComposition()
  const setName = useDeviceManagerSetName()
  const fleet = useDeviceManagerListPersistedByAddon({ addonId: 'composer' })
  const [draft, setDraft] = useState<HelperDraft | null>(null)
  const [free, setFree] = useState(false)
  const [params, setParams] = useSearchParams()
  const preset = presetById(params.get(PRESET_PARAM))
  const title = preset === null ? titleForDraft(draft, t) : t(preset.labelKey)

  useEffect(() => {
    if (!free) onTitle(title)
  }, [onTitle, title, free])

  // Replace, not push: back from a preset must leave the dialog, not return to a half-picked tile.
  const choosePreset = (id: string | null): void =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        if (id === null) next.delete(PRESET_PARAM)
        else next.set(PRESET_PARAM, id)
        return next
      },
      { replace: true },
    )

  const savePreset = async (composition: Composition, name: string): Promise<HelperSaveResult> => {
    try {
      const { block } = await create.mutateAsync({
        block: { ...(name === '' ? {} : { name }), enabled: true, composition },
      })
      const id = await awaitDeviceIdForBlock(block.id, async () => {
        const refreshed = await fleet.refetch()
        return refreshed.data ?? fleet.data
      })
      if (id === null)
        return { kind: 'refused', lines: refusalFromMessage(t('helper.devicePending')) }
      if (name !== '') await setName.mutateAsync({ deviceId: id, name })
      navigate(customizePath(id), { replace: true })
      return { kind: 'saved', deviceId: id }
    } catch (err: unknown) {
      return {
        kind: 'refused',
        lines: refusalFromMessage(err instanceof Error ? err.message : String(err)),
      }
    }
  }

  // The block a draft already created, so a retry after a failed lookup
  // resolves the same device instead of creating a second one.
  const createdBlock = useRef<{ readonly draft: HelperDraft; readonly blockId: string } | null>(
    null,
  )

  const save = async (next: HelperDraft, intent: HelperSaveIntent): Promise<HelperSaveResult> => {
    let deviceId: number | null = null
    const lines = await writeHelper(next, async (composition, name) => {
      const earlier = createdBlock.current
      let blockId: string
      if (earlier !== null && earlier.draft === next) {
        blockId = earlier.blockId
      } else {
        const { block } = await create.mutateAsync({
          block: {
            ...(name === '' ? {} : { name }),
            enabled: true,
            composition,
          },
        })
        blockId = block.id
        createdBlock.current = { draft: next, blockId }
      }
      const id = await awaitDeviceIdForBlock(blockId, async () => {
        const refreshed = await fleet.refetch()
        return refreshed.data ?? fleet.data
      })
      if (id === null) throw new Error(t('helper.devicePending'))
      deviceId = id
      createdBlock.current = null
      if (name !== '') await setName.mutateAsync({ deviceId: id, name })
      if (intent === 'open') navigate(devicePath(id), { replace: true })
    })
    const savedId = deviceId
    if (lines.length > 0 || savedId === null) return { kind: 'refused', lines: refused(lines, t) }
    return { kind: 'saved', deviceId: savedId }
  }

  if (free) return <DeviceCreateForm onTitle={onTitle} />
  if (preset !== null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="composition-create-form">
        <PresetWizard
          preset={preset}
          saving={create.isPending}
          onSave={savePreset}
          onBack={() => choosePreset(null)}
        />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="composition-create-form">
      <HelperWizard
        fillHeight
        onDevice={() => setFree(true)}
        onPreset={choosePreset}
        purpose="create"
        initial={null}
        start="template"
        saving={create.isPending}
        onDraftChange={setDraft}
        onSave={save}
      />
    </div>
  )
}

function titleForDraft(draft: HelperDraft | null, t: TFunction): string {
  if (draft === null) return t('helper.newComposed')
  if (draft.kind === 'statistic') return t('helper.newTitle.statistic')
  if (draft.kind === 'integral') return t('helper.newTitle.integral')
  if (draft.kind === 'arithmetic') return t(`helper.newTitle.${draft.op}`)
  if (draft.kind === 'threshold' || draft.kind === 'expression' || draft.kind === 'derivative') {
    return t(`helper.newTitle.${draft.kind}`)
  }
  const template = groupTemplate(draft.templateId)
  if (template === null) return t('helper.newComposed')
  // One whole phrase per template and locale: gluing a type word and a
  // template word reads backwards in Italian ("Nuovo Temperatura sensore").
  return t(`helper.newTitle.${template.id}`)
}

function refused(lines: readonly RefusalLine[], t: TFunction): readonly RefusalLine[] {
  if (lines.length > 0) return lines
  return refusalFromMessage(t('helper.devicePending'))
}

export { awaitDeviceIdForBlock }
