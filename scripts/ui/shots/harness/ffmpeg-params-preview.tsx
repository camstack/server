/**
 * Fixture page for the stream-broker derived-stream editor. Not an admin route:
 * `ui:shots` mounts it when the path is `/ffmpeg-params-preview`. The editor is
 * a widget remote with no admin-ui route of its own, so it is rendered here
 * against fixture profiles and a fixture "Final result" (the server computes it
 * in production). `?scene=` picks one; no param keeps the original opus profile,
 * the before/after baseline. A native popup cannot be captured, so a second,
 * listbox-sized select (`size`) paints the same options inline.
 */
import type { DerivedEncodePreview, EncodeProfile } from '@dominevo/types'
import { Select, ThemeProvider } from '@dominevo/ui-library'
import { type ReactElement, useEffect, useRef, useState } from 'react'
import type {
  ResultView,
  RunningView,
} from '../../../../packages/addon-pipeline/src/stream-broker/widgets/EncodeResultPanel'
import { FfmpegParamsCore } from '../../../../packages/addon-pipeline/src/stream-broker/widgets/FfmpegParamsField'

const PROFILE: EncodeProfile = {
  video: { codec: 'h264' },
  audio: { codec: 'opus', bitrateKbps: 64, sampleRateHz: 48000, channels: 2 },
}

const PLAN: DerivedEncodePreview = {
  encoder: 'libx264',
  fps: 20,
  gopFrames: 40,
  targetKbps: 300,
  capKbps: 400,
  bufsizeKbps: 800,
  audio: 'aac',
  width: 854,
  height: 480,
  videoCodec: 'h264',
  requestedFps: null,
  fpsClampedToSource: false,
  floorKbps: 250,
  raisedToFloor: false,
  requestedKbps: null,
  keyframeIntervalSec: 2,
  args: [
    '-i',
    'rtsp://camera.example.com/main',
    '-vf',
    'scale=-2:480',
    '-c:v',
    'libx264',
    '-c:a',
    'aac',
    '-f',
    'mpegts',
    'pipe:1',
  ],
}

interface Scene {
  readonly value: EncodeProfile | undefined
  readonly result: ResultView
  readonly running: RunningView
  readonly expertOpen?: boolean
}

const SCENES: Readonly<Record<string, Scene>> = {
  combo: {
    value: { video: { codec: 'h264', height: 480 }, audio: { codec: 'aac' } },
    result: { kind: 'ready', preview: PLAN },
    running: { kind: 'idle' },
  },
  expert: {
    value: {
      video: { codec: 'h264', height: 360, fps: 30, bitrateKbps: 100, gopFrames: 30 },
      audio: 'passthrough',
      outputArgs: ['-copyts'],
    },
    result: {
      kind: 'ready',
      preview: {
        ...PLAN,
        height: 360,
        width: 640,
        fps: 20,
        requestedFps: 30,
        fpsClampedToSource: true,
        targetKbps: 250,
        requestedKbps: 100,
        raisedToFloor: true,
        audio: 'passthrough',
      },
    },
    running: { kind: 'running', encode: PLAN },
    expertOpen: true,
  },
  nosource: {
    value: { video: { codec: 'h265', height: 720 }, audio: 'passthrough' },
    result: { kind: 'no-source' },
    running: { kind: 'idle' },
  },
}

export function FfmpegParamsPreview(): ReactElement {
  const sceneName = new URLSearchParams(window.location.search).get('scene')
  const scene: Scene = (sceneName !== null ? SCENES[sceneName] : undefined) ?? {
    value: PROFILE,
    result: { kind: 'ready', preview: { ...PLAN, audio: 'opus' } },
    running: { kind: 'idle' },
  }
  const [value, setValue] = useState<EncodeProfile | undefined>(scene.value)
  const frame = useRef<HTMLDivElement>(null)
  // The Expert section is collapsed on open; the `expert` scene opens it the way an operator does.
  useEffect(() => {
    if (scene.expertOpen !== true) return
    const toggle = Array.from(frame.current?.querySelectorAll('button') ?? []).find((b) =>
      /expert/i.test(b.textContent ?? ''),
    )
    toggle?.click()
  }, [scene.expertOpen])
  return (
    <ThemeProvider>
      <div ref={frame} className="mx-auto flex max-w-xl flex-col gap-4 bg-background p-4">
        <FfmpegParamsCore
          config={{
            fieldKey: 'derived',
            sourceParams: {
              video: { codec: 'h265', width: 2560, height: 1440, fps: 20 },
              audio: 'passthrough',
            },
          }}
          value={value}
          onSave={setValue}
          saveStatus="idle"
          result={scene.result}
          running={scene.running}
        />
        {sceneName === null ? (
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
        ) : null}
      </div>
    </ThemeProvider>
  )
}
