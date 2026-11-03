/**
 * Fixture page for the stream-broker derived-stream editor. Not an admin route:
 * `ui:shots` mounts it when the path is `/ffmpeg-params-preview`. The editor is
 * a widget remote with no admin-ui route of its own, so it is rendered here with
 * an opus audio profile — the codec select of the "options nearly invisible in
 * dark mode" bug. A native popup cannot be captured, so a second, listbox-sized
 * select (`size`) paints the same options inline.
 */
import type { EncodeProfile } from '@camstack/types'
import { Select, ThemeProvider } from '@camstack/ui-library'
import { type ReactElement, useState } from 'react'
import { FfmpegParamsCore } from '../../../../packages/addon-pipeline/src/stream-broker/widgets/FfmpegParamsField'

const PROFILE: EncodeProfile = {
  video: { codec: 'h264' },
  audio: { codec: 'opus', bitrateKbps: 64, sampleRateHz: 48000, channels: 2 },
}

export function FfmpegParamsPreview(): ReactElement {
  const [value, setValue] = useState<EncodeProfile | undefined>(PROFILE)
  return (
    <ThemeProvider>
      <div className="mx-auto flex max-w-xl flex-col gap-4 bg-background p-4">
        <FfmpegParamsCore
          config={{ fieldKey: 'derived' }}
          value={value}
          onSave={setValue}
          saveStatus="idle"
        />
        <Select
          aria-label="options"
          size={5}
          defaultValue="pcmu"
          wrapperClassName="w-48"
          className="h-32"
        >
          <option value="opus">opus</option>
          <option value="aac">aac</option>
          <option value="pcmu">pcmu</option>
          <option value="pcma">pcma</option>
          <option value="copy">copy (passthrough)</option>
        </Select>
      </div>
    </ThemeProvider>
  )
}
