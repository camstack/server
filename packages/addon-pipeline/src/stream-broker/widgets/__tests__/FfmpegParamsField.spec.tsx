// @vitest-environment jsdom
import './setup.js'
import { selectOption } from '@camstack/ui-library/testing'
import { fireEvent, render, screen } from '@testing-library/react'
import type { DerivedEncodePreview, EncodeProfile } from '@camstack/types'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { FfmpegParamsCore as FfmpegParamsField } from '../FfmpegParamsField.js'
import type { ResultView, RunningView } from '../EncodeResultPanel.js'

const CONFIG = { fieldKey: 'derived:native:main' }

/** Feeds each save back in as the new value, like the wrapper does. */
function Stateful({
  initial,
  onSave,
  result,
  running,
}: {
  readonly initial: EncodeProfile | undefined
  readonly onSave: (next: EncodeProfile | undefined) => void
  readonly result?: ResultView
  readonly running?: RunningView
}) {
  const [value, setValue] = useState(initial)
  return (
    <FfmpegParamsField
      config={CONFIG}
      value={value}
      onSave={(next) => {
        onSave(next)
        setValue(next)
      }}
      {...(result !== undefined ? { result } : {})}
      {...(running !== undefined ? { running } : {})}
    />
  )
}

const lastSaved = (onSave: ReturnType<typeof vi.fn>): EncodeProfile | undefined =>
  onSave.mock.calls[onSave.mock.calls.length - 1]?.[0]

const switchFor = (name: RegExp): HTMLElement => screen.getByRole('switch', { name })

/** A section's select trigger: the switch carries the same accessible name, so go by id. */
const selectTrigger = (suffix: string): HTMLElement => {
  const el = document.getElementById(`${CONFIG.fieldKey}-${suffix}`)
  if (el === null) throw new Error(`no select ${suffix}`)
  return el
}

const PREVIEW: DerivedEncodePreview = {
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
  args: ['-i', 'rtsp://loopback/src', '-c:v', 'libx264', '-f', 'mpegts', 'pipe:1'],
}

describe('opening never saves, and switches on exactly the sections the profile implies', () => {
  const shapes: ReadonlyArray<readonly [string, EncodeProfile | undefined, ReadonlyArray<string>]> =
    [
      ['nothing stored', undefined, []],
      ['passthrough', { video: { codec: 'copy' }, audio: 'passthrough' }, []],
      [
        'resize + h264 + aac',
        { video: { codec: 'h264', height: 480 }, audio: { codec: 'aac' } },
        ['Resize', 'Video codec', 'Audio'],
      ],
      [
        'resize only',
        { video: { codec: 'source', height: 480 }, audio: 'passthrough' },
        ['Resize'],
      ],
      ['codec only', { video: { codec: 'h265' }, audio: 'passthrough' }, ['Video codec']],
      ['source codec only', { video: { codec: 'source' }, audio: 'passthrough' }, ['Video codec']],
      [
        'tuning fields only',
        { video: { codec: 'h264', level: '3.1', tune: 'film', bf: 2 }, audio: 'passthrough' },
        ['Video codec'],
      ],
      ['audio none', { video: { codec: 'copy' }, audio: { codec: 'none' } }, ['Audio']],
      ['fps', { video: { codec: 'source', fps: 10 }, audio: 'passthrough' }, ['Frame rate']],
      [
        'expert only',
        {
          video: { codec: 'copy', bitrateKbps: 500, gopFrames: 30 },
          audio: 'passthrough',
          inputArgs: ['-re'],
          outputArgs: ['-copyts'],
        },
        [],
      ],
      [
        'a legacy audio codec',
        { video: { codec: 'h264', width: 1280 }, audio: { codec: 'pcmu', bitrateKbps: 64 } },
        ['Video codec', 'Audio'],
      ],
    ]

  it.each(shapes)('%s', (_name, profile, expectedOn) => {
    const onSave = vi.fn()
    render(<FfmpegParamsField config={CONFIG} value={profile} onSave={onSave} />)
    expect(onSave).not.toHaveBeenCalled()
    const on = screen
      .getAllByRole('switch')
      .filter((el) => el.getAttribute('aria-checked') === 'true')
      .map((el) => el.getAttribute('aria-label'))
    expect(on).toEqual(expectedOn)
  })

  it('a stored profile still does not save after the operator only looks around', () => {
    const onSave = vi.fn()
    render(
      <FfmpegParamsField
        config={CONFIG}
        value={{ video: { codec: 'h264', height: 480 }, audio: { codec: 'aac' } }}
        onSave={onSave}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /expert/i }))
    fireEvent.focus(screen.getByLabelText(/^bitrate/i))
    fireEvent.blur(screen.getByLabelText(/^bitrate/i))
    fireEvent.blur(screen.getByPlaceholderText('-thread_queue_size 1024'))
    expect(onSave).not.toHaveBeenCalled()
  })
})

