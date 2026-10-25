/**
 * Widget bundle entry — built into `dist/widgets.mjs` by
 * `vite.widgets.config.ts`. The default export is the `Record<stableId,
 * Component>` map the host's `WidgetRegistry` consumes.
 *
 * One bundle per addon; one entry per `addon-widgets-source` widget the
 * addon contributes.
 */
import { FfmpegParamsField } from './FfmpegParamsField'
import { StreamBrokerPanel } from './StreamBrokerPanel'

export default {
  'stream-broker-panel': StreamBrokerPanel,
  'ffmpeg-params': FfmpegParamsField,
}
