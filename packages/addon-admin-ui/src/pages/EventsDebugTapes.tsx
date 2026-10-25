/**
 * Events → Debug → Tracking tapes (D681, spec §4.5): the admin fallback for
 * the track history. Per-camera recording state and cost (`debug.tape.status`
 * — a switched-off camera says Off, and a camera whose switch itself could
 * not be read says Unknown, never a guessed Off), promotion of a window from
 * the last 24 h, the promoted list (download, release, delete), and a review
 * view with one lane per live track where the operator marks identity through
 * the SAME body the viewer's cap methods use (`debug.gt.*`).
 *
 * The recording switch is NOT here: it is the camera's Tracking setting
 * `trackingTape` (D62 — one authority). Collapsed by default, and asks
 * nothing until opened — `<CollapsibleCard>` only mounts its `children` while
 * `expanded`, so the body's queries never fire behind a closed section.
 *
 * Release and delete answer a `status` union, never a bare success (Task 12
 * fix round): `already-released`, `not-found`, `pins-owed` and `unavailable`
 * are shown by name, and both destructive actions go through the shared
 * `ConfirmActionButton` two-step confirm rather than a native `confirm()`.
 *
 * The promote form (`EventsDebugTapesPromoteForm.tsx`) and the review view
 * (`EventsDebugTapesReview.tsx`) live in sibling files (Task 24 fix round 1)
 * — this file kept them inline until then, but the three together were
 * pushing past the "typical" file-size guideline. The promotion camera
 * picker offers every camera `promotableCameras` names, regardless of its
 * CURRENT switch state: a camera switched off after capturing a scenario
 * must still be promotable, since `debug.tape.promote` only needs a segment
 * covering the window, not an armed switch.
 */
import {
  Badge,
  Button,
  CollapsibleCard,
  ConfirmActionButton,
  ErrorBox,
  useDeviceManagerListAll,
  useSystem,
} from '@camstack/ui-library'
import { useQuery } from '@tanstack/react-query'
import { Download, Trash2, Unlock } from 'lucide-react'
import { type JSX, useMemo, useState } from 'react'
import { PromoteForm } from './EventsDebugTapesPromoteForm'
import { TapeReview } from './EventsDebugTapesReview'
import { DEBUG_ADDON_ID, formatDuration } from './events-debug.helpers'
import {
  type CallAction,
  countOrUnknown,
  errorText,
  formatBytesOrUnknown,
  parseTapeDelete,
  parseTapeList,
  parseTapeRelease,
  parseTapeStatus,
  promotableCameras,
  statusLabel,
  TAPE_ACTIONS,
  type TapeListItem,
  tapeExportErrorText,
  tapeExportUrl,
  tapeOperationMessage,
  UNREADABLE,
} from './events-debug-tapes.helpers'
import { Trans, useTranslation } from 'react-i18next'

const ADMIN_TOKEN_STORAGE_KEY = 'camstack_admin_token'

function useCallAction(): CallAction {
  const system = useSystem()
  return (action, input) =>
    system.trpcClient.addons.custom.mutate({ addonId: DEBUG_ADDON_ID, action, input })
}

/**
 * Fetches the promoted bundle through the auth-gated data plane and hands it
 * to the browser as a save. Not `authedDownload` (`lib/authed-media.ts`): the
 * export plane names three distinct refusals by HTTP status (404 `unknown`,
 * 503 `unavailable`, 500 `read-failed` — spec / Task 17), each with its own
 * text body, and the shared helper's generic `download failed: <status>`
 * would fold all three into one unnamed failure.
 */
async function downloadTapeExport(tapeId: string, fallbackName: string): Promise<void> {
  const token = localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY)
  const headers: Record<string, string> = {}
  if (token !== null) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(tapeExportUrl(tapeId), { headers })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(tapeExportErrorText(res.status, body))
  }
  const blob = await res.blob()
  const disposition = res.headers.get('content-disposition')
  const match = disposition === null ? null : /filename="?([^";]+)"?/i.exec(disposition)
  const name = match?.[1]?.trim() ?? fallbackName
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000)
}