describe('sections combine', () => {
  it('resize + H.264 + AAC from a never-saved stream, each switched on freely', () => {
    const onSave = vi.fn()
    render(<Stateful initial={undefined} onSave={onSave} />)

    // Resize on: nothing to save until there is a height.
    fireEvent.click(switchFor(/^resize$/i))
    expect(onSave).not.toHaveBeenCalled()
    const height = screen.getByLabelText(/^output height$/i)
    fireEvent.change(height, { target: { value: '480' } })
    fireEvent.blur(height)
    expect(lastSaved(onSave)).toEqual({
      video: { codec: 'source', height: 480 },
      audio: 'passthrough',
    })

    fireEvent.click(switchFor(/^video codec$/i))
    expect(lastSaved(onSave)?.video).toEqual({ codec: 'h264', height: 480 })

    fireEvent.click(switchFor(/^audio$/i))
    expect(lastSaved(onSave)).toEqual({
      video: { codec: 'h264', height: 480 },
      audio: { codec: 'aac' },
    })
  })

  it('resize only', () => {
    const onSave = vi.fn()
    render(<Stateful initial={undefined} onSave={onSave} />)
    fireEvent.click(switchFor(/^resize$/i))
    const height = screen.getByLabelText(/^output height$/i)
    fireEvent.change(height, { target: { value: '360' } })
    fireEvent.keyDown(height, { key: 'Enter' })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(lastSaved(onSave)).toEqual({
      video: { codec: 'source', height: 360 },
      audio: 'passthrough',
    })
  })

  it('codec only, picking H.265', () => {
    const onSave = vi.fn()
    render(<Stateful initial={undefined} onSave={onSave} />)
    fireEvent.click(switchFor(/^video codec$/i))
    selectOption(selectTrigger('video-codec'), 'h265')
    expect(lastSaved(onSave)).toEqual({ video: { codec: 'h265' }, audio: 'passthrough' })
  })

  it('audio none', () => {
    const onSave = vi.fn()
    render(<Stateful initial={undefined} onSave={onSave} />)
    fireEvent.click(switchFor(/^audio$/i))
    selectOption(selectTrigger('audio-codec'), 'none')
    expect(lastSaved(onSave)).toEqual({ video: { codec: 'copy' }, audio: { codec: 'none' } })
  })

  it('switching a section off removes only its own fields', () => {
    const onSave = vi.fn()
    render(
      <Stateful
        initial={{
          video: { codec: 'h264', height: 480, fps: 10, bitrateKbps: 800 },
          audio: { codec: 'aac', bitrateKbps: 64 },
          outputArgs: ['-copyts'],
        }}
        onSave={onSave}
      />,
    )
    fireEvent.click(switchFor(/^resize$/i))
    expect(lastSaved(onSave)).toEqual({
      video: { codec: 'h264', fps: 10, bitrateKbps: 800 },
      audio: { codec: 'aac', bitrateKbps: 64 },
      outputArgs: ['-copyts'],
    })
    fireEvent.click(switchFor(/^audio$/i))
    expect(lastSaved(onSave)?.audio).toBe('passthrough')
    expect(lastSaved(onSave)?.video).toEqual({ codec: 'h264', fps: 10, bitrateKbps: 800 })
  })

  it('every section off on a never-saved stream saves undefined', () => {
    const onSave = vi.fn()
    render(<Stateful initial={undefined} onSave={onSave} />)
    fireEvent.click(switchFor(/^video codec$/i))
    expect(lastSaved(onSave)).toEqual({ video: { codec: 'h264' }, audio: 'passthrough' })
    fireEvent.click(switchFor(/^video codec$/i))
    expect(onSave).toHaveBeenCalledTimes(2)
    expect(lastSaved(onSave)).toBeUndefined()
  })

  it('every section off on a stored stream saves undefined too: passthrough is no profile', () => {
    const onSave = vi.fn()
    render(
      <Stateful initial={{ video: { codec: 'h264' }, audio: 'passthrough' }} onSave={onSave} />,
    )
    fireEvent.click(switchFor(/^video codec$/i))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(lastSaved(onSave)).toBeUndefined()
  })

  it('a stored source codec opens with Keep source on and survives the next edit', () => {
    const onSave = vi.fn()
    render(
      <Stateful initial={{ video: { codec: 'source' }, audio: 'passthrough' }} onSave={onSave} />,
    )
    expect(switchFor(/^video codec$/i)).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(switchFor(/^audio$/i))
    expect(lastSaved(onSave)).toEqual({ video: { codec: 'source' }, audio: { codec: 'aac' } })
  })

  it('picking Keep source with nothing else on saves a source re-encode, not a copy', () => {
    const onSave = vi.fn()
    render(<Stateful initial={undefined} onSave={onSave} />)
    fireEvent.click(switchFor(/^video codec$/i))
    selectOption(selectTrigger('video-codec'), 'source')
    expect(lastSaved(onSave)).toEqual({ video: { codec: 'source' }, audio: 'passthrough' })
  })

  const tuned: ReadonlyArray<readonly [string, EncodeProfile['video']]> = [
    ['profile', { codec: 'h264', profile: 'baseline' }],
    ['level', { codec: 'h264', level: '3.1' }],
    ['preset', { codec: 'h264', preset: 'veryfast' }],
    ['tune', { codec: 'h264', tune: 'zerolatency' }],
    ['bf', { codec: 'h264', bf: 0 }],
  ]
  it.each(tuned)('a stored %s survives opening and a height edit', (_name, video) => {
    const onSave = vi.fn()
    render(<Stateful initial={{ video, audio: 'passthrough' }} onSave={onSave} />)
    expect(onSave).not.toHaveBeenCalled()
    fireEvent.click(switchFor(/^resize$/i))
    const height = screen.getByLabelText(/^output height$/i)
    fireEvent.change(height, { target: { value: '480' } })
    fireEvent.blur(height)
    expect(lastSaved(onSave)).toEqual({ video: { ...video, height: 480 }, audio: 'passthrough' })
  })
})

