// @vitest-environment jsdom
import './setup.js'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FfmpegParamsCore as FfmpegParamsField } from '../FfmpegParamsField.js'

describe('FfmpegParamsField', () => {
  it('renders the always-editable transform editor (Video + Audio panels)', () => {
    render(
      <FfmpegParamsField
        config={{ fieldKey: 'derived:native:main' }}
        value={undefined}
        onSave={vi.fn()}
      />,
    )
    // Codec selectors are always present — there is no preset gate.
    expect(screen.getByLabelText(/^codec$/i)).toBeInTheDocument()
  })

  it('editing video.codec calls onSave with the updated profile', () => {
    const onSave = vi.fn()
    render(
      <FfmpegParamsField
        config={{ fieldKey: 'derived:native:main' }}
        value={{ video: { codec: 'copy' }, audio: 'passthrough' }}
        onSave={onSave}
      />,
    )
    const codecSelect = screen.getByLabelText(/^codec$/i)
    fireEvent.change(codecSelect, { target: { value: 'h265' } })
    const lastCall = onSave.mock.calls[onSave.mock.calls.length - 1]
    expect(lastCall).toBeDefined()
    const savedProfile = lastCall?.[0]
    expect(savedProfile?.video?.codec).toBe('h265')
  })

  it('picking an output flag appends it to outputArgs and persists via onSave', () => {
    const onSave = vi.fn()
    render(
      <FfmpegParamsField
        config={{ fieldKey: 'derived:native:main' }}
        value={undefined}
        onSave={onSave}
      />,
    )
    // Open the Advanced section
    fireEvent.click(screen.getByText(/Advanced/i))
    // The second "Add flag…" button drives the output-args picker.
    const pickerBtns = screen.getAllByText(/add flag/i)
    fireEvent.click(pickerBtns[1]!)
    // Pick the -copyts flag (a known output catalogue entry)
    fireEvent.click(screen.getByText(/^-copyts$/))
    const lastCall = onSave.mock.calls[onSave.mock.calls.length - 1]
    expect(lastCall).toBeDefined()
    const savedProfile = lastCall?.[0]
    expect(savedProfile?.outputArgs).toEqual(expect.arrayContaining(['-copyts']))
  })

  describe('argsOnly mode (source-stream normalization)', () => {
    it('hides the codec/geometry/audio controls and renders only the two args editors', () => {
      render(
        <FfmpegParamsField
          config={{ fieldKey: 'sourceParserArgs:native:main', argsOnly: true }}
          value={undefined}
          onSave={vi.fn()}
        />,
      )
      // Transcode controls are hidden entirely — no codec/width selectors.
      expect(screen.queryByLabelText(/^codec$/i)).not.toBeInTheDocument()
      expect(screen.queryByLabelText(/^width$/i)).not.toBeInTheDocument()
      // Both raw-args textareas ARE rendered (always visible, no Advanced gate).
      expect(screen.getByPlaceholderText('-thread_queue_size 1024')).toBeInTheDocument()
      expect(screen.getByPlaceholderText('-bsf:v h264_mp4toannexb')).toBeInTheDocument()
      // Both "Add flag…" pickers ARE rendered.
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
      // First "Add flag…" button drives the input-args picker.
      const pickerBtns = screen.getAllByText(/add flag/i)
      fireEvent.click(pickerBtns[0]!)
      fireEvent.click(screen.getByText(/^-use_wallclock_as_timestamps 1$/))
      const lastCall = onSave.mock.calls[onSave.mock.calls.length - 1]
      const savedProfile = lastCall?.[0]
      // Each picked flag becomes ONE textarea line (tokens space-joined); the
      // downstream args-builder tokenizes it — so the stored element is the
      // whole line, not pre-split tokens.
      expect(savedProfile?.inputArgs).toEqual(
        expect.arrayContaining(['-use_wallclock_as_timestamps 1']),
      )
    })
  })

  it('renders "Source (probed)" read-only card when sourceParams is supplied', () => {
    render(
      <FfmpegParamsField
        config={{
          fieldKey: 'derived:native:main',
          sourceParams: {
            video: { codec: 'h265', width: 2560, height: 1920, fps: 20, bitrateKbps: 4500 },
            audio: { codec: 'aac', bitrateKbps: 64, sampleRateHz: 16000, channels: 1 },
          },
        }}
        value={undefined}
        onSave={vi.fn()}
      />,
    )
    // The probed card is a separate section — its readouts MUST appear
    // even when no override is configured. We assert on the resolution
    // chip ("2560×1920") and the audio codec chip ("aac") — both are
    // unique to the card (the value-undefined editor shows copy/passthrough
    // and renders no audio codec <select>, so "aac" can't collide).
    expect(screen.getByText(/2560×1920/)).toBeInTheDocument()
    expect(screen.getByText(/aac/i)).toBeInTheDocument()
  })
})
