import { useState } from 'react'
import {
  Button,
  Checkbox,
  EmptyState,
  ErrorBox,
  Input,
  Label,
  PasswordInput,
  SECTION_BODY,
  STACK_GAP,
  SectionCard,
  Select,
  StatusBadge,
} from '@camstack/ui-library'
import { Megaphone } from 'lucide-react'
import type { AlexaRegion, SpeakMode } from './speak/constants.js'
import type { SetupPhase } from './speak/setup-flow.js'
import type { EchoDevice } from './speak/worker-protocol.js'
import { useT } from './i18n/index.js'

export interface SpeakSetupViewProps {
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
  readonly busy: boolean
  readonly error: string | null
  readonly sessionAgeSec: number | null
  readonly onEmail: (value: string) => void
  readonly onPassword: (value: string) => void
  readonly onRegion: (value: AlexaRegion) => void
  readonly onOtp: (value: string) => void
  readonly onToggle: (id: string) => void
  readonly onMode: (value: SpeakMode) => void
  readonly onVolume: (value: number) => void
  readonly onPhrase: (value: string) => void
  readonly onSignIn: () => void
  readonly onOtpSubmit: () => void
  readonly onSendTest: () => void
  readonly onReset: () => void
}

function regionOf(value: string): AlexaRegion {
  if (value === 'NA' || value === 'FE') return value
  return 'EU'
}

function modeOf(value: string): SpeakMode {
  return value === 'announce' ? 'announce' : 'speak'
}

export function AlexaSpeakSetupView(props: SpeakSetupViewProps) {
  const { t } = useT()
  const [passwordShown, setPasswordShown] = useState(false)
  return (
    <div className={`mx-auto flex max-w-3xl flex-col ${STACK_GAP} p-2 sm:p-4`}>
      <SectionCard headingId="alexa-speak-intro" title={t('page.title')} icon={Megaphone}>
        <p className={`${SECTION_BODY} text-sm text-foreground-muted`}>{t('page.intro')}</p>
      </SectionCard>
      {props.error !== null && props.error.length > 0 ? <ErrorBox message={props.error} /> : null}
      {props.phase === 'sign-in' ? (
        <SectionCard headingId="alexa-speak-signin" title={t('signIn.submit')}>
          <form
            className={`${SECTION_BODY} flex flex-col gap-3`}
            onSubmit={(event) => {
              event.preventDefault()
              props.onSignIn()
            }}
          >
            <Label htmlFor="alexa-email">{t('signIn.email')}</Label>
            <Input
              id="alexa-email"
              type="email"
              autoComplete="username"
              value={props.email}
              onChange={(event) => props.onEmail(event.target.value)}
            />
            <Label htmlFor="alexa-password">{t('signIn.password')}</Label>
            <PasswordInput
              id="alexa-password"
              autoComplete="current-password"
              value={props.password}
              shown={passwordShown}
              onToggleShown={() => setPasswordShown((shown) => !shown)}
              onValueChange={props.onPassword}
            />
            <Label htmlFor="alexa-region">{t('signIn.region')}</Label>
            <Select
              id="alexa-region"
              value={props.region}
              options={[
                { value: 'NA', label: t('signIn.regionNa') },
                { value: 'EU', label: t('signIn.regionEu') },
                { value: 'FE', label: t('signIn.regionFe') },
              ]}
              onChange={(event) => props.onRegion(regionOf(event.target.value))}
            />
            <Button type="submit" disabled={props.busy}>
              {props.busy ? t('actions.working') : t('signIn.submit')}
            </Button>
          </form>
        </SectionCard>
      ) : null}
      {props.phase === 'otp' ? (
        <SectionCard headingId="alexa-speak-otp" title={t('otp.title')}>
          <form
            className={`${SECTION_BODY} flex flex-col gap-3`}
            onSubmit={(event) => {
              event.preventDefault()
              props.onOtpSubmit()
            }}
          >
            <p className="text-sm text-foreground-muted">{t('otp.help')}</p>
            <Label htmlFor="alexa-otp">{t('otp.code')}</Label>
            <Input
              id="alexa-otp"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={props.otp}
              onChange={(event) => props.onOtp(event.target.value)}
            />
            <Button type="submit" disabled={props.busy}>
              {props.busy ? t('actions.working') : t('otp.submit')}
            </Button>
          </form>
        </SectionCard>
      ) : null}
      {props.phase === 'captcha' ? (
        <SectionCard headingId="alexa-speak-captcha" title={t('captcha.title')}>
          <div className={`${SECTION_BODY} flex flex-col gap-3`}>
            <p className="text-sm text-foreground-muted">{t('captcha.help')}</p>
            <Button type="button" variant="secondary" onClick={props.onReset}>
              {t('actions.differentAccount')}
            </Button>
          </div>
        </SectionCard>
      ) : null}
      {props.phase === 'devices' ? (
        <SectionCard headingId="alexa-speak-devices" title={t('devices.title')}>
          <div className={`${SECTION_BODY} flex flex-col gap-3`}>
            <p className="text-sm text-foreground-muted">{t('devices.help')}</p>
            {props.sessionAgeSec !== null ? (
              <p className="text-xs text-foreground-subtle">
                {t('session.age', { seconds: props.sessionAgeSec })}
              </p>
            ) : null}
            {props.devices.length === 0 ? (
              <EmptyState title={t('devices.empty')} />
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {props.devices.map((device) => (
                  <li key={device.id} className="flex items-center gap-3 px-3 py-2">
                    <Checkbox
                      checked={props.selected.has(device.id)}
                      aria-label={t('devices.pick', { name: device.name })}
                      onChange={() => props.onToggle(device.id)}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-foreground">{device.name}</p>
                      <p className="truncate text-xs text-foreground-subtle">
                        {device.kind === 'group' ? t('devices.group') : device.family}
                      </p>
                    </div>
                    <StatusBadge status={device.online ? 'online' : 'offline'} size="sm" />
                    {device.dnd ? (
                      <StatusBadge status="idle" label={t('devices.dnd')} size="sm" />
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <Label htmlFor="alexa-mode">{t('devices.mode')}</Label>
            <Select
              id="alexa-mode"
              value={props.mode}
              options={[
                { value: 'speak', label: t('devices.modeSpeak') },
                { value: 'announce', label: t('devices.modeAnnounce') },
              ]}
              onChange={(event) => props.onMode(modeOf(event.target.value))}
            />
            <Label htmlFor="alexa-volume">{t('devices.volume')}</Label>
            <Input
              id="alexa-volume"
              type="number"
              min={0}
              max={100}
              value={String(props.volume)}
              onChange={(event) => props.onVolume(Number(event.target.value))}
            />
            <Label htmlFor="alexa-phrase">{t('devices.phrase')}</Label>
            <Input
              id="alexa-phrase"
              value={props.phrase}
              onChange={(event) => props.onPhrase(event.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={props.busy || props.selected.size === 0}
                onClick={props.onSendTest}
              >
                {props.busy ? t('actions.working') : t('devices.send')}
              </Button>
              <Button type="button" variant="secondary" onClick={props.onReset}>
                {t('actions.differentAccount')}
              </Button>
            </div>
          </div>
        </SectionCard>
      ) : null}
    </div>
  )
}
