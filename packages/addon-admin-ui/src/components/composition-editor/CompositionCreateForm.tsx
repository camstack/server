/**
 * Create step inside the Build dialog. `blank` is a free composition.
 * `helper` is the template wizard. The room is set later, on the device.
 */
import {
  COMPOSED_DEVICE_STABLE_ID_PREFIX,
  DeviceRole,
  DeviceType,
  groupTemplate,
} from '@camstack/types'
import {
  Button,
  deviceRoleMetaOf,
  deviceTypeMeta,
  deviceTypeMetaOf,
  Input,
  Select,
  type UiTextFn,
  useCoreBlocksCreateComposition,
  useDeviceManagerListPersistedByAddon,
  useDeviceManagerSetName,
  useUiText,
} from '@camstack/ui-library'
import type { TFunction } from 'i18next'
import { type ReactNode, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { customizePath, devicePath } from '../../lib/customization-routes'
import { buildSkeletonComposition } from './build-skeleton'
import { HelperWizard } from './HelperWizard'
import {
  type HelperFormDraft,
  helperKindName,
  type HelperSaveIntent,
  type HelperSaveResult,
  type RefusalLine,
  refusalFromMessage,
  writeHelper,
} from './helper-form-model'

export type CompositionCreateMode = 'blank' | 'helper'

export interface CompositionCreateFormProps {
  readonly mode: CompositionCreateMode
  readonly onTitle: (title: string) => void
}

interface TitleSink {
  readonly onTitle: (title: string) => void
}

interface FleetRow {
  readonly id: number
  readonly stableId: string
}

export function CompositionCreateForm({ mode, onTitle }: CompositionCreateFormProps): ReactNode {
  if (mode === 'helper') return <HelperCreate onTitle={onTitle} />
  return <BlankCompositionForm onTitle={onTitle} />
}

function HelperCreate({ onTitle }: TitleSink): ReactNode {
  const { t } = useTranslation()
  const uiText = useUiText()
  const navigate = useNavigate()
  const create = useCoreBlocksCreateComposition()
  const setName = useDeviceManagerSetName()
  const fleet = useDeviceManagerListPersistedByAddon({ addonId: 'composer' })
  const [draft, setDraft] = useState<HelperFormDraft | null>(null)
  const title = titleForDraft(draft, t, uiText)

  useEffect(() => {
    onTitle(title)
  }, [onTitle, title])

  const save = async (
    next: HelperFormDraft,
    intent: HelperSaveIntent,
  ): Promise<HelperSaveResult> => {
    let deviceId: number | null = null
    const lines = await writeHelper(next, async (composition, name) => {
      const { block } = await create.mutateAsync({
        block: {
          ...(name === '' ? {} : { name }),
          enabled: true,
          composition,
        },
      })
      const id = await deviceIdForBlock(block.id, async () => {
        const refreshed = await fleet.refetch()
        return refreshed.data ?? fleet.data
      })
      if (id === null) throw new Error(t('helper.devicePending'))
      deviceId = id
      if (name !== '') await setName.mutateAsync({ deviceId: id, name })
      if (intent === 'open') navigate(devicePath(id), { replace: true })
    })
    const savedId = deviceId
    if (lines.length > 0 || savedId === null) return { kind: 'refused', lines: refused(lines, t) }
    return { kind: 'saved', deviceId: savedId }
  }

  return (
    <div className="flex flex-col gap-3" data-testid="composition-create-form">
      <HelperWizard
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

function BlankCompositionForm({ onTitle }: TitleSink): ReactNode {
  const { t } = useTranslation()
  const uiText = useUiText()
  const navigate = useNavigate()
  const create = useCoreBlocksCreateComposition()
  const setName = useDeviceManagerSetName()
  const fleet = useDeviceManagerListPersistedByAddon({ addonId: 'composer' })
  const [type, setType] = useState(DeviceType.Sensor)
  const [role, setRole] = useState<DeviceRole | null>(DeviceRole.TemperatureSensor)
  const [name, setNameValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const composition = buildSkeletonComposition({ type, role })

  useEffect(() => {
    onTitle(t('helper.newComposition'))
  }, [onTitle, t])

  return (
    <div className="flex flex-col gap-3" data-testid="blank-composition-form">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-[11px]">
          {t('compositionEditor.targetType')}
          <Select
            value={type}
            onChange={(e) => {
              const next = Object.values(DeviceType).find((v) => v === e.target.value)
              if (next !== undefined) setType(next)
            }}
            options={Object.values(DeviceType).map((v) => ({
              value: v,
              label: deviceTypeMetaOf(v, uiText).label,
            }))}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px]">
          {t('customize.identity.role')}
          <Select
            value={role ?? ''}
            onChange={(e) =>
              setRole(Object.values(DeviceRole).find((v) => v === e.target.value) ?? null)
            }
            options={[
              { value: '', label: t('customize.identity.noRole') },
              ...Object.values(DeviceRole).map((v) => ({
                value: v,
                label: deviceRoleMetaOf(v, uiText).label,
              })),
            ]}
          />
        </label>
        <label className="flex flex-col gap-1 text-[11px]">
          {t('compositionEditor.name')}
          <Input
            aria-label={t('compositionEditor.name')}
            value={name}
            onChange={(e) => setNameValue(e.target.value)}
          />
        </label>
      </div>
      {error !== null && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <Button
        disabled={composition === null || create.isPending}
        onClick={() => {
          if (composition === null) return
          void saveBlank({
            composition,
            name,
            create: (block) => create.mutateAsync({ block }),
            rename: (deviceId, nextName) => setName.mutateAsync({ deviceId, name: nextName }),
            readFleet: async () => {
              const refreshed = await fleet.refetch()
              return refreshed.data ?? fleet.data
            },
            onError: (message) => setError(message),
            onOpen: (deviceId) => navigate(customizePath(deviceId), { replace: true }),
            pending: t('helper.devicePending'),
          })
        }}
      >
        {t('compositionEditor.save')}
      </Button>
    </div>
  )
}

interface BlankSave {
  readonly composition: NonNullable<ReturnType<typeof buildSkeletonComposition>>
  readonly name: string
  readonly pending: string
  readonly create: (block: {
    readonly name?: string
    readonly enabled: true
    readonly composition: NonNullable<ReturnType<typeof buildSkeletonComposition>>
  }) => Promise<{ readonly block: { readonly id: string } }>
  readonly rename: (deviceId: number, name: string) => Promise<unknown>
  readonly readFleet: () => Promise<readonly FleetRow[] | undefined>
  readonly onError: (message: string | null) => void
  readonly onOpen: (deviceId: number) => void
}

async function saveBlank(input: BlankSave): Promise<void> {
  input.onError(null)
  try {
    const trimmed = input.name.trim()
    const { block } = await input.create({
      ...(trimmed === '' ? {} : { name: trimmed }),
      enabled: true,
      composition: input.composition,
    })
    const id = await deviceIdForBlock(block.id, input.readFleet)
    if (id === null) {
      input.onError(input.pending)
      return
    }
    if (trimmed !== '') await input.rename(id, trimmed)
    input.onOpen(id)
  } catch (err: unknown) {
    input.onError(err instanceof Error ? err.message : String(err))
  }
}

function titleForDraft(draft: HelperFormDraft | null, t: TFunction, uiText: UiTextFn): string {
  if (draft === null) return t('helper.newHelper')
  const template = groupTemplate(draft.templateId)
  if (template === null) return t('helper.newHelper')
  const name = helperKindName({
    family: template.family,
    templateLabel: t(`helper.template.${template.id}`),
    typeLabel: deviceTypeMeta(template.deviceType, uiText).label,
  })
  return t('helper.newOf', { name })
}

async function deviceIdForBlock(
  blockId: string,
  read: () => Promise<readonly FleetRow[] | undefined>,
): Promise<number | null> {
  const stableId = `${COMPOSED_DEVICE_STABLE_ID_PREFIX}${blockId}`
  const rows = await read()
  return rows?.find((item) => item.stableId === stableId)?.id ?? null
}

function refused(lines: readonly RefusalLine[], t: TFunction): readonly RefusalLine[] {
  if (lines.length > 0) return lines
  return refusalFromMessage(t('helper.devicePending'))
}
