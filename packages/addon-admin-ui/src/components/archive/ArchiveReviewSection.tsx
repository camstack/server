/**
 * Archive camera page → Review: the player and the day timeline. The player is
 * the device page's own (`StreamPanelContent`); the timeline drives it through
 * the playback providers. The timeline opens on the latest available footage and
 * says so when the window is empty (see RecordingTimeline).
 */
import {
  DeviceContextProvider,
  PlayerOverlaysProvider,
  RecordedPlaybackProvider,
  RecordingTimeline,
  VodPlaybackProvider,
  ZoneEditingProvider,
} from '@camstack/ui-library'
import type { ReactElement } from 'react'
import { StreamPanelContent } from '../device/PanelContent'

export interface ReviewSeek {
  readonly atMs: number
  readonly nonce: number
}

export function ArchiveReviewSection({
  deviceId,
  seekTo,
  onExportRange,
}: {
  readonly deviceId: number
  readonly seekTo?: ReviewSeek
  readonly onExportRange: (fromMs: number, toMs: number) => void
}): ReactElement {
  return (
    <DeviceContextProvider deviceId={deviceId}>
      <VodPlaybackProvider>
        <RecordedPlaybackProvider>
          <PlayerOverlaysProvider>
            <ZoneEditingProvider>
              <div className="flex flex-col gap-3" data-testid="archive-review">
                <div className="mx-auto w-full max-w-4xl overflow-hidden rounded-lg border border-border bg-black">
                  <StreamPanelContent deviceId={deviceId} />
                </div>
                <RecordingTimeline
                  deviceId={deviceId}
                  seekTo={seekTo}
                  onExportRange={onExportRange}
                />
              </div>
            </ZoneEditingProvider>
          </PlayerOverlaysProvider>
        </RecordedPlaybackProvider>
      </VodPlaybackProvider>
    </DeviceContextProvider>
  )
}