export function EventsDebugTapes(): JSX.Element {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  return (
    <CollapsibleCard
      expanded={expanded}
      onExpandedChange={setExpanded}
      header={
        <span className="text-sm font-medium text-foreground">
          {t('eventsDebugTapes.trackingTapes', 'Tracking tapes')}
        </span>
      }
    >
      <TapesBody />
    </CollapsibleCard>
  )
}

function TapesBody(): JSX.Element {
  const { t } = useTranslation()
  const call = useCallAction()
  const devices = useDeviceManagerListAll({ isCamera: true, projection: 'slim' })
  const cameraName = useMemo(() => {
    const map = new Map<number, string>()
    for (const d of devices.data ?? []) map.set(d.id, d.name)
    return (id: number): string => map.get(id) ?? t('cameraLoad.deviceLabel', { deviceId: id })
  }, [devices.data, t])
  const status = useQuery({
    queryKey: ['events-debug', 'tapes', 'status'],
    queryFn: async () => parseTapeStatus(await call(TAPE_ACTIONS.status, {})),
  })
  const list = useQuery({
    queryKey: ['events-debug', 'tapes', 'list'],
    queryFn: async () => parseTapeList(await call(TAPE_ACTIONS.list, {})),
  })
  const [reviewing, setReviewing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const download = async (tape: TapeListItem): Promise<void> => {
    setError(null)
    try {
      await downloadTapeExport(tape.id, `${tape.scenario}.tape-bundle.json.gz`)
    } catch (err: unknown) {
      setError(errorText(err))
    }
  }

  const release = async (tape: TapeListItem): Promise<void> => {
    const raw = await call(TAPE_ACTIONS.release, { tapeId: tape.id })
    const outcome = parseTapeRelease(raw)
    if (outcome === null) throw new Error(UNREADABLE)
    const message = tapeOperationMessage(outcome)
    if (message !== null) throw new Error(message)
    await list.refetch()
  }

  const remove = async (tape: TapeListItem): Promise<void> => {
    const raw = await call(TAPE_ACTIONS.remove, { tapeId: tape.id })
    const outcome = parseTapeDelete(raw)
    if (outcome === null) throw new Error(UNREADABLE)
    const message = tapeOperationMessage(outcome)
    if (message !== null) throw new Error(message)
    await list.refetch()
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-foreground-subtle">
        <Trans i18nKey="eventsDebugTapes.intro" components={{ b: <strong />, code: <code /> }} />
      </p>
      {error !== null && <ErrorBox message={error} />}
      {status.isLoading && (
        <p className="text-xs text-foreground-subtle">
          {t('eventsDebugTapes.loadingCameraStatus', 'Loading camera status…')}
        </p>
      )}
      {status.data === null && <ErrorBox message={UNREADABLE} />}

      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-foreground-subtle">
            <th>{t('eventsDebugTapes.camera', 'Camera')}</th>
            <th>{t('eventsDebugTapes.state', 'State')}</th>
            <th>{t('eventsDebugTapes.framesMin', 'Frames/min')}</th>
            <th>{t('eventsDebugTapes.lastHour', 'Last hour')}</th>
            <th>{t('eventsDebugTapes.held', 'Held')}</th>
            <th>{t('eventsDebugTapes.gaps', 'Gaps')}</th>
          </tr>
        </thead>
        <tbody>
          {(status.data ?? []).map((row) => (
            <tr key={row.deviceId}>
              <td>{cameraName(row.deviceId)}</td>
              <td>
                <Badge
                  variant={
                    row.state === 'recording'
                      ? 'success'
                      : row.state === 'off'
                        ? 'default'
                        : row.state === 'unknown'
                          ? 'warning'
                          : 'danger'
                  }
                >
                  {statusLabel(row)}
                </Badge>
              </td>
              <td>{row.framesPerMin === undefined ? '—' : String(Math.round(row.framesPerMin))}</td>
              <td title={row.shelfError}>{formatBytesOrUnknown(row.bytesLastHour)}</td>
              <td title={row.shelfError}>
                {t('eventsDebugTapes.segsHeld', {
                  count: countOrUnknown(row.segmentsHeld),
                  size: formatBytesOrUnknown(row.bytesHeld),
                })}
              </td>
              <td>{String(row.gapsSinceArmed)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <PromoteForm
        cameras={promotableCameras(status.data ?? []).map((c) => ({
          value: String(c.deviceId),
          label: c.segmentsUnknown
            ? t('eventsDebugTapes.segmentsUnknown', '{{value1}} (segments unknown)', {
                value1: cameraName(c.deviceId),
              })
            : cameraName(c.deviceId),
        }))}
        call={call}
        onPromoted={() => void list.refetch()}
      />

      {list.isLoading && (
        <p className="text-xs text-foreground-subtle">
          {t('eventsDebugTapes.loadingPromotedTapes', 'Loading promoted tapes…')}
        </p>
      )}
      {list.data === null && <ErrorBox message={UNREADABLE} />}

      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-foreground-subtle">
            <th>{t('eventsDebugTapes.scenario', 'Scenario')}</th>
            <th>{t('eventsDebugTapes.camera', 'Camera')}</th>
            <th>{t('eventsDebugTapes.window', 'Window')}</th>
            <th>{t('eventsDebugTapes.state', 'State')}</th>
            <th>{t('eventsDebugTapes.tracks', 'Tracks')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(list.data ?? []).map((tape) => (
            <tr key={tape.id}>
              <td>{tape.scenario}</td>
              <td>{cameraName(tape.deviceId)}</td>
              <td>
                {new Date(tape.fromMs).toLocaleString()} · {formatDuration(tape.toMs - tape.fromMs)}{' '}
                · {tape.lighting}
              </td>
              <td>
                <Badge variant={tape.state === 'complete' ? 'success' : 'warning'}>
                  {tape.state}
                </Badge>{' '}
                {tape.reviewed && <Badge variant="info">{t('eventsDebugTapes.reviewed')}</Badge>}{' '}
                {tape.released && <Badge>{t('eventsDebugTapes.released')}</Badge>}
              </td>
              <td>
                {t('eventsDebugTapes.storedOf', {
                  stored: String(tape.tracksStillStored),
                  total: String(tape.tracks.length),
                })}
              </td>
              <td className="space-x-1 text-right">
                <Button
                  variant="secondary"
                  aria-label={t('eventsDebugTapes.review', 'Review {{scenario}}', {
                    scenario: tape.scenario,
                  })}
                  onClick={() => setReviewing(tape.id)}
                >
                  {t('eventsDebugTapes.review2', 'Review')}
                </Button>
                <Button
                  variant="ghost"
                  aria-label={t('eventsDebugTapes.download', 'Download {{scenario}}', {
                    scenario: tape.scenario,
                  })}
                  onClick={() => void download(tape)}
                >
                  <Download className="h-3.5 w-3.5" />
                </Button>
                <ConfirmActionButton
                  label={t('eventsDebugTapes.release', 'Release')}
                  icon={Unlock}
                  title={t('eventsDebugTapes.release2', 'Release {{scenario}}?', {
                    scenario: tape.scenario,
                  })}
                  description={t(
                    'eventsDebugTapes.releasingReturnsThisTapeS',
                    "Releasing returns this tape's pinned tracks to ordinary retention — they can be pruned from then on. The promoted bundle itself is kept until deleted.",
                  )}
                  confirmLabel={t('eventsDebugTapes.release', 'Release')}
                  triggerVariant="ghost"
                  confirmVariant="danger"
                  disabled={tape.released}
                  action={() => release(tape)}
                />
                <ConfirmActionButton
                  label={t('common.delete', 'Delete')}
                  icon={Trash2}
                  title={t('eventsDebugTapes.delete', 'Delete {{scenario}}?', {
                    scenario: tape.scenario,
                  })}
                  description={t(
                    'eventsDebugTapes.deletingRemovesThePromotedBundle',
                    "Deleting removes the promoted bundle and its index row for good. Its tracks' pins are released first — this cannot be undone.",
                  )}
                  confirmLabel={t('common.delete', 'Delete')}
                  triggerVariant="ghost"
                  confirmVariant="danger"
                  action={() => remove(tape)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {reviewing !== null && (
        <TapeReview
          tapeId={reviewing}
          call={call}
          onClose={() => setReviewing(null)}
          onChanged={() => void list.refetch()}
        />
      )}
    </div>
  )
}
