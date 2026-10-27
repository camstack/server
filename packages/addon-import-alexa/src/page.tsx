/// <reference types="vite/client" />
import './index.css'
import { useEffect, useState } from 'react'
import { useAddonsCustom, type AddonPageProps } from '@camstack/ui-library'
import { AlexaSpeakSetupView, type SpeakSetupViewProps } from './speak-setup-view.js'
import { sampleStatus, shotStep, type ShotStep } from './speak/setup-sample.js'
import type { SpeakMode } from './speak/constants.js'
import { SpeakStatusSchema, type SpeakStatus } from './speak/actions.js'
import { useT } from './i18n/index.js'

const ADDON_ID = 'import-alexa'

function noop(): void {}

function viewProps(
  status: SpeakStatus,
  phrase: string,
  overrides: Partial<SpeakSetupViewProps> = {},
): SpeakSetupViewProps {
  return {
    brokers: status.brokers,
    brokerId: status.brokers[0]?.id ?? '',
    notice: status.notice,
    unassignedTargets: status.unassignedTargets,
    selected: new Set(['echo-kitchen', 'group-downstairs']),
    mode: 'speak',
    volume: 40,
    phrase,
    busy: false,
    error: null,
    onBroker: noop,
    onToggle: noop,
    onMode: noop,
    onVolume: noop,
    onPhrase: noop,
    onSendTest: noop,
    ...overrides,
  }
}

function ShotPage({ step }: { readonly step: ShotStep }) {
  const { t } = useT()
  return <AlexaSpeakSetupView {...viewProps(sampleStatus(step), t('devices.phraseDefault'))} />
}

interface LiveState {
  readonly status: SpeakStatus
  readonly brokerId: string
  readonly selected: ReadonlySet<string>
  readonly mode: SpeakMode
  readonly volume: number
  readonly phrase: string
  readonly error: string | null
}

function clampVolume(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(100, Math.max(0, Math.round(value)))
}

function LivePage() {
  const { t } = useT()
  const custom = useAddonsCustom()
  const [state, setState] = useState<LiveState>({
    status: { brokers: [], unassignedTargets: 0, notice: '' },
    brokerId: '',
    selected: new Set<string>(),
    mode: 'speak',
    volume: 40,
    phrase: t('devices.phraseDefault'),
    error: null,
  })

  async function call(action: string, input: unknown): Promise<unknown> {
    try {
      return await custom.mutateAsync({ addonId: ADDON_ID, action, input })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setState((current) => ({ ...current, error: message }))
      return null
    }
  }

  async function loadStatus(): Promise<void> {
    const parsed = SpeakStatusSchema.safeParse(await call('speakStatus', {}))
    if (!parsed.success) return
    setState((current) => ({
      ...current,
      status: parsed.data,
      brokerId: parsed.data.brokers.some((row) => row.id === current.brokerId)
        ? current.brokerId
        : (parsed.data.brokers[0]?.id ?? ''),
      error: null,
    }))
  }

  useEffect(() => {
    void loadStatus()
    // The first paint asks once. A test send refreshes itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <AlexaSpeakSetupView
      {...viewProps(state.status, state.phrase, {
        brokerId: state.brokerId,
        selected: state.selected,
        mode: state.mode,
        volume: state.volume,
        busy: custom.isPending,
        error: state.error,
        onBroker: (brokerId) =>
          setState((current) => ({ ...current, brokerId, selected: new Set<string>() })),
        onToggle: (id) =>
          setState((current) => {
            const selected = new Set(current.selected)
            if (selected.has(id)) selected.delete(id)
            else selected.add(id)
            return { ...current, selected }
          }),
        onMode: (mode) => setState((current) => ({ ...current, mode })),
        onVolume: (volume) =>
          setState((current) => ({ ...current, volume: clampVolume(volume, current.volume) })),
        onPhrase: (phrase) => setState((current) => ({ ...current, phrase })),
        onSendTest: () => {
          void call('sendTest', {
            brokerId: state.brokerId,
            echoIds: [...state.selected],
            mode: state.mode,
            volume: state.volume,
            text: state.phrase,
          }).then(() => loadStatus())
        },
      })}
    />
  )
}

export default function AlexaSpeakPage(_props: AddonPageProps) {
  const shot = shotStep()
  if (shot !== null) return <ShotPage step={shot} />
  return <LivePage />
}

if (import.meta.env?.DEV && document.getElementById('root')) {
  void import('@camstack/ui-library').then(({ mountAddonPage }) => {
    mountAddonPage(AlexaSpeakPage)
  })
}
