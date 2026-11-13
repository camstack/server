// @vitest-environment jsdom
/**
 * The IR transmitter card: unknown state is a dash, a read empty slice says
 * never, and a learn shows the code or the translated refusal.
 */
import { DeviceType } from '@camstack/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultUiText } from '../../../contexts/ui-text'
import { irFixtures } from '../__fixtures__/ir'
import { connectedCardKindOf } from '../connected/ConnectedDeviceCard'
import {
  irClientErrorCode,
  irRefusalLabel,
  irTransmitterScene,
  type IrLearnProbe,
  type IrTransmitterSceneInput,
} from '../connected/ir-transmitter-model'
import { IrTransmitterCard } from '../scenes/ir/IrTransmitterCard'
import type { IrTransmitterCardActions } from '../scenes/ir/model'

afterEach(cleanup)

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0)
const IDLE: IrLearnProbe = { pending: false, result: null, errorCode: null }

function scene(input: IrTransmitterSceneInput): ReturnType<typeof irTransmitterScene> {
  return irTransmitterScene(input)
}

describe('ir transmitter scene', () => {
  it('draws a dash when info and the slice were not read, and never the word never', () => {
    const view = scene({
      info: null,
      slice: null,
      probe: IDLE,
      readOnly: false,
      now: NOW,
      t: defaultUiText,
    })
    expect(view.headline).toBe('—')
    expect(view.readings.map((row) => row.value)).toEqual(['—', '—', '—'])
    expect(view.learned).toBeNull()
    expect(view.learnEnabled).toBe(false)
    expect(view.readings.some((row) => row.value === 'Never')).toBe(false)
  })

  it('says never only after the slice answered with nothing', () => {
    const view = scene({
      info: { media: ['ir', 'rf'], learn: true },
      slice: { lastSend: null, lastLearn: null },
      probe: IDLE,
      readOnly: false,
      now: NOW,
      t: defaultUiText,
    })
    expect(view.headline).toBe('IR, RF')
    expect(view.readings.find((row) => row.id === 'canLearn')?.value).toBe('Yes')
    expect(view.readings.find((row) => row.id === 'lastSend')?.value).toBe('Never')
    expect(view.readings.find((row) => row.id === 'lastLearn')?.value).toBe('Never')
    expect(view.learnEnabled).toBe(true)
  })

  it('names a refused send and a learned native code', () => {
    const sent = scene({
      info: { media: ['ir'], learn: true },
      slice: {
        lastSend: {
          at: NOW - 12 * 60_000,
          ok: false,
          error: 'ir-transmitter.too-long',
          medium: 'ir',
        },
        lastLearn: null,
      },
      probe: IDLE,
      readOnly: false,
      now: NOW,
      t: defaultUiText,
    })
    expect(sent.readings.find((row) => row.id === 'lastSend')?.value).toBe(
      '12 min · The command has too many pulses · IR',
    )
    expect(sent.tone).toBe('danger')
    const learned = scene({
      info: { media: ['ir'], learn: true },
      slice: { lastSend: null, lastLearn: null },
      probe: {
        pending: false,
        result: { native: { format: 'tuya', code: 'AxAA' }, timings: [16, -32], carrierHz: null },
        errorCode: null,
      },
      readOnly: false,
      now: NOW,
      t: defaultUiText,
    })
    expect(learned.learned).toBe('tuya: AxAA')
  })

  it('shows pulse count and carrier when the code has no native form, and translates a timeout', () => {
    const view = scene({
      info: { media: ['rf'], learn: false },
      slice: { lastSend: null, lastLearn: null },
      probe: {
        pending: false,
        result: { native: null, timings: [100, -200, 100], carrierHz: 433920 },
        errorCode: null,
      },
      readOnly: true,
      now: NOW,
      t: defaultUiText,
    })
    expect(view.learned).toBe('3 pulses · 433920 Hz')
    expect(view.learnEnabled).toBe(false)
    expect(irRefusalLabel('ir-transmitter.learn-timeout', defaultUiText)).toBe(
      'Nothing was learned in time',
    )
    expect(irRefusalLabel('ir-transmitter.learn-unsupported', defaultUiText)).toBe(
      'This transmitter cannot learn a code',
    )
    expect(irRefusalLabel('ir-transmitter.learn-undecodable', defaultUiText)).toBe(
      'The learned code could not be read',
    )
  })

  it('reads the code from a provider error and from a tRPC payload', () => {
    expect(irClientErrorCode({ i18nCode: 'ir-transmitter.learn-timeout' })).toBe(
      'ir-transmitter.learn-timeout',
    )
    expect(irClientErrorCode({ data: { i18n: { code: 'ir-transmitter.offline' } } })).toBe(
      'ir-transmitter.offline',
    )
    expect(irClientErrorCode(new Error('plain'))).toBeNull()
  })
})

describe('ir transmitter dispatch', () => {
  it('is the card when nothing else matched and the device binds ir-transmitter', () => {
    expect(connectedCardKindOf(DeviceType.Generic, 'ir-transmitter', ['ir-transmitter'])).toBe(
      'ir-transmitter',
    )
    expect(connectedCardKindOf(DeviceType.Generic, null, [])).toBeNull()
    expect(connectedCardKindOf(DeviceType.Switch, null, ['switch', 'ir-transmitter'])).toBe('plug')
  })
})

describe('ir transmitter fixtures', () => {
  const actions = (): IrTransmitterCardActions => ({ onLearn: vi.fn() })

  it.each(irFixtures().map((f) => [f.id, f] as const))('%s renders', (_, fixture) => {
    render(
      <IrTransmitterCard
        model={fixture.model}
        actions={actions()}
        orientation={fixture.orientation}
      />,
    )
    expect(screen.getByTestId('device-card').getAttribute('data-card-kind')).toBe('ir-transmitter')
    expect(screen.getByTestId('dc-ir-learn')).toBeTruthy()
  })

  it('runs learn from the button', () => {
    const ready = irFixtures().find((f) => f.id === 'ir-ready')
    if (ready === undefined) throw new Error('missing fixture')
    const onLearn = vi.fn()
    render(<IrTransmitterCard model={ready.model} actions={{ onLearn }} />)
    fireEvent.click(screen.getByTestId('dc-ir-learn'))
    expect(onLearn).toHaveBeenCalledOnce()
    expect(screen.getByText('12 min · Inviato · IR')).toBeTruthy()
  })

  it('shows the code the learn just read', () => {
    const learned = irFixtures().find((f) => f.id === 'ir-learned')
    if (learned === undefined) throw new Error('missing fixture')
    render(<IrTransmitterCard model={learned.model} actions={actions()} />)
    expect(screen.getByTestId('dc-ir-learned').textContent).toBe('tuya: AxAAIABAAw==')
  })
})
