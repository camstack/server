// @vitest-environment jsdom
import './setup.js'
import { selectOption } from '@dominevo/ui-library/testing'
import { fireEvent, render, screen } from '@testing-library/react'
import type { DerivedEncodePreview, EncodeProfile } from '@dominevo/types'
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

/** Edits are a draft: nothing reaches `onSave` until the Save bar's button is pressed. */
const saveNow = (): void => {
  fireEvent.click(screen.getByRole('button', { name: /^save$/i }))
}

const saveBar = (): HTMLElement | null => screen.queryByRole('button', { name: /^save$/i })

/** Presses Save (when the bar is up), then the last profile `onSave` received. */
const lastSaved = (onSave: ReturnType<typeof vi.fn>): EncodeProfile | undefined => {
  if (saveBar() !== null) saveNow()
  return onSave.mock.calls[onSave.mock.calls.length - 1]?.[0]
}

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
      ['source codec only', { video: { codec: 'source' }, audio: 'passthrough' }, []],
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
        ['Resize', 'Video codec', 'Audio'],
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

    // Resize on: nothing to save until there is a width.
    fireEvent.click(switchFor(/^resize$/i))
    expect(saveBar()).toBeNull()
    selectOption(selectTrigger('resize-width'), '854')
    expect(lastSaved(onSave)).toEqual({
      video: { codec: 'source', width: 854 },
      audio: 'passthrough',
    })

    fireEvent.click(switchFor(/^video codec$/i))
    expect(lastSaved(onSave)?.video).toEqual({ codec: 'h264', width: 854 })

    fireEvent.click(switchFor(/^audio$/i))
    expect(lastSaved(onSave)).toEqual({
      video: { codec: 'h264', width: 854 },
      audio: { codec: 'aac' },
    })
  })

  it('resize only', () => {
    const onSave = vi.fn()
    render(<Stateful initial={undefined} onSave={onSave} />)
    fireEvent.click(switchFor(/^resize$/i))
    selectOption(selectTrigger('resize-width'), '640')
    expect(onSave).not.toHaveBeenCalled()
    expect(lastSaved(onSave)).toEqual({
      video: { codec: 'source', width: 640 },
      audio: 'passthrough',
    })
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('a custom width is possible, and only an even one is accepted', () => {
    const onSave = vi.fn()
    render(<Stateful initial={undefined} onSave={onSave} />)
    fireEvent.click(switchFor(/^resize$/i))
    selectOption(selectTrigger('resize-width'), 'custom')
    const width = screen.getByLabelText(/^width \(even\)$/i)
    fireEvent.change(width, { target: { value: '801' } })
    fireEvent.blur(width)
    expect(width).toHaveAttribute('aria-invalid', 'true')
    expect(saveBar()).toBeNull()
    fireEvent.change(width, { target: { value: '800' } })
    fireEvent.blur(width)
    expect(lastSaved(onSave)).toEqual({
      video: { codec: 'source', width: 800 },
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

  it('audio PCMU can be picked on a fresh profile', () => {
    const onSave = vi.fn()
    render(<Stateful initial={undefined} onSave={onSave} />)
    fireEvent.click(switchFor(/^audio$/i))
    selectOption(selectTrigger('audio-codec'), 'pcmu')
    expect(lastSaved(onSave)).toEqual({ video: { codec: 'copy' }, audio: { codec: 'pcmu' } })
  })

  it('switching a section off removes only its own fields', () => {
    const onSave = vi.fn()
    render(
      <Stateful
        initial={{
          video: { codec: 'h264', width: 854, fps: 10, bitrateKbps: 800 },
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
    expect(lastSaved(onSave)).toBeUndefined()
    expect(onSave).toHaveBeenCalledTimes(2)
  })

  it('every section off on a stored stream saves undefined too: passthrough is no profile', () => {
    const onSave = vi.fn()
    render(
      <Stateful initial={{ video: { codec: 'h264' }, audio: 'passthrough' }} onSave={onSave} />,
    )
    fireEvent.click(switchFor(/^video codec$/i))
    expect(lastSaved(onSave)).toBeUndefined()
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  it('a stored bare source codec opens as passthrough (codec section OFF); the next edit builds on that', () => {
    const onSave = vi.fn()
    render(
      <Stateful initial={{ video: { codec: 'source' }, audio: 'passthrough' }} onSave={onSave} />,
    )
    expect(switchFor(/^video codec$/i)).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(switchFor(/^audio$/i))
    expect(lastSaved(onSave)).toEqual({ video: { codec: 'copy' }, audio: { codec: 'aac' } })
  })

  it('has no "same as source" choice: the OFF state says it keeps the source codec', () => {
    render(
      <FfmpegParamsField
        config={{
          ...CONFIG,
          sourceParams: {
            video: { codec: 'h265', width: 2560, height: 1440 },
            audio: 'passthrough',
          },
        }}
        value={undefined}
        onSave={vi.fn()}
      />,
    )
    expect(screen.getByText(/keeps the source codec \(H\.265\)/i)).toBeInTheDocument()
    fireEvent.click(switchFor(/^video codec$/i))
    expect(screen.queryByText(/keeps the source codec/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/keep source codec|same as source/i)).not.toBeInTheDocument()
  })

  const tuned: ReadonlyArray<readonly [string, EncodeProfile['video']]> = [
    ['profile', { codec: 'h264', profile: 'baseline' }],
    ['level', { codec: 'h264', level: '3.1' }],
    ['preset', { codec: 'h264', preset: 'veryfast' }],
    ['tune', { codec: 'h264', tune: 'zerolatency' }],
    ['bf', { codec: 'h264', bf: 0 }],
  ]
  it.each(tuned)('a stored %s survives opening and a width edit', (_name, video) => {
    const onSave = vi.fn()
    render(<Stateful initial={{ video, audio: 'passthrough' }} onSave={onSave} />)
    expect(onSave).not.toHaveBeenCalled()
    fireEvent.click(switchFor(/^resize$/i))
    selectOption(selectTrigger('resize-width'), '854')
    expect(lastSaved(onSave)).toEqual({ video: { ...video, width: 854 }, audio: 'passthrough' })
  })
})

describe('edits are a draft until Save', () => {
  const stored: EncodeProfile = {
    video: { codec: 'h264', width: 1280, fps: 15 },
    audio: 'passthrough',
  }

  it('an edit raises the save bar and writes nothing', () => {
    const onSave = vi.fn()
    render(<FfmpegParamsField config={CONFIG} value={stored} onSave={onSave} />)
    expect(saveBar()).toBeNull()
    fireEvent.click(switchFor(/^audio$/i))
    expect(saveBar()).not.toBeNull()
    expect(screen.getByText(/1 unsaved change/i)).toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('Discard drops the draft and the sections go back to the stored ones', () => {
    const onSave = vi.fn()
    render(<FfmpegParamsField config={CONFIG} value={stored} onSave={onSave} />)
    fireEvent.click(switchFor(/^audio$/i))
    fireEvent.click(screen.getByRole('button', { name: /^discard$/i }))
    expect(saveBar()).toBeNull()
    expect(switchFor(/^audio$/i)).toHaveAttribute('aria-checked', 'false')
    expect(onSave).not.toHaveBeenCalled()
  })

  it('an edit changed back to the stored value is no pending change', () => {
    render(<FfmpegParamsField config={CONFIG} value={stored} onSave={vi.fn()} />)
    fireEvent.click(switchFor(/^audio$/i))
    fireEvent.click(switchFor(/^audio$/i))
    expect(saveBar()).toBeNull()
  })

  it('reports the edited profile through onEditedChange, so the plan follows the draft', () => {
    const onEditedChange = vi.fn()
    render(
      <FfmpegParamsField
        config={CONFIG}
        value={stored}
        onSave={vi.fn()}
        onEditedChange={onEditedChange}
      />,
    )
    fireEvent.click(switchFor(/^audio$/i))
    expect(onEditedChange).toHaveBeenLastCalledWith({
      video: { codec: 'h264', width: 1280, fps: 15 },
      audio: { codec: 'aac' },
    })
    fireEvent.click(screen.getByRole('button', { name: /^discard$/i }))
    expect(onEditedChange).toHaveBeenLastCalledWith(stored)
  })
})

describe('a height stored by the old editor', () => {
  const SOURCE: EncodeProfile = {
    video: { codec: 'h265', width: 2560, height: 1440 },
    audio: 'passthrough',
  }
  const legacy: EncodeProfile = {
    video: { codec: 'h264', height: 720, bitrateKbps: 777 },
    audio: 'passthrough',
  }

  it('opens as the matching width, without a pending change', () => {
    render(
      <FfmpegParamsField
        config={{ ...CONFIG, sourceParams: SOURCE }}
        value={legacy}
        onSave={vi.fn()}
      />,
    )
    expect(switchFor(/^resize$/i)).toHaveAttribute('aria-checked', 'true')
    expect(selectTrigger('resize-width')).toHaveTextContent('1280×720')
    expect(saveBar()).toBeNull()
  })

  it('saves a width on the next edit and keeps every other field', () => {
    const onSave = vi.fn()
    render(
      <FfmpegParamsField
        config={{ ...CONFIG, sourceParams: SOURCE }}
        value={legacy}
        onSave={onSave}
      />,
    )
    selectOption(selectTrigger('resize-width'), '1920')
    expect(lastSaved(onSave)).toEqual({
      video: { codec: 'h264', width: 1920, bitrateKbps: 777 },
      audio: 'passthrough',
    })
  })
})

describe('Expert', () => {
  it('is collapsed by default and holds the fields no section owns', () => {
    render(<FfmpegParamsField config={CONFIG} value={undefined} onSave={vi.fn()} />)
    expect(screen.queryByLabelText(/^bitrate/i)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /expert/i }))
    expect(screen.getByLabelText(/^bitrate/i)).toBeInTheDocument()
    // Width is owned by Resize, not repeated here.
    expect(screen.queryByLabelText(/^width/i)).not.toBeInTheDocument()
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

  it('typing 20 after selecting all is one edit on blur, saved with fps 20 by Save', () => {
    const onSave = vi.fn()
    renderField(onSave)
    const fps = screen.getByLabelText(/^fps$/i)
    fireEvent.focus(fps)
    fireEvent.change(fps, { target: { value: '2' } })
    fireEvent.change(fps, { target: { value: '20' } })
    expect(onSave).not.toHaveBeenCalled()
    fireEvent.blur(fps)
    expect(onSave).not.toHaveBeenCalled()
    saveNow()
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0]?.[0].video.fps).toBe(20)
  })

  it('Enter commits the draft', () => {
    const onSave = vi.fn()
    renderField(onSave)
    const fps = screen.getByLabelText(/^fps$/i)
    fireEvent.change(fps, { target: { value: '30' } })
    fireEvent.keyDown(fps, { key: 'Enter' })
    saveNow()
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0]?.[0].video.fps).toBe(30)
  })

  it('clearing FPS and blurring saves a profile with no fps key, the rest kept', () => {
    const onSave = vi.fn()
    renderField(onSave)
    const fps = screen.getByLabelText(/^fps$/i)
    fireEvent.change(fps, { target: { value: '' } })
    fireEvent.blur(fps)
    saveNow()
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
    expect(saveBar()).toBeNull()
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
    expect(saveBar()).toBeNull()
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

describe('a stored bare source-codec profile (the broker still re-encodes it)', () => {
  const stored: EncodeProfile = { video: { codec: 'source' }, audio: 'passthrough' }

  it('shows every section off, counts one pending change, and Save writes passthrough', () => {
    const onSave = vi.fn()
    render(<FfmpegParamsField config={CONFIG} value={stored} onSave={onSave} />)
    const on = screen
      .getAllByRole('switch')
      .filter((el) => el.getAttribute('aria-checked') === 'true')
    expect(on).toEqual([])
    expect(screen.getByText(/1 unsaved change/i)).toBeTruthy()
    expect(onSave).not.toHaveBeenCalled()
    saveNow()
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave).toHaveBeenCalledWith(undefined)
  })
})
