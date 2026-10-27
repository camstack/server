/// <reference types="vite/client" />
import './index.css'
import { useEffect, useState } from 'react'
import { useAddonsCustom, type AddonPageProps } from '@camstack/ui-library'
import { AlexaSpeakSetupView, type SpeakSetupViewProps } from './speak-setup-view.js'
import { shotStep, SAMPLE_ECHOES } from './speak/setup-sample.js'
import type { AlexaRegion, SpeakMode } from './speak/constants.js'
import type { SetupPhase } from './speak/setup-flow.js'
import { reduceSetup } from './speak/setup-flow.js'
import { LoginResultSchema, SpeakStatusSchema } from './speak/actions.js'
import type { EchoDevice } from './speak/worker-protocol.js'
import { useT } from './i18n/index.js'

const ADDON_ID = 'import-alexa'

function noop(): void {}

function shotProps(phase: SetupPhase, phrase: string): SpeakSetupViewProps {
  const devices: readonly EchoDevice[] = phase === 'devices' ? SAMPLE_ECHOES : []
  return {
    phase,
    email: phase === 'sign-in' ? '' : 'ada@example.com',
    password: '',
    region: 'EU',
    otp: '',
    devices,
    selected: new Set(phase === 'devices' ? ['echo-kitchen', 'group-downstairs'] : []),
    mode: 'speak',
    volume: 40,
    phrase,
    busy: false,
    error: null,
    sessionAgeSec: phase === 'devices' ? 90 : null,
    onEmail: noop,
    onPassword: noop,
    onRegion: noop,
    onOtp: noop,
    onToggle: noop,
    onMode: noop,
    onVolume: noop,
    onPhrase: noop,
    onSignIn: noop,
    onOtpSubmit: noop,
    onSendTest: noop,
    onReset: noop,
  }
}

function ShotPage({ phase }: { readonly phase: SetupPhase }) {
  const { t } = useT()
  return <AlexaSpeakSetupView {...shotProps(phase, t('devices.phraseDefault'))} />
}

interface LiveState {
  readonly phase: SetupPhase
  readonly email: string
  readonly password: string
  readonly region: AlexaRegion
  readonly otp: string
  readonly devices: readonly EchoDevice[]
  readonly selected: ReadonlySet<string>
  readonly mode: SpeakMode
  readonly volume: number
  readonly phrase: string
  readonly error: string | null
  readonly sessionAgeSec: number | null
}

function clampVolume(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(100, Math.max(0, Math.round(value)))
}

function LivePage() {
  const { t } = useT()
  const custom = useAddonsCustom()
  const [state, setState] = useState<LiveState>({
    phase: 'sign-in',
    email: '',
    password: '',
    region: 'EU',
    otp: '',
    devices: [],
    selected: new Set<string>(),
    mode: 'speak',
    volume: 40,
    phrase: t('devices.phraseDefault'),
    error: null,
    sessionAgeSec: null,
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
      phase: parsed.data.phase,
      email: parsed.data.email,
      region: parsed.data.region,
      devices: parsed.data.devices,
      sessionAgeSec: parsed.data.session.loggedIn ? parsed.data.session.ageSec : null,
      error: null,
    }))
  }

  useEffect(() => {
    void loadStatus()
    // The first paint asks once. Later steps refresh themselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <AlexaSpeakSetupView
      phase={state.phase}
      email={state.email}
      password={state.password}
      region={state.region}
      otp={state.otp}
      devices={state.devices}
      selected={state.selected}
      mode={state.mode}
      volume={state.volume}
      phrase={state.phrase}
      busy={custom.isPending}
      error={state.error}
      sessionAgeSec={state.sessionAgeSec}
      onEmail={(email) => setState((current) => ({ ...current, email }))}
      onPassword={(password) => setState((current) => ({ ...current, password }))}
      onRegion={(region) => setState((current) => ({ ...current, region }))}
      onOtp={(otp) => setState((current) => ({ ...current, otp }))}
      onToggle={(id) =>
        setState((current) => {
          const selected = new Set(current.selected)
          if (selected.has(id)) selected.delete(id)
          else selected.add(id)
          return { ...current, selected }
        })
      }
      onMode={(mode) => setState((current) => ({ ...current, mode }))}
      onVolume={(volume) =>
        setState((current) => ({ ...current, volume: clampVolume(volume, current.volume) }))
      }
      onPhrase={(phrase) => setState((current) => ({ ...current, phrase }))}
      onSignIn={() => {
        void call('loginStart', {
          email: state.email,
          password: state.password,
          region: state.region,
        }).then((raw) => {
          const parsed = LoginResultSchema.safeParse(raw)
          if (!parsed.success) return
          setState((current) => ({
            ...current,
            phase: reduceSetup(current.phase, { type: 'login', status: parsed.data.status }),
            error: parsed.data.error ?? null,
            password: '',
          }))
          if (parsed.data.status === 'ok') void loadStatus()
        })
      }}
      onOtpSubmit={() => {
        void call('loginOtp', { code: state.otp }).then((raw) => {
          const parsed = LoginResultSchema.safeParse(raw)
          if (!parsed.success) return
          setState((current) => ({
            ...current,
            phase: reduceSetup(current.phase, { type: 'otp', status: parsed.data.status }),
            error: parsed.data.error ?? null,
          }))
          if (parsed.data.status === 'ok') void loadStatus()
        })
      }}
      onSendTest={() => {
        void call('sendTest', {
          echoIds: [...state.selected],
          mode: state.mode,
          volume: state.volume,
          text: state.phrase,
        })
      }}
      onReset={() =>
        setState((current) => ({
          ...current,
          phase: 'sign-in',
          otp: '',
          password: '',
          error: null,
        }))
      }
    />
  )
}

export default function AlexaSpeakPage(_props: AddonPageProps) {
  const shot = shotStep()
  if (shot !== null) return <ShotPage phase={shot} />
  return <LivePage />
}

if (import.meta.env?.DEV && document.getElementById('root')) {
  void import('@camstack/ui-library').then(({ mountAddonPage }) => {
    mountAddonPage(AlexaSpeakPage)
  })
}