describe('Expert', () => {
  it('is collapsed by default and holds the fields no section owns', () => {
    render(<FfmpegParamsField config={CONFIG} value={undefined} onSave={vi.fn()} />)
    expect(screen.queryByLabelText(/^bitrate/i)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /expert/i }))
    expect(screen.getByLabelText(/^bitrate/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/^width$/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/keyframe interval/i)).toBeInTheDocument()
  })

  it('a bitrate edit keeps every section as it was', () => {
    const onSave = vi.fn()
    const stored: EncodeProfile = {
      video: { codec: 'h264', height: 480 },
      audio: { codec: 'aac' },
    }
    render(<FfmpegParamsField config={CONFIG} value={stored} onSave={onSave} />)
    fireEvent.click(screen.getByRole('button', { name: /expert/i }))
    const bitrate = screen.getByLabelText(/^bitrate/i)
    fireEvent.change(bitrate, { target: { value: '900' } })
    fireEvent.blur(bitrate)
    expect(lastSaved(onSave)).toEqual({
      video: { codec: 'h264', height: 480, bitrateKbps: 900 },
      audio: { codec: 'aac' },
    })
  })

  it('picking an output flag appends it to outputArgs and persists via onSave', () => {
    const onSave = vi.fn()
    render(
      <FfmpegParamsField
        config={CONFIG}
        value={{ video: { codec: 'h264', fps: 10 }, audio: 'passthrough' }}
        onSave={onSave}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /expert/i }))
    // The second "Add flag…" button drives the output-args picker.
    fireEvent.click(screen.getAllByText(/add flag/i)[1]!)
    fireEvent.click(screen.getByText(/^-copyts$/))
    expect(lastSaved(onSave)?.outputArgs).toEqual(expect.arrayContaining(['-copyts']))
  })
})

