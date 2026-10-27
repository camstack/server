import {
  Button,
  Checkbox,
  EmptyState,
  ErrorBox,
  Input,
  Label,
  SECTION_BODY,
  STACK_GAP,
  SectionCard,
  Select,
  StatusBadge,
  type StatusBadgeStatus,
} from '@camstack/ui-library'
import { Megaphone } from 'lucide-react'
import type { SpeakStatus } from './speak/actions.js'
import type { SpeakMode } from './speak/constants.js'
import { useT } from './i18n/index.js'

export type SpeakBrokerStatus = SpeakStatus['brokers'][number]

export interface SpeakSetupViewProps {
  readonly brokers: readonly SpeakBrokerStatus[]
  readonly brokerId: string
  readonly notice: SpeakStatus['notice']
  readonly unassignedTargets: number
  readonly selected: ReadonlySet<string>
  readonly mode: SpeakMode
  readonly volume: number
  readonly phrase: string
  readonly busy: boolean
  readonly error: string | null
  readonly onBroker: (id: string) => void
  readonly onToggle: (id: string) => void
  readonly onMode: (value: SpeakMode) => void
  readonly onVolume: (value: number) => void
  readonly onPhrase: (value: string) => void
  readonly onSendTest: () => void
}

function modeOf(value: string): SpeakMode {
  return value === 'announce' ? 'announce' : 'speak'
}

function badgeOf(state: SpeakBrokerStatus['state']): StatusBadgeStatus {
  if (state === 'ready') return 'online'
  if (state === 'failed') return 'error'
  return 'idle'
}

export function AlexaSpeakSetupView(props: SpeakSetupViewProps) {
  const { t } = useT()
  const broker = props.brokers.find((row) => row.id === props.brokerId) ?? props.brokers[0]
  const stateLabel: Record<SpeakBrokerStatus['state'], string> = {
    ready: t('state.ready'),
    starting: t('state.starting'),
    'broker-not-signed-in': t('state.notSignedIn'),
    failed: t('state.failed'),
  }
  return (
    <div className={`mx-auto flex max-w-3xl flex-col ${STACK_GAP} p-2 sm:p-4`}>
      <SectionCard headingId="alexa-speak-intro" title={t('page.title')} icon={Megaphone}>
        <p className={`${SECTION_BODY} text-sm text-foreground-muted`}>{t('page.intro')}</p>
      </SectionCard>
      {props.error !== null && props.error.length > 0 ? <ErrorBox message={props.error} /> : null}
      {props.notice !== '' ? (
        <ErrorBox
          variant="warning"
          message={
            <>
              <span className="block">
                {props.notice === 'no-broker' ? t('notice.noBroker') : t('notice.chooseBroker')}
              </span>
              <span className="mt-1 block text-xs">
                {t('notice.waiting', { count: props.unassignedTargets })}
              </span>
            </>
          }
        />
      ) : null}
      {broker === undefined ? (
        <SectionCard headingId="alexa-speak-accounts" title={t('accounts.label')}>
          <div className={SECTION_BODY}>
            <EmptyState title={t('accounts.none')} />
          </div>
        </SectionCard>
      ) : (
        <SectionCard headingId="alexa-speak-devices" title={t('devices.title')}>
          <div className={`${SECTION_BODY} flex flex-col gap-3`}>
            {props.brokers.length > 1 ? (
              <>
                <Label htmlFor="alexa-broker">{t('accounts.label')}</Label>
                <Select
                  id="alexa-broker"
                  value={broker.id}
                  options={props.brokers.map((row) => ({ value: row.id, label: row.name }))}
                  onChange={(event) => props.onBroker(event.target.value)}
                />
              </>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-foreground">{broker.name}</span>
              <StatusBadge
                status={badgeOf(broker.state)}
                label={stateLabel[broker.state]}
                size="sm"
              />
              {broker.state === 'ready' && broker.session.loggedIn ? (
                <span className="text-xs text-foreground-subtle">
                  {t('session.age', { seconds: broker.session.ageSec })}
                </span>
              ) : null}
            </div>
            {broker.state === 'broker-not-signed-in' ? (
              <p className="text-sm text-foreground-muted">{t('state.notSignedInHelp')}</p>
            ) : null}
            {broker.state === 'failed' && broker.error !== undefined ? (
              <ErrorBox message={broker.error} />
            ) : null}
            <p className="text-sm text-foreground-muted">{t('devices.help')}</p>
            {broker.devices.length === 0 ? (
              <EmptyState title={t('devices.empty')} />
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {broker.devices.map((device) => (
                  <li key={device.id} className="flex items-center gap-3 px-3 py-2">
                    <Checkbox
                      checked={props.selected.has(device.id)}
                      aria-label={t('devices.pick', { name: device.name })}
                      onChange={() => props.onToggle(device.id)}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-foreground">{device.name}</p>
                      <p className="truncate text-xs text-foreground-subtle">
                        {[device.room, device.kind === 'group' ? t('devices.group') : device.family]
                          .filter((part): part is string => part !== undefined && part.length > 0)
                          .join(' · ')}
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
                disabled={props.busy || props.selected.size === 0 || broker.state !== 'ready'}
                onClick={props.onSendTest}
              >
                {props.busy ? t('actions.working') : t('devices.send')}
              </Button>
            </div>
          </div>
        </SectionCard>
      )}
    </div>
  )
}
