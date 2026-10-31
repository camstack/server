import { useEffect, useMemo, useState } from 'react'
import {
  Badge,
  Button,
  ErrorBox,
  FormField,
  Input,
  SectionCard,
  Select,
} from '@camstack/ui-library'
import {
  CcuDevicesResultSchema,
  INSTALL_MODES,
  OkResultSchema,
  PairingStatusSchema,
  type CcuDeviceRow,
  type PairingInterface,
} from '../ccu/ccu-schemas.js'
import { useT } from '../i18n/index.js'
import type { CcuTrpc } from './ccu-client.js'
import { useCcuData } from './use-ccu-data.js'
import { useCcuWrite } from './use-ccu-write.js'

const STATUS_POLL_MS = 3000
const DEVICES_POLL_MS = 4000
const DEFAULT_SECONDS = 60

function isOpen(iface: PairingInterface): boolean {
  return iface.secondsLeft !== null && iface.secondsLeft > 0
}

function InterfaceCard(props: {
  readonly iface: PairingInterface
  readonly busy: boolean
  readonly onStart: (seconds: number, mode: string | undefined) => void
  readonly onStop: () => void
}) {
  const { iface, busy, onStart, onStop } = props
  const { t } = useT()
  const [seconds, setSeconds] = useState(String(DEFAULT_SECONDS))
  const [mode, setMode] = useState<string>(INSTALL_MODES[0])
  const parsed = Number(seconds)
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 3600

  const status =
    iface.error !== null ? (
      <Badge variant="danger">{t('pairing.statusUnknown')}</Badge>
    ) : iface.secondsLeft === null ? (
      <Badge variant="neutral">{t('pairing.statusUnknown')}</Badge>
    ) : isOpen(iface) ? (
      <Badge variant="success">{t('pairing.statusOpen', { seconds: iface.secondsLeft })}</Badge>
    ) : (
      <Badge variant="neutral">{t('pairing.statusClosed')}</Badge>
    )

  return (
    <SectionCard headingId={`hm-pairing-${iface.name}-heading`} title={iface.name} actions={status}>
      <div className="flex flex-col gap-3 p-3" data-testid={`hm-pairing-${iface.name}`}>
        {iface.error !== null && <p className="text-xs text-danger">{iface.error}</p>}
        <div className="flex flex-wrap items-end gap-3">
          <FormField label={t('pairing.fieldSeconds')}>
            <Input
              type="number"
              min={1}
              max={3600}
              value={seconds}
              onChange={(event) => setSeconds(event.target.value)}
            />
          </FormField>
          {iface.supportsSecure && (
            <FormField label={t('pairing.fieldMode')}>
              <Select
                value={mode}
                onChange={(event) => setMode(event.target.value)}
                options={INSTALL_MODES.map((value) => ({
                  value,
                  label: t(value === 'secure' ? 'pairing.modeSecure' : 'pairing.modeNormal'),
                }))}
              />
            </FormField>
          )}
          <Button
            type="button"
            disabled={!valid || busy}
            onClick={() => onStart(parsed, iface.supportsSecure ? mode : undefined)}
          >
            {t('pairing.start')}
          </Button>
          {isOpen(iface) && (
            <Button type="button" variant="secondary" disabled={busy} onClick={onStop}>
              {t('pairing.stop')}
            </Button>
          )}
        </div>
      </div>
    </SectionCard>
  )
}

/** Learn mode on the radio interfaces, and the devices that appeared on the CCU since this tab opened. */
export function CcuPairingTab(props: { readonly trpc: CcuTrpc; readonly integrationId: string }) {
  const { trpc, integrationId } = props
  const { t } = useT()
  const write = useCcuWrite(trpc)
  const input = useMemo(() => ({ integrationId }), [integrationId])
  const status = useCcuData(trpc, 'ccuPairingStatus', input, PairingStatusSchema, {
    pollMs: STATUS_POLL_MS,
  })
  const anyOpen = (status.data?.interfaces ?? []).some(isOpen)
  const devices = useCcuData(trpc, 'listCcuDevices', input, CcuDevicesResultSchema, {
    ...(anyOpen ? { pollMs: DEVICES_POLL_MS } : {}),
  })
  const [busy, setBusy] = useState(false)
  const [baseline, setBaseline] = useState<ReadonlySet<string> | null>(null)

  useEffect(() => {
    if (baseline === null && devices.data !== undefined) {
      setBaseline(new Set(devices.data.devices.map((device) => device.address)))
    }
  }, [baseline, devices.data])

  const found = useMemo<readonly CcuDeviceRow[]>(
    () =>
      baseline === null
        ? []
        : (devices.data?.devices ?? []).filter((device) => !baseline.has(device.address)),
    [baseline, devices.data],
  )

  const setMode = async (
    iface: PairingInterface,
    on: boolean,
    seconds: number,
    mode: string | undefined,
  ): Promise<void> => {
    setBusy(true)
    try {
      const done = await write({
        action: 'setCcuInstallMode',
        input: {
          integrationId,
          interface: iface.name,
          on,
          ...(on ? { seconds } : {}),
          ...(on && mode !== undefined ? { mode } : {}),
        },
        schema: OkResultSchema,
        title: on
          ? t('pairing.startTitle', { name: iface.name })
          : t('pairing.stopTitle', { name: iface.name }),
        message: on
          ? t('pairing.startMessage', { name: iface.name, seconds })
          : t('pairing.stopMessage', { name: iface.name }),
        confirmLabel: on ? t('pairing.start') : t('pairing.stop'),
        variant: 'warning',
      })
      if (done !== null) status.reload()
    } finally {
      setBusy(false)
    }
  }

  if (status.error !== null) {
    return (
      <ErrorBox title={t('pairing.loadFailed')} message={status.error} onRetry={status.reload} />
    )
  }
  if (status.data === undefined) {
    return <p className="text-sm text-foreground-subtle">{t('common.loading')}</p>
  }
  if (status.data.error !== null) {
    return (
      <ErrorBox
        title={t('pairing.loadFailed')}
        message={status.data.error}
        onRetry={status.reload}
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-foreground-subtle">{t('pairing.hmipKeyNote')}</p>
      {status.data.interfaces.length === 0 ? (
        <p className="text-sm text-foreground-subtle">{t('pairing.noInterfaces')}</p>
      ) : (
        status.data.interfaces.map((iface) => (
          <InterfaceCard
            key={iface.name}
            iface={iface}
            busy={busy}
            onStart={(seconds, mode) => void setMode(iface, true, seconds, mode)}
            onStop={() => void setMode(iface, false, 0, undefined)}
          />
        ))
      )}
      <SectionCard headingId="hm-pairing-found" title={t('pairing.foundTitle')}>
        {devices.error !== null && baseline === null ? (
          <p className="p-3 text-xs text-danger">{devices.error}</p>
        ) : found.length === 0 ? (
          <p className="p-3 text-sm text-foreground-subtle" data-testid="hm-pairing-none">
            {anyOpen ? t('pairing.foundWaiting') : t('pairing.foundNone')}
          </p>
        ) : (
          <ul className="flex flex-col gap-1 p-3" data-testid="hm-pairing-found">
            {found.map((device) => (
              <li key={device.address} className="flex items-center gap-2 text-sm text-foreground">
                <span>{device.name ?? device.address}</span>
                <span className="text-xs text-foreground-subtle">
                  {device.address} · {device.type}
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  )
}
