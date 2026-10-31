/**
 * CameraRecordingSettingsSection — per-camera recording + retention settings
 * managed FROM the Recordings page (operator ask, 2026-07-29: one place with
 * everything together).
 *
 * A camera picker over the same aggregate-driven sections the device-detail
 * `Recording` top-tab renders (`tab: 'recording'`: the recorder's panel +
 * bands + the unified retention section re-homed there by pipeline-analytics).
 * Zero bespoke forms — the aggregate is the single source of truth, so a new
 * contributed section shows up here for free (D14).
 *
 * ## Why this tab is not split by domain like the rest of the page
 *
 * The sections filtered here are `tab: 'recording'`, and one of them —
 * `retention` — is contributed by `pipeline-analytics` and governs footage AND
 * analytics together (`retagRetentionSection`, "footage and analytics
 * retention are ONE unified policy since the follow-recordings default").
 * Splitting the panel to give Events its own copy would invent a second knob
 * over one authority, which is the failure this page's domain split exists to
 * avoid. The heading names the scope instead.
 */

import {
  DeviceContextProvider,
  EmptyState,
  useDeviceManagerListAll,
  Select,
} from '@camstack/ui-library'
import { Camera } from 'lucide-react'
import { useMemo, useState } from 'react'
import { DeviceAggregateSection } from '../device/tabs/DeviceAggregateSection'
import { useTranslation } from 'react-i18next'

export function CameraRecordingSettingsSection() {
  const { t } = useTranslation()
  // Cameras only, filtered server-side, slim, and the query client's fleet window (D274) so
  // this shares one fetch with the other recordings-page sections.
  const devicesQuery = useDeviceManagerListAll({ isCamera: true, projection: 'slim' })
  const cameras = useMemo(
    () => (devicesQuery.data ?? []).toSorted((a, b) => a.name.localeCompare(b.name)),
    [devicesQuery.data],
  )
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const deviceId = selectedId ?? cameras[0]?.id ?? null

  if (!devicesQuery.isLoading && cameras.length === 0) {
    return (
      <EmptyState
        icon={Camera}
        title={t('recordings.cameraRecordingSettingsSection.noCameras', 'No cameras')}
        description={t(
          'recordings.cameraRecordingSettingsSection.addACameraFirst',
          'Add a camera first.',
        )}
      />
    )
  }

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-foreground">
          {t(
            'recordings.cameraRecordingSettingsSection.perCameraRecordingRetention',
            'Per-camera recording & retention',
          )}
        </h2>
        <p className="mt-1 text-[11px] text-foreground-subtle">
          {t(
            'recordings.cameraRecordingSettingsSection.recordingModeScheduleBandsAnd',
            "Recording mode, schedule bands and the retention policy for one camera — the same controls as the camera's own Recording tab. Retention is one policy over footage and analytics; per-camera event deletion lives on the Events tab.",
          )}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <label className="text-[10px] uppercase tracking-wide text-foreground-subtle">
          {t('recordings.cameraRecordingSettingsSection.camera', 'Camera')}
        </label>
        <Select
          wrapperClassName="inline-block w-auto"
          value={deviceId ?? ''}
          onChange={(e) => setSelectedId(Number(e.target.value))}
        >
          {cameras.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </div>
      {deviceId !== null && (
        // The recording panel widget resolves its device from DeviceContext
        // (not props) — same wrapping DeviceDetail applies around sections.
        <DeviceContextProvider key={deviceId} deviceId={deviceId}>
          <DeviceAggregateSection
            deviceId={deviceId}
            sectionFilter={(s) => s.location === 'top-tab' && s.tab === 'recording'}
          />
        </DeviceContextProvider>
      )}
    </div>
  )
}
