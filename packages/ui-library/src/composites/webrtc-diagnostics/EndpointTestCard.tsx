/**
 * "ICE servers" — the live ICE server list (`turnProvider.getTurnServers`, the
 * same union every viewer is handed) probed endpoint by endpoint from THIS
 * browser, plus the NAT mapping check.
 *
 * Owns no hub data beyond the list it is given through `loadServers`.
 * Credentials are passed to the probes and never rendered: a row shows `auth`.
 */
import { Loader2, Network, Play, RefreshCw, Route } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { LIST_ROW, SECTION_BODY, TEXT_HINT } from '../../lib/responsive'
import { Badge } from '../../primitives/badge'
import { Button } from '../../primitives/button'
import { Checkbox } from '../../primitives/checkbox'
import { type DataColumn, DataTable } from '../data-table'
import { KeyValueList } from '../key-value-list'
import { SectionCard } from '../section-card'
import {
  type EndpointTestRow,
  flattenIceServers,
  type IceEndpoint,
  type IceEndpointScheme,
  type IceServerEntry,
  type NatCheckResult,
  runNatCheck,
  testEndpoint,
} from './endpoint-test'
import { useUiText, type UiTextFn } from '../../contexts/ui-text'
import { fmtMs, fmtText, UNKNOWN_TEXT } from './format'

export interface EndpointTestCardProps {
  /** Fetch the live ICE server list (`turnProvider.getTurnServers`). */
  readonly loadServers: () => Promise<readonly IceServerEntry[]>
}

const SCHEME_VARIANT: Readonly<
  Record<IceEndpointScheme, 'info' | 'warning' | 'success' | 'default'>
