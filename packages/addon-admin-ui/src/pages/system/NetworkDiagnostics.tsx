/**
 * Administration → Network → Diagnostics: WebRTC reachability from THIS
 * browser (desktop or phone).
 *
 *  - ICE servers: the live ICE server list, each endpoint probed on its own
 *    (srflx mapping, relay allocation, relay protocol, relay loopback RTT),
 *    plus the NAT mapping check.
 *  - Hub session test: a real live session to the hub through the viewer's
 *    player, once with every candidate type and once TURN-only, read from
 *    both ends (the browser's stats and the hub's `getSessionDebug`).
 *
 * The probes and the report live in `@camstack/ui-library`
 * (`composites/webrtc-diagnostics/`) so the viewer embed can host the same
 * test; this page only supplies the hub client and the camera picker.
 */
import {
  EndpointTestCard,
  HubSessionTestCard,
  type IceServerEntry,
  Select,
  STACK_GAP,
  useDeviceManagerListAll,
  useSystem,
} from '@camstack/ui-library'
import { type ReactNode, useCallback, useMemo, useState } from 'react'
import { AdminPage } from '../../components/AdminPage'
import { hubOrigin } from '../../lib/mount'
import { useTranslation } from 'react-i18next'

function CameraField({
  value,
  onChange,
}: {
  readonly value: number | null
  readonly onChange: (id: number | null) => void
}): ReactNode {
  const { t } = useTranslation()
  const { data: cameras } = useDeviceManagerListAll({ isCamera: true, projection: 'slim' })
  const options = useMemo(() => {
    // Not answered yet is not "no cameras" (D315).
    if (cameras === undefined)
      return [
        { value: '', label: t('system.networkDiagnostics.loadingCameras', 'Loading cameras…') },
      ]
    if (cameras.length === 0)
      return [{ value: '', label: t('system.networkDiagnostics.noCameras', 'No cameras') }]
    return [
      { value: '', label: t('system.networkDiagnostics.pickACamera', 'Pick a camera') },
      ...cameras
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .map((c) => ({ value: String(c.id), label: `${c.name} (#${String(c.id)})` })),
    ]
  }, [cameras, t])
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] text-foreground-subtle">
        {t('system.networkDiagnostics.camera', 'Camera')}
      </span>
      <Select
        value={value === null ? '' : String(value)}
        disabled={cameras === undefined || cameras.length === 0}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        options={options}
      />
    </label>
  )
}

export function NetworkDiagnosticsPage(): ReactNode {
  const system = useSystem()
  const [deviceId, setDeviceId] = useState<number | null>(null)
  const loadServers = useCallback(
    async (): Promise<readonly IceServerEntry[]> =>
      system.trpcClient.turnProvider.getTurnServers.query(),
    [system],
  )
  return (
    <AdminPage embedded>
      <div className={STACK_GAP} data-testid="network-diagnostics">
        <EndpointTestCard loadServers={loadServers} />
        <HubSessionTestCard
          trpc={system.trpcClient}
          serverUrl={hubOrigin()}
          deviceId={deviceId}
          cameraField={<CameraField value={deviceId} onChange={setDeviceId} />}
        />
      </div>
    </AdminPage>
  )
}
