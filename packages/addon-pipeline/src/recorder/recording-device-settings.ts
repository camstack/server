/**
 * Per-device recording contribution for the `recording` cap: a single top-tab
 * section that mounts the `host/recording-panel` widget. The widget now owns
 * ALL recording settings (enable / profiles / segment / rules / retention) and
 * playback natively, reading/writing via the `recording.getDeviceConfig` /
 * `setDeviceConfig` cap methods — so no schema-driven settings fields remain here.
 */
import type { ConfigUISchema } from '@camstack/types'

export function buildRecordingDeviceSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'recording-playback',
        tab: 'recording',
        location: 'top-tab',
        title: 'Recording',
        order: 10,
        fields: [
          {
            type: 'widget' as const,
            key: '_recordingPanel',
            label: '',
            widgetId: 'host/recording-panel',
          },
        ],
      },
    ],
  }
}