describe('frame rate section: draft number input', () => {
  const base: EncodeProfile = {
    video: { codec: 'h264', width: 1280, fps: 15, bitrateKbps: 2000 },
    audio: 'passthrough',
  }
  const renderField = (onSave: ReturnType<typeof vi.fn>) =>
    render(<FfmpegParamsField config={CONFIG} value={base} onSave={onSave} />)

  it('typing 20 after selecting all saves once, on blur, with fps 20', () => {
    const onSave = vi.fn()
    renderField(onSave)
    const fps = screen.getByLabelText(/^fps$/i)
    fireEvent.focus(fps)
    fireEvent.change(fps, { target: { value: '2' } })
    fireEvent.change(fps, { target: { value: '20' } })
    expect(onSave).not.toHaveBeenCalled()
    fireEvent.blur(fps)
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0]?.[0].video.fps).toBe(20)
  })

  it('Enter commits the draft', () => {
    const onSave = vi.fn()
    renderField(onSave)
    const fps = screen.getByLabelText(/^fps$/i)
    fireEvent.change(fps, { target: { value: '30' } })
    fireEvent.keyDown(fps, { key: 'Enter' })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0]?.[0].video.fps).toBe(30)
  })

  it('clearing FPS and blurring saves a profile with no fps key, the rest kept', () => {
    const onSave = vi.fn()
    renderField(onSave)
    const fps = screen.getByLabelText(/^fps$/i)
    fireEvent.change(fps, { target: { value: '' } })
    fireEvent.blur(fps)
    expect(onSave).toHaveBeenCalledTimes(1)
    const saved = onSave.mock.calls[0]?.[0]
    expect('fps' in saved.video).toBe(false)
    expect(saved.video.width).toBe(1280)
    expect(base.video.fps).toBe(15)
  })

  it('an invalid value does not save and shows the error state', () => {
    const onSave = vi.fn()
    renderField(onSave)
    const fps = screen.getByLabelText(/^fps$/i)
    fireEvent.change(fps, { target: { value: '-5' } })
    fireEvent.blur(fps)
    expect(onSave).not.toHaveBeenCalled()
    expect(fps).toHaveAttribute('aria-invalid', 'true')
  })

  it('Escape reverts the draft to the persisted value', () => {
    const onSave = vi.fn()
    renderField(onSave)
    const fps = screen.getByLabelText(/^fps$/i)
    fireEvent.change(fps, { target: { value: '99' } })
    fireEvent.keyDown(fps, { key: 'Escape' })
    expect(fps).toHaveValue(15)
    fireEvent.blur(fps)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('an empty fps field says it follows the source fps', () => {
    render(
      <FfmpegParamsField
        config={{
          ...CONFIG,
          sourceParams: { video: { codec: 'h264', fps: 25 }, audio: 'passthrough' },
        }}
        value={{ video: { codec: 'source', fps: 10 }, audio: 'passthrough' }}
        onSave={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByLabelText(/^fps$/i), { target: { value: '' } })
    expect(screen.getByLabelText(/^fps$/i)).toHaveAttribute('placeholder', 'source (25 fps)')
  })
})

describe('final result panel', () => {
  const show = (result: ResultView, running?: RunningView, value?: EncodeProfile) =>
    render(
      <FfmpegParamsField
        config={CONFIG}
        value={value}
        onSave={vi.fn()}
        result={result}
        {...(running !== undefined ? { running } : {})}
      />,
    )

  it('shows the plan: size, encoder, fps, bitrate, keyframe, audio', () => {
    show({ kind: 'ready', preview: PREVIEW })
    const panel = screen.getByTestId('encode-result')
    expect(panel).toHaveTextContent('854×480')
    expect(panel).toHaveTextContent('H264 · libx264')
    expect(panel).toHaveTextContent('20 fps')
    expect(panel).toHaveTextContent('300 kbps target · 400 kbps cap')
    expect(panel).toHaveTextContent('every 2 s')
    expect(panel).toHaveTextContent('re-encoded to AAC')
  })

  it('names a capped frame rate and a bitrate raised to the floor', () => {
    show({
      kind: 'ready',
      preview: {
        ...PREVIEW,
        fpsClampedToSource: true,
        requestedFps: 30,
        raisedToFloor: true,
        requestedKbps: 100,
      },
    })
    const panel = screen.getByTestId('encode-result')
    expect(panel).toHaveTextContent(/capped to the source: 30 fps asked, 20 fps available/i)
    expect(panel).toHaveTextContent(/raised to the floor: 100 kbps asked, 250 kbps/i)
  })

  it('says unknown values in words, never 0', () => {
    show({
      kind: 'ready',
      preview: {
        ...PREVIEW,
        width: null,
        height: null,
        fps: null,
        targetKbps: null,
        capKbps: null,
        keyframeIntervalSec: null,
        encoder: null,
      },
    })
    const panel = screen.getByTestId('encode-result')
    expect(panel).toHaveTextContent(/unknown until the source is probed/i)
    expect(panel).toHaveTextContent(/follows the source/i)
    expect(panel).toHaveTextContent(/not set/i)
    expect(panel).toHaveTextContent(/unknown encoder/i)
    expect(panel.textContent).not.toMatch(/(^|\D)0 (fps|kbps|s)\b/)
  })

  it('the ffmpeg args sit in a collapsed monospace block', () => {
    show({ kind: 'ready', preview: PREVIEW })
    expect(screen.queryByTestId('encode-result-args')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /ffmpeg arguments/i }))
    expect(screen.getByTestId('encode-result-args')).toHaveTextContent('-c:v libx264')
  })

  it('no-source says the source has not been probed yet', () => {
    show({ kind: 'no-source' })
    expect(screen.getByTestId('encode-result')).toHaveTextContent(/source has not been probed yet/i)
  })

  it('an error says the result is unavailable, not that there is no source', () => {
    show({ kind: 'unavailable' })
    const panel = screen.getByTestId('encode-result')
    expect(panel).toHaveTextContent(/not available right now/i)
    expect(panel).not.toHaveTextContent(/probed/i)
  })

  it('a running encode that matches the plan is just a badge', () => {
    show({ kind: 'ready', preview: PREVIEW }, { kind: 'running', encode: PREVIEW })
    const panel = screen.getByTestId('encode-result')
    expect(panel).toHaveTextContent(/^.*Running/)
    expect(panel).not.toHaveTextContent(/applies? at the next start/i)
  })

  it('a running encode that differs says what runs now', () => {
    show(
      { kind: 'ready', preview: PREVIEW },
      { kind: 'running', encode: { ...PREVIEW, fps: 10, targetKbps: 150 } },
    )
    expect(screen.getByTestId('encode-result')).toHaveTextContent(
      /running now: libx264 · 10 fps · 150 kbps/i,
    )
  })

  it('an idle stream is badged not running; an unanswered stats query shows no badge', () => {
    const { unmount } = show({ kind: 'ready', preview: PREVIEW }, { kind: 'idle' })
    expect(screen.getByTestId('encode-result')).toHaveTextContent(/not running/i)
    unmount()
    show({ kind: 'ready', preview: PREVIEW }, { kind: 'pending' })
    expect(screen.getByTestId('encode-result')).not.toHaveTextContent(/not running/i)
  })
})