> = {
  stun: 'info',
  turn: 'warning',
  turns: 'success',
  other: 'default',
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function yesNo(value: boolean | null, yes: string, no: string): ReactNode {
  if (value === null) return <span className="text-foreground-subtle">{UNKNOWN_TEXT}</span>
  return <span className={value ? 'text-success' : 'text-danger'}>{value ? yes : no}</span>
}

function buildResultColumns(t: UiTextFn): readonly DataColumn<EndpointTestRow>[] {
  return [
    {
      key: 'endpoint',
      header: t('uiLibrary.endpointTest.colEndpoint', 'Endpoint'),
      nowrap: false,
      render: (r) => <span className="break-all font-mono text-[11px]">{r.url}</span>,
    },
    {
      key: 'srflx',
      header: t('uiLibrary.endpointTest.colMapped', 'Mapped (srflx)'),
      render: (r) => (
        <span className="font-mono text-[11px]">
          {r.srflx ?? t('uiLibrary.endpointTest.none', 'none')}
        </span>
      ),
    },
    {
      key: 'relay',
      header: t('uiLibrary.endpointTest.colRelay', 'Relay'),
      render: (r) =>
        r.scheme === 'stun' ? (
          <span className="text-foreground-subtle">{t('uiLibrary.endpointTest.na', 'n/a')}</span>
        ) : (
          yesNo(
            r.relay,
            t('uiLibrary.endpointTest.allocated', 'allocated'),
            t('uiLibrary.endpointTest.none', 'none'),
          )
        ),
    },
    {
      key: 'proto',
      header: t('uiLibrary.endpointTest.colProto', 'Relay protocol'),
      render: (r) =>
        r.scheme === 'stun' ? t('uiLibrary.endpointTest.na', 'n/a') : fmtText(r.relayProtocol),
    },
    {
      key: 'connect',
      header: t('uiLibrary.endpointTest.colConnect', 'Relay connect'),
      render: (r) =>
        r.relayConnected === null ? (
          <span className="text-foreground-subtle">{t('uiLibrary.endpointTest.na', 'n/a')}</span>
        ) : (
          yesNo(
            r.relayConnected,
            t('uiLibrary.endpointTest.connected', 'connected'),
            t('uiLibrary.endpointTest.failed', 'failed'),
          )
        ),
    },
    { key: 'rtt', header: 'RTT', align: 'right', render: (r) => fmtMs(r.rttMs) },
    {
      key: 'url',
      header: t('uiLibrary.endpointTest.colUrl', 'Event url'),
      nowrap: false,
      render: (r) => <span className="break-all font-mono text-[10px]">{fmtText(r.eventUrl)}</span>,
    },
    {
      key: 'note',
      header: t('uiLibrary.endpointTest.colNote', 'Note'),
      nowrap: false,
      render: (r) => (
        <span className={TEXT_HINT}>
          {r.error ??
            (r.timedOut ? t('uiLibrary.endpointTest.timedOut', 'gathering timed out') : '')}
        </span>
      ),
    },
  ]
}

function natLabel(t: UiTextFn, kind: NatCheckResult['verdict']['kind']): string {
  switch (kind) {
    case 'endpoint-independent':
      return t('uiLibrary.endpointTest.natIndependent', 'Endpoint-independent mapping')
    case 'endpoint-dependent':
      return t('uiLibrary.endpointTest.natDependent', 'Symmetric NAT (endpoint-dependent)')
    case 'unknown':
      return t('uiLibrary.endpointTest.natUnknown', 'Unknown')
  }
}

function NatResult({ result }: { readonly result: NatCheckResult }): ReactNode {
  const t = useUiText()
  const { verdict } = result
  const variant =
    verdict.kind === 'endpoint-independent'
      ? 'success'
      : verdict.kind === 'endpoint-dependent'
        ? 'danger'
        : 'default'
  return (
    <div className={SECTION_BODY} data-testid="nat-check-result">
      <KeyValueList
        items={[
          {
            key: t('uiLibrary.endpointTest.natMapping', 'NAT mapping'),
            value: (
              <span className="flex flex-wrap items-center gap-1.5">
                <Badge variant={variant}>{natLabel(t, verdict.kind)}</Badge>
                {verdict.confidence !== 'none' && (
                  <span className={TEXT_HINT}>{verdict.confidence}</span>
                )}
              </span>
            ),
          },
          {
            key: t('uiLibrary.endpointTest.why', 'Why'),
            value: <span className="text-xs">{verdict.reason}</span>,
          },
          {
            key: t('uiLibrary.endpointTest.mappings', 'Mappings seen'),
            value: (
              <span className="font-mono text-[11px]">
                {verdict.mappings.length > 0
                  ? verdict.mappings.join(', ')
                  : t('uiLibrary.endpointTest.none', 'none')}
              </span>
            ),
          },
          {
            key: t('uiLibrary.endpointTest.stunQueried', 'STUN queried'),
            value: (
              <span className="break-all font-mono text-[11px]">
                {result.destinations.join(', ')}
              </span>
            ),
          },
          ...(result.error !== null
            ? [{ key: t('uiLibrary.endpointTest.error', 'Error'), value: result.error }]
            : []),
        ]}
      />
    </div>
  )
}

/** The per-endpoint result table — one row per tested ICE URL. */
export function EndpointResultsCard({
  rows,
}: {
  readonly rows: readonly EndpointTestRow[]
}): ReactNode {
  const t = useUiText()
  const columns = useMemo(() => buildResultColumns(t), [t])
  return (
    <SectionCard
      headingId="webrtc-diag-endpoint-results"
      title={t('uiLibrary.endpointTest.results', 'Per-endpoint results')}
      icon={Play}
    >
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        bordered={false}
        minWidthPx={760}
      />
    </SectionCard>
  )
}

/** The NAT mapping verdict for this browser. */
export function NatResultCard({ result }: { readonly result: NatCheckResult }): ReactNode {
  const t = useUiText()
  return (
    <SectionCard
      headingId="webrtc-diag-nat"
      title={t('uiLibrary.endpointTest.natTitle', 'NAT mapping (this browser)')}
      icon={Route}
    >
      <NatResult result={result} />
    </SectionCard>
  )
}

function EndpointRow({
  endpoint,
  checked,
  onToggle,
}: {
  readonly endpoint: IceEndpoint
  readonly checked: boolean
  readonly onToggle: (id: string) => void
}): ReactNode {
  const t = useUiText()
  return (
    <label
      className={`${LIST_ROW} flex cursor-pointer items-center gap-2 hover:bg-surface-hover/40`}
    >
      <Checkbox checked={checked} onChange={() => onToggle(endpoint.id)} />
      <Badge variant={SCHEME_VARIANT[endpoint.scheme]} className="shrink-0 uppercase text-[10px]">
        {endpoint.scheme}
      </Badge>
      <span className="min-w-0 flex-1 break-all font-mono text-[11px] text-foreground">
        {endpoint.url}
      </span>
      {endpoint.transport !== null && (
        <span className={`${TEXT_HINT} uppercase`}>{endpoint.transport}</span>
      )}
      {endpoint.hasCredentials && (
        <span className={`${TEXT_HINT} text-success`}>
          {t('uiLibrary.endpointTestCard.authWord', 'auth')}
        </span>
      )}
    </label>
  )
}

export function EndpointTestCard({ loadServers }: EndpointTestCardProps): ReactNode {
  const t = useUiText()
  const [endpoints, setEndpoints] = useState<readonly IceEndpoint[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [enabled, setEnabled] = useState<ReadonlySet<string>>(new Set())
  const [running, setRunning] = useState<'endpoints' | 'nat' | null>(null)
  const [rows, setRows] = useState<readonly EndpointTestRow[]>([])
  const [nat, setNat] = useState<NatCheckResult | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const flat = flattenIceServers(await loadServers())
      setEndpoints(flat)
      setEnabled(new Set(flat.map((e) => e.id)))
    } catch (err) {
      setLoadError(errorText(err))
    } finally {
      setLoading(false)
    }
  }, [loadServers])

  useEffect(() => {
    void reload()
  }, [reload])

  const selected = useMemo(
    () => (endpoints ?? []).filter((e) => enabled.has(e.id)),
    [endpoints, enabled],
  )

  const toggle = useCallback((id: string) => {
    setEnabled((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const runEndpoints = useCallback(async () => {
    setRunning('endpoints')
    setRows([])
    const out: EndpointTestRow[] = []
    for (const e of selected) {
      out.push(await testEndpoint(e))
      setRows([...out])
    }
    setRunning(null)
  }, [selected])

  const runNat = useCallback(async () => {
    setRunning('nat')
    setNat(null)
    try {
      setNat(await runNatCheck(endpoints ?? [], t))
    } finally {
      setRunning(null)
    }
  }, [endpoints, t])

  const busy = running !== null
  return (
    <div className="space-y-3 sm:space-y-4">
      <SectionCard
        headingId="webrtc-diag-ice-servers"
        title={
          endpoints !== null
            ? t('uiLibrary.endpointTest.iceCount', 'ICE servers ({{count}})', {
                count: endpoints.length,
              })
            : t('uiLibrary.endpointTest.ice', 'ICE servers')
        }
        icon={Network}
        testId="webrtc-diag-ice-servers"
        actions={
          <div className="flex flex-wrap items-center gap-1.5">
            <Button variant="ghost" onClick={() => void reload()} disabled={loading || busy}>
              {loading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
              {t('uiLibrary.endpointTest.reload', 'Reload')}
            </Button>
            <Button
              variant="outline"
              onClick={() => void runNat()}
              disabled={busy || endpoints === null}
            >
              {running === 'nat' ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Route className="h-3 w-3" />
              )}
              {t('uiLibrary.endpointTest.checkNat', 'Check NAT')}
            </Button>
            <Button onClick={() => void runEndpoints()} disabled={busy || selected.length === 0}>
              {running === 'endpoints' ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Play className="h-3 w-3" />
              )}
              {t('uiLibrary.endpointTest.testEach', 'Test each endpoint')}
            </Button>
          </div>
        }
      >
        <div className="divide-y divide-border/50">
          {loadError !== null && (
            <div className={`${LIST_ROW} text-xs text-danger`}>
              {t('uiLibrary.endpointTest.loadFailed', 'Failed to load ICE servers: {{error}}', {
                error: loadError,
              })}
            </div>
          )}
          {loadError === null && endpoints === null && (
            <div className={`${LIST_ROW} ${TEXT_HINT}`}>
              {t('uiLibrary.endpointTest.loading', 'Loading…')}
            </div>
          )}
          {endpoints !== null && endpoints.length === 0 && (
            <div className={`${LIST_ROW} ${TEXT_HINT}`}>
              {t(
                'uiLibrary.endpointTest.noServers',
                'No ICE servers configured. Add a TURN provider under TURN Servers.',
              )}
            </div>
          )}
          {(endpoints ?? []).map((e) => (
            <EndpointRow key={e.id} endpoint={e} checked={enabled.has(e.id)} onToggle={toggle} />
          ))}
        </div>
      </SectionCard>

      {rows.length > 0 && <EndpointResultsCard rows={rows} />}
      {nat !== null && <NatResultCard result={nat} />}
    </div>
  )
}
