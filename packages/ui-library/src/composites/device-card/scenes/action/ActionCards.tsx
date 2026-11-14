import type { ReactElement } from 'react'
import { useUiText } from '../../../../contexts/ui-text'
import { cn } from '../../../../lib/cn'
import { CardIcon } from '../../parts/CardIcon'
import { DeviceCard } from '../../shell/DeviceCard'
import { columnButton } from '../../shell/column-items'
import type { CardOrientation } from '../../shell/model'
import { SCENE_ICON_CLASS } from '../../shell/scene-layout'
import {
  type AutomationCardActions,
  type AutomationCardModel,
  type ButtonCardActions,
  type ButtonCardModel,
  type ScriptCardActions,
  type ScriptCardModel,
  withError,
} from './model'

interface SceneProps<M, A> {
  readonly model: M
  readonly actions: A
  readonly orientation?: CardOrientation
  readonly showName?: boolean
}

export type ButtonCardProps = SceneProps<ButtonCardModel, ButtonCardActions>
export type ScriptCardProps = SceneProps<ScriptCardModel, ScriptCardActions>
export type AutomationCardProps = SceneProps<AutomationCardModel, AutomationCardActions>

/** A big round push button: one press, nothing to report back. */
export function ButtonCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: ButtonCardProps): ReactElement {
  const t = useUiText()
  return (
    <DeviceCard
      kind="button"
      common={model.common}
      actions={actions}
      orientation={orientation}
      showName={showName}
      activity="idle"
      state={{
        label: t('uiLibrary.deviceCard.button.ready', 'Ready'),
        since: null,
        tone: 'muted',
      }}
      scene={{
        image: <CardIcon glyph="press" className={cn(SCENE_ICON_CLASS, 'text-foreground-muted')} />,
        columns: {
          right: model.pressable
            ? [
                columnButton('press', {
                  glyph: 'press',
                  tone: 'primary',
                  label: t('uiLibrary.deviceCard.button.press', 'Press'),
                  testId: 'dc-button-press',
                  onPress: actions.onPress,
                }),
              ]
            : [],
        },
      }}
    />
  )
}

/** A script: Run, or Stop while it runs; its last run and its last error. */
export function ScriptCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: ScriptCardProps): ReactElement {
  const t = useUiText()
  const command = model.running
    ? model.stoppable
      ? columnButton('stop', {
          glyph: 'stop',
          label: t('uiLibrary.deviceCard.script.stop', 'Stop'),
          testId: 'dc-script-stop',
          onPress: actions.onStop,
        })
      : null
    : model.runnable
      ? columnButton('run', {
          glyph: 'play',
          tone: 'primary',
          label: t('uiLibrary.deviceCard.script.run', 'Run'),
          testId: 'dc-script-run',
          onPress: actions.onRun,
        })
      : null
  return (
    <DeviceCard
      kind="script"
      common={withError(model.common, model.lastError)}
      actions={actions}
      orientation={orientation}
      showName={showName}
      activity={model.running ? 'running' : 'idle'}
      state={{
        label: model.running
          ? t('uiLibrary.deviceCard.script.running', 'Running')
          : t('uiLibrary.deviceCard.script.idle', 'Ready'),
        since:
          model.lastRun === null
            ? t('uiLibrary.deviceCard.script.neverRun', 'never run')
            : t('uiLibrary.deviceCard.script.lastRun', 'last run {{since}} ago', {
                since: model.lastRun,
              }),
        tone: model.running ? 'primary' : 'muted',
      }}
      scene={{
        image: (
          <CardIcon
            glyph="script"
            className={cn(
              SCENE_ICON_CLASS,
              model.running ? 'animate-pulse text-primary' : 'text-foreground-muted',
            )}
          />
        ),
        columns: { right: command === null ? [] : [command] },
      }}
    />
  )
}

/** An automation: on or off, and a manual run. */
export function AutomationCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: AutomationCardProps): ReactElement {
  const t = useUiText()
  return (
    <DeviceCard
      kind="automation"
      common={withError(model.common, model.lastError)}
      actions={actions}
      orientation={orientation}
      showName={showName}
      activity={model.enabled ? 'on' : 'off'}
      state={{
        label: model.enabled
          ? t('uiLibrary.deviceCard.automation.enabled', 'Enabled')
          : t('uiLibrary.deviceCard.automation.disabled', 'Disabled'),
        since:
          model.lastTriggered === null
            ? t('uiLibrary.deviceCard.automation.neverRun', 'never ran')
            : t('uiLibrary.deviceCard.automation.lastRun', 'last ran {{since}} ago', {
                since: model.lastTriggered,
              }),
        tone: model.enabled ? 'primary' : 'muted',
      }}
      scene={{
        image: (
          <CardIcon
            glyph="automation"
            className={cn(
              SCENE_ICON_CLASS,
              model.enabled ? 'text-primary' : 'text-foreground-subtle',
            )}
          />
        ),
        columns: {
          right: [
            ...(model.switchable
              ? [
                  columnButton('enabled', {
                    glyph: 'power',
                    tone: model.enabled ? 'default' : 'primary',
                    label: model.enabled
                      ? t('uiLibrary.deviceCard.automation.disable', 'Disable')
                      : t('uiLibrary.deviceCard.automation.enable', 'Enable'),
                    testId: 'dc-automation-enabled',
                    onPress: () => actions.onEnabled(!model.enabled),
                  }),
                ]
              : []),
            ...(model.triggerable
              ? [
                  columnButton('trigger', {
                    glyph: 'play',
                    label: t('uiLibrary.deviceCard.automation.trigger', 'Run now'),
                    testId: 'dc-automation-trigger',
                    onPress: actions.onTrigger,
                  }),
                ]
              : []),
          ],
        },
      }}
    />
  )
}
