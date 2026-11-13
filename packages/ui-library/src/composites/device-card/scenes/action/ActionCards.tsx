import type { ReactElement } from 'react'
import { useUiText } from '../../../../contexts/ui-text'
import { cn } from '../../../../lib/cn'
import { CardButton } from '../../parts/CardButton'
import { CardIcon } from '../../parts/CardIcon'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation } from '../../shell/model'
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
        image: <CardIcon glyph="press" className="h-20 w-20 text-foreground-muted" />,
        right: model.pressable ? (
          <CardButton
            glyph="press"
            tone="primary"
            data-testid="dc-button-press"
            onClick={actions.onPress}
          >
            {t('uiLibrary.deviceCard.button.press', 'Press')}
          </CardButton>
        ) : null,
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
    ? model.stoppable && (
        <CardButton glyph="stop" data-testid="dc-script-stop" onClick={actions.onStop}>
          {t('uiLibrary.deviceCard.script.stop', 'Stop')}
        </CardButton>
      )
    : model.runnable && (
        <CardButton glyph="play" tone="primary" data-testid="dc-script-run" onClick={actions.onRun}>
          {t('uiLibrary.deviceCard.script.run', 'Run')}
        </CardButton>
      )
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
              'h-20 w-20',
              model.running ? 'animate-pulse text-primary' : 'text-foreground-muted',
            )}
          />
        ),
        right: command === false ? null : command,
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
  const showRight = model.switchable || model.triggerable
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
            className={cn('h-20 w-20', model.enabled ? 'text-primary' : 'text-foreground-subtle')}
          />
        ),
        right: showRight ? (
          <>
            {model.switchable ? (
              <CardButton
                glyph="power"
                tone={model.enabled ? 'default' : 'primary'}
                data-testid="dc-automation-enabled"
                onClick={() => actions.onEnabled(!model.enabled)}
              >
                {model.enabled
                  ? t('uiLibrary.deviceCard.automation.disable', 'Disable')
                  : t('uiLibrary.deviceCard.automation.enable', 'Enable')}
              </CardButton>
            ) : null}
            {model.triggerable ? (
              <CardButton
                glyph="play"
                data-testid="dc-automation-trigger"
                onClick={actions.onTrigger}
              >
                {t('uiLibrary.deviceCard.automation.trigger', 'Run now')}
              </CardButton>
            ) : null}
          </>
        ) : null,
      }}
    />
  )
}