describe('argsOnly mode (source-stream normalization)', () => {
  it('hides the sections and the result, rendering only the two args editors', () => {
    render(
      <FfmpegParamsField
        config={{ fieldKey: 'sourceParserArgs:native:main', argsOnly: true }}
        value={undefined}
        onSave={vi.fn()}
      />,
    )
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()
    expect(screen.queryByTestId('encode-result')).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText('-thread_queue_size 1024')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('-bsf:v h264_mp4toannexb')).toBeInTheDocument()
    expect(screen.getAllByText(/add flag/i)).toHaveLength(2)
  })

  it('picking a Timestamps input flag persists it to inputArgs via onSave', () => {
    const onSave = vi.fn()
    render(
      <FfmpegParamsField
        config={{ fieldKey: 'sourceParserArgs:native:main', argsOnly: true }}
        value={undefined}
        onSave={onSave}
      />,
    )
    fireEvent.click(screen.getAllByText(/add flag/i)[0]!)
    fireEvent.click(screen.getByText(/^-use_wallclock_as_timestamps 1$/))
    // Each picked flag becomes ONE textarea line (tokens space-joined).
    expect(lastSaved(onSave)?.inputArgs).toEqual(
      expect.arrayContaining(['-use_wallclock_as_timestamps 1']),
    )
  })
})

it('renders "Source (probed)" read-only card when sourceParams is supplied', () => {
  render(
    <FfmpegParamsField
      config={{
        ...CONFIG,
        sourceParams: {
          video: { codec: 'h265', width: 2560, height: 1920, fps: 20, bitrateKbps: 4500 },
          audio: { codec: 'aac', bitrateKbps: 64, sampleRateHz: 16000, channels: 1 },
        },
      }}
      value={undefined}
      onSave={vi.fn()}
    />,
  )
  expect(screen.getByText(/2560×1920/)).toBeInTheDocument()
  expect(screen.getByText(/aac/i)).toBeInTheDocument()
})
