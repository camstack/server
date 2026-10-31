/**
 * Push-to-talk panel for the `intercom` cap.
 *
 * Layout:
 *   - Big circular mic button (start/stop)
 *   - State label below it (Idle / Connecting / Talking / Error)
 *   - Error banner when present
 *   - Helper text: explains mic permission + camera-side speaker
 *
 * Behaviour:
 *   - Click mic when idle → request mic permission + open session
 *   - Click mic when talking → stop session, release mic
 *   - State sync via the `useDeviceIntercom` hook
 *
 * The hook owns ALL the WebRTC + tRPC + media-track state — this
 * component is presentation-only.
 */
import { Mic, MicOff, Loader2, AlertCircle } from 'lucide-react'
import { useDeviceIntercom } from '../../hooks/useDeviceIntercom'
import { Trans, useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Button } from '@camstack/ui-library'

interface IntercomPanelProps {
  deviceId: number
}

export function IntercomPanel({ deviceId }: IntercomPanelProps) {
  const { t } = useTranslation()
  const { state, error, start, stop, isTalking } = useDeviceIntercom(deviceId)

  const inProgress =
    state === 'requesting-mic' ||
    state === 'starting' ||
    state === 'connecting' ||
    state === 'stopping'

  const handleClick = () => {
    if (isTalking || state === 'connecting') {
      void stop()
    } else if (state === 'idle' || state === 'error') {
      void start()
    }
  }

  const buttonLabel = stateToLabel(state, t)
  const buttonHint = stateToHint(state, t)

  return (
    <div className="flex flex-col items-center gap-3 px-4 py-6 text-xs">
      <Button
        variant="unstyled"
        type="button"
        onClick={handleClick}
        disabled={inProgress}
        title={buttonHint}
        aria-label={buttonHint}
        className={`flex h-20 w-20 items-center justify-center rounded-full border-2 transition-all ${
          isTalking
            ? 'border-success bg-success/15 text-success animate-pulse-talk'
            : state === 'error'
              ? 'border-danger/50 bg-danger/10 text-danger hover:bg-danger/15'
              : inProgress
                ? 'border-foreground-subtle/30 bg-surface-elevated/40 text-foreground-subtle'
                : 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20 hover:border-primary'
        } ${inProgress ? 'cursor-wait' : 'cursor-pointer'}`}
      >
        {inProgress ? (
          <Loader2 className="h-7 w-7 animate-spin" />
        ) : isTalking ? (
          <Mic className="h-7 w-7" />
        ) : state === 'error' ? (
          <AlertCircle className="h-7 w-7" />
        ) : (
          <MicOff className="h-7 w-7" />
        )}
      </Button>

      <div className="flex flex-col items-center gap-0.5">
        <span className="text-[12px] font-semibold text-foreground">{buttonLabel}</span>
        <span className="text-[10.5px] text-foreground-subtle text-center max-w-[240px]">
          {buttonHint}
        </span>
      </div>

      {error && (
        <div className="w-full rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[10.5px] text-danger">
          <div className="flex items-start gap-2">
            <AlertCircle className="h-3 w-3 flex-shrink-0 mt-0.5" />
            <span className="leading-snug break-words">{error}</span>
          </div>
        </div>
      )}

      <div className="w-full border-t border-border/40 pt-3 mt-1 space-y-1.5">
        <p className="text-[10px] text-foreground-subtle leading-relaxed">
          <Trans
            i18nKey="device.intercomPanel.micNote"
            components={{ b: <strong className="font-semibold text-foreground/80" /> }}
          />
        </p>
        <p className="text-[10px] text-foreground-subtle leading-relaxed">
          <Trans
            i18nKey="device.intercomPanel.audioPathNote"
            components={{ b: <strong className="font-semibold text-foreground/80" /> }}
          />
        </p>
      </div>
    </div>
  )
}

function stateToLabel(state: ReturnType<typeof useDeviceIntercom>['state'], t: TFunction): string {
  switch (state) {
    case 'idle':
      return t('device.intercomPanel.state.idle')
    case 'requesting-mic':
      return t('device.intercomPanel.state.requestingMic')
    case 'starting':
      return t('device.intercomPanel.state.starting')
    case 'connecting':
      return t('device.intercomPanel.state.connecting')
    case 'talking':
      return t('device.intercomPanel.state.talking')
    case 'stopping':
      return t('device.intercomPanel.state.stopping')
    case 'error':
      return t('device.intercomPanel.state.error')
  }
}

function stateToHint(state: ReturnType<typeof useDeviceIntercom>['state'], t: TFunction): string {
  switch (state) {
    case 'idle':
      return t('device.intercomPanel.hint.idle')
    case 'requesting-mic':
      return t('device.intercomPanel.hint.requestingMic')
    case 'starting':
      return t('device.intercomPanel.hint.starting')
    case 'connecting':
      return t('device.intercomPanel.hint.connecting')
    case 'talking':
      return t('device.intercomPanel.hint.talking')
    case 'stopping':
      return t('device.intercomPanel.hint.stopping')
    case 'error':
      return t('device.intercomPanel.hint.error')
  }
}
