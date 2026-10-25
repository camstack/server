/**
 * "Connect a phone" — a QR code + copyable central link that opens the
 * CamStack viewer app (or, without the app, the web viewer) on THIS hub.
 *
 * The link carries the hub origin only (`lib/connect-phone-link.ts`); the app
 * signs in afterwards with the ordinary login. No cloud account, no token in
 * the QR — a photographed screen leaks an address, never a session.
 *
 * Every state is rendered from an ANSWERED query (D315): pending says
 * "reading", a failed read says it failed (with the reason), and only an
 * answer with no phone-reachable address says there is none.
 */
import { useMemo, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Loader2, Smartphone } from 'lucide-react'
import {
  Button,
  CopyButton,
  QrCode,
  Select,
  useLocalNetworkGetAddresses,
  useLocalNetworkGetConnectionEndpoints,
} from '@camstack/ui-library'

import {
  buildConnectLink,
  rankPhoneCandidates,
  selectPhoneCandidate,
  type PhoneCandidate,
  type PhoneCandidateTier,
} from '../../lib/connect-phone-link'

const QR_SIZE_PX = 176

/**
 * `scheme: 'https'` because the result is handed to a phone, not to this
 * page: LAN entries come back as the hub's TLS socket, or as its plain-HTTP
 * LAN listener when that is enabled — both real sockets. No `port`: that is a
 * legacy hint the hub would only echo (see the cap's doc).
 */
const ENDPOINTS_INPUT = { scheme: 'https' } as const

export function ConnectPhoneCard(): ReactElement {
  const { t } = useTranslation()
  const endpointsQuery = useLocalNetworkGetConnectionEndpoints(ENDPOINTS_INPUT)
  // The public endpoint pre-selects the address (D734). Optional: until this
  // answers, or when it fails, the ranked list alone decides.
  const addressesQuery = useLocalNetworkGetAddresses(ENDPOINTS_INPUT)
  const preferredOrigin = addressesQuery.data?.roles.publicEndpoint.resolved ?? null

  return (
    <div className="rounded-lg border border-border bg-surface overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
        <Smartphone className="h-3.5 w-3.5 text-foreground-subtle" />
        <div className="text-xs font-semibold text-foreground">{t('connectPhone.title')}</div>
      </div>
      <div className="p-4 space-y-3">
        <p className="text-[11px] text-foreground-subtle">{t('connectPhone.description')}</p>
        {endpointsQuery.isPending ? (
          <div className="flex items-center gap-2 text-[11px] text-foreground-subtle">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('connectPhone.loading')}
          </div>
        ) : endpointsQuery.isError ? (
          <div className="flex items-start gap-2 text-[11px] text-danger">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0 space-y-1.5">
              <div className="break-words">
                {t('connectPhone.error', { message: endpointsQuery.error.message })}
              </div>
              <Button size="sm" variant="ghost" onClick={() => void endpointsQuery.refetch()}>
                {t('connectPhone.retry')}
              </Button>
            </div>
          </div>
        ) : (
          <ConnectPhoneBody
            candidates={rankPhoneCandidates(endpointsQuery.data.endpoints)}
            preferredOrigin={preferredOrigin}
          />
        )}
      </div>
    </div>
  )
}

interface ConnectPhoneBodyProps {
  readonly candidates: readonly PhoneCandidate[]
  /** The hub's public endpoint, or null when unknown. */
  readonly preferredOrigin: string | null
}

function ConnectPhoneBody({ candidates, preferredOrigin }: ConnectPhoneBodyProps): ReactElement {
  const { t } = useTranslation()
  const [pickedOrigin, setPickedOrigin] = useState<string | null>(null)
  const selected = selectPhoneCandidate(candidates, pickedOrigin, preferredOrigin)
  const link = useMemo(() => (selected ? buildConnectLink(selected.origin) : null), [selected])

  if (selected === null || link === null) {
    return <p className="text-[11px] text-foreground-subtle">{t('connectPhone.empty')}</p>
  }

  const tierLabel = (tier: PhoneCandidateTier): string => t(`connectPhone.tier.${tier}`)
  const options = candidates.map((c) => ({
    value: c.origin,
    label: `${tierLabel(c.tier)} — ${c.origin}`,
  }))

  return (
    <div className="flex flex-col sm:flex-row gap-4">
      <QrCode value={link} size={QR_SIZE_PX} alt={t('connectPhone.qrAlt')} className="self-start" />
      <div className="flex-1 min-w-0 space-y-3">
        <label className="block space-y-1">
          <span className="text-[11px] font-medium text-foreground">
            {t('connectPhone.addressLabel')}
          </span>
          <Select
            value={selected.origin}
            options={options}
            onChange={(e) => setPickedOrigin(e.target.value)}
          />
          <span className="block text-[10px] text-foreground-subtle">
            {tierLabel(selected.tier)} · {selected.label}
          </span>
        </label>

        {!selected.secure && <Notice text={t('connectPhone.insecure')} />}
        {!selected.plausible && <Notice text={t('connectPhone.implausible')} />}

        <div className="space-y-1">
          <span className="text-[11px] font-medium text-foreground">
            {t('connectPhone.linkLabel')}
          </span>
          <div className="flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1">
            <code className="flex-1 min-w-0 font-mono text-[11px] text-foreground break-all select-all">
              {link}
            </code>
            <CopyButton value={link} srLabel={t('connectPhone.linkLabel')} />
          </div>
        </div>

        <p className="text-[11px] text-foreground-subtle">{t('connectPhone.signInHint')}</p>
      </div>
    </div>
  )
}

interface NoticeProps {
  readonly text: string
}

function Notice({ text }: NoticeProps): ReactElement {
  return (
    <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-2.5 py-1.5 text-[11px] text-foreground">
      <AlertTriangle className="h-3.5 w-3.5 text-warning mt-0.5 shrink-0" />
      <span>{text}</span>
    </div>
  )
}
