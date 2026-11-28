import type { DeviceTemplateThisDevice } from '@dominevo/types'
import type { ReactNode } from 'react'
import { useUiText } from '../../contexts/ui-text'
import {
  useDeviceManagerCheckDeviceTemplates,
  useDeviceManagerRenderDeviceTemplates,
} from '../../generated/system-hooks'
import { useDebouncedString } from '../../hooks/use-debounced-string'
import {
  carriesDeviceTemplate,
  type DeviceTemplateHeldSlots,
  textForDeviceCheck,
} from './device-template-model'

const CHECK_DEBOUNCE_MS = 400

export interface DeviceTemplateFeedbackProps {
  readonly heldSlots?: DeviceTemplateHeldSlots
  readonly value: string
  readonly preview: boolean
  readonly allowedDeviceIds: readonly number[] | undefined
  readonly thisDevice: DeviceTemplateThisDevice | undefined
  readonly testId: string
}

/** The hub's verdict on the text: a refusal, an unknown device name, or the rendered preview. */
export function DeviceTemplateFeedback({
  heldSlots,
  value,
  preview,
  allowedDeviceIds,
  thisDevice,
  testId,
}: DeviceTemplateFeedbackProps): ReactNode {
  const t = useUiText()
  const settled = useDebouncedString(value, CHECK_DEBOUNCE_MS)
  const worth = carriesDeviceTemplate(settled, heldSlots)
  const text = textForDeviceCheck(settled, heldSlots)
  const allowed = allowedDeviceIds === undefined ? undefined : [...allowedDeviceIds]
  const check = useDeviceManagerCheckDeviceTemplates(
    { templates: [text], allowedDeviceIds: allowed, thisDevice },
    { enabled: worth },
  )
  const verdict = worth ? check.data?.results[0] : undefined
  const refused = verdict?.ok === false ? verdict.refusal.message : null
  const unknownAliases =
    verdict?.ok === true
      ? verdict.aliases.filter((a) => a.deviceId === null).map((a) => a.alias)
      : []
  const outOfScope =
    verdict?.ok === true ? verdict.aliases.filter((a) => a.deviceId !== null && !a.allowed) : []
  const vetted = verdict?.ok === true && unknownAliases.length === 0 && outOfScope.length === 0
  const rendered = useDeviceManagerRenderDeviceTemplates(
    { templates: [text], allowedDeviceIds: allowed, thisDevice },
    { enabled: preview && vetted },
  )
  const result = preview && vetted ? rendered.data?.results[0] : undefined
  return (
    <>
      {refused !== null && (
        <p role="alert" className="text-[11px] text-danger" data-testid={`${testId}-refusal`}>
          {refused}
        </p>
      )}
      {unknownAliases.length > 0 && (
        <p role="alert" className="text-[11px] text-danger" data-testid={`${testId}-unknown`}>
          {t('uiLibrary.deviceTemplateField.unknownDevice', 'No device is named {{names}}.', {
            names: unknownAliases.join(', '),
          })}
        </p>
      )}
      {outOfScope.length > 0 && (
        <p role="alert" className="text-[11px] text-danger" data-testid={`${testId}-scope`}>
          {t(
            'uiLibrary.deviceTemplateField.outOfScope',
            '{{names}} is outside what this can read.',
            { names: outOfScope.map((a) => a.alias).join(', ') },
          )}
        </p>
      )}
      {result?.ok === true && (
        <p className="text-[11px] text-foreground-muted" data-testid={`${testId}-preview`}>
          {t('uiLibrary.deviceTemplateField.preview', 'Now reads: {{text}}', { text: result.text })}
        </p>
      )}
    </>
  )
}
