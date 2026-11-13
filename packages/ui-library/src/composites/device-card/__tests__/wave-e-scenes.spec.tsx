// @vitest-environment jsdom
/**
 * The Wave-E scenes and their pure models: button, update, script,
 * automation, control, event, image, notifier and gateway. Which card a type
 * resolves to, what each draws from its model, which command each control
 * sends, and every mockup fixture rendering through the shell.
 */
import { DeviceType, type EventEmitterStatus } from '@camstack/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultUiText } from '../../../contexts/ui-text'
import {
  automationFixtures,
  buttonFixtures,
  controlFixtures,
  eventFixtures,
  gatewayFixtures,
  imageFixtures,
  notifierFixtures,
  scriptFixtures,
  updateFixtures,
  type WaveEFixture,
} from '../__fixtures__/wave-e'
import { connectedCardKindOf } from '../connected/ConnectedDeviceCard'
import { eventEntriesOf, eventLastOf } from '../connected/ConnectedEventCard'
import { gatewayFactsOf } from '../connected/ConnectedGatewayCard'
import { controlCardValueOf, controlSetInput } from '../connected/control-model'
import { AutomationCard, ButtonCard, ScriptCard } from '../scenes/action/ActionCards'
import { ControlCard } from '../scenes/control/ControlCard'
import { steppedValue } from '../scenes/control/model'
import { EventCard } from '../scenes/event/EventCard'
import { GatewayCard } from '../scenes/gateway/GatewayCard'
import { ImageCard } from '../scenes/image/ImageCard'
import { NotifierCard } from '../scenes/notifier/NotifierCard'
import { updatePhaseOf } from '../scenes/update/model'
import { UpdateCard } from '../scenes/update/UpdateCard'

afterEach(cleanup)

const noop = (): void => undefined

function fixture<M>(list: readonly WaveEFixture<M>[], id: string): WaveEFixture<M> {
  const found = list.find((f) => f.id === id)
  if (found === undefined) throw new Error(`no fixture ${id}`)
  return found
}

const IDENTITY = {
  toShown: (v: number) => v,
  toBase: (v: number) => v,
  unit: undefined,
  precision: undefined,
}

describe('connectedCardKindOf — the wave-E types', () => {
  it('draws each type only when it binds its own cap', () => {
    expect(connectedCardKindOf(DeviceType.Button, null, ['button'])).toBe('button')
    expect(connectedCardKindOf(DeviceType.Button, null, ['switch'])).toBeNull()
    expect(connectedCardKindOf(DeviceType.Update, null, ['update'])).toBe('update')
    expect(connectedCardKindOf(DeviceType.Script, null, ['script-runner'])).toBe('script')
    expect(connectedCardKindOf(DeviceType.Automation, null, ['automation-control'])).toBe(
      'automation',
    )
    expect(connectedCardKindOf(DeviceType.Control, null, ['control'])).toBe('control')
    expect(connectedCardKindOf(DeviceType.EventEmitter, null, ['event-emitter'])).toBe('event')
    expect(connectedCardKindOf(DeviceType.Image, null, ['image'])).toBe('image')
    expect(connectedCardKindOf(DeviceType.Notifier, null, ['notifier'])).toBe('notifier')
    expect(connectedCardKindOf(DeviceType.Notifier, null, [])).toBeNull()
  })

  it('draws a gateway from what it is, and leaves container and generic to the hero', () => {
    expect(connectedCardKindOf(DeviceType.Gateway, null, [])).toBe('gateway')
    expect(connectedCardKindOf(DeviceType.Container, null, ['switch'])).toBeNull()
    expect(connectedCardKindOf(DeviceType.Generic, null, ['switch'])).toBeNull()
  })
})

describe('the pure models', () => {
  it('an update is pending only when the versions differ, and installing wins', () => {
    expect(updatePhaseOf({ currentVersion: '1', availableVersion: '2', inProgress: false })).toBe(
      'available',
    )
    expect(updatePhaseOf({ currentVersion: '2', availableVersion: '2', inProgress: false })).toBe(
      'current',
    )
    expect(updatePhaseOf({ currentVersion: null, availableVersion: '2', inProgress: false })).toBe(
      'current',
    )
    expect(updatePhaseOf({ currentVersion: '1', availableVersion: '2', inProgress: true })).toBe(
      'installing',
    )
  })

  it('a step stays inside the range', () => {
    const control = {
      kind: 'numeric',
      value: 79.5,
      unit: null,
      min: 30,
      max: 80,
      step: 1,
      precision: null,
    } as const
    expect(steppedValue(control, 1)).toBe(80)
    expect(steppedValue({ ...control, value: 30 }, -1)).toBe(30)
    expect(steppedValue({ ...control, step: 0.1, value: 0.2, min: null }, 1)).toBe(0.3)
  })

  it('a number is shown in the operator unit and sent back in the device unit', () => {
    const fahrenheit = {
      toShown: (c: number) => c * 1.8 + 32,
      toBase: (f: number) => (f - 32) / 1.8,
      unit: '°F',
      precision: 0,
    }
    const value = controlCardValueOf(
      { kind: 'numeric', value: 20, options: [], lastChangedAt: 0, min: 10, max: 30 },
      fahrenheit,
      'datetime',
      String,
    )
    expect(value).toMatchObject({ kind: 'numeric', value: 68, unit: '°F', min: 50, max: 86 })
    expect(controlSetInput('numeric', 86, fahrenheit)).toEqual({ kind: 'numeric', value: 30 })
    expect(controlSetInput('numeric', '86', fahrenheit)).toBeNull()
    expect(controlSetInput('select', '', IDENTITY)).toBeNull()
    expect(controlSetInput('text', '', IDENTITY)).toEqual({ kind: 'text', value: '' })
  })

  it('a date keeps the shape its source declares', () => {
    const date = controlCardValueOf(
      { kind: 'datetime', value: '2026-11-12', options: [], lastChangedAt: 0 },
      IDENTITY,
      'date',
      (raw) => `shown ${raw}`,
    )
    expect(date).toEqual({
      kind: 'datetime',
      editor: 'date',
      value: '2026-11-12',
      shown: 'shown 2026-11-12',
    })
    const time = controlCardValueOf(
      { kind: 'datetime', value: '06:45:00', options: [], lastChangedAt: 0 },
      IDENTITY,
      'time',
      String,
    )
    expect(time).toMatchObject({ editor: 'time', value: '06:45' })
  })

  it('an event is labelled from the vocabulary, or by its raw type', () => {
    const status: EventEmitterStatus = {
      eventTypes: ['single', 'double'],
      vocabulary: [{ id: 'double', label: 'Double press' }],
      lastEvent: {
        deviceId: 1,
        eventType: 'double',
        data: null,
        timestamp: Date.now() - 120_000,
        seq: 4,
      },
      eventCountSinceStart: 4,
    }
    expect(eventEntriesOf(status)).toEqual([{ id: 'double', label: 'Double press' }])
    expect(eventLastOf(status, Date.now(), defaultUiText)).toMatchObject({
      id: 'double',
      label: 'Double press',
    })
    const raw = { ...status, vocabulary: [] }
    expect(eventEntriesOf(raw).map((e) => e.label)).toEqual(['single', 'double'])
    expect(eventLastOf({ ...status, lastEvent: null }, Date.now(), defaultUiText)).toBeNull()
    const omitted = {
      eventTypes: ['single', 'double'] as const,
      lastEvent: null,
    }
    expect(eventEntriesOf(omitted).map((e) => e.label)).toEqual(['single', 'double'])
  })

  it('two sources that share PRESS_SHORT stay distinct, and the last fire names its source', () => {
    const status: EventEmitterStatus = {
      eventTypes: ['PRESS_SHORT', 'PRESS_LONG'],
      vocabulary: [
        { id: 'PRESS_SHORT', source: { id: '1', label: 'Tasto 1' }, label: 'Pressione breve' },
        { id: 'PRESS_LONG', source: { id: '1', label: 'Tasto 1' }, label: 'Pressione lunga' },
        { id: 'PRESS_SHORT', source: { id: '2', label: 'Tasto 2' }, label: 'Pressione breve' },
        { id: 'PRESS_LONG', source: { id: '2', label: 'Tasto 2' }, label: 'Pressione lunga' },
      ],
      lastEvent: {
        deviceId: 1,
        eventType: 'PRESS_SHORT',
        sourceId: '2',
        data: null,
        timestamp: Date.now() - 4_000,
        seq: 3,
      },
      eventCountSinceStart: 3,
    }
    expect(eventEntriesOf(status).map((e) => `${e.source?.id ?? ''}:${e.id}`)).toEqual([
      '1:PRESS_SHORT',
      '1:PRESS_LONG',
      '2:PRESS_SHORT',
      '2:PRESS_LONG',
    ])
    expect(eventLastOf(status, Date.now(), defaultUiText)).toMatchObject({
      id: 'PRESS_SHORT',
      sourceId: '2',
      label: 'Pressione breve',
    })
  })

  it('a gateway draws only the facts it wrote', () => {
    expect(gatewayFactsOf({ ip: '10.0.0.2', firmware: '', model: 7 })).toEqual({
      model: null,
      firmware: null,
      address: '10.0.0.2',
    })
    expect(gatewayFactsOf(null)).toEqual({ model: null, firmware: null, address: null })
  })
})

describe('the scenes', () => {
  it('a button presses once', () => {
    const onPress = vi.fn()
    render(
      <ButtonCard model={fixture(buttonFixtures(), 'button-gate').model} actions={{ onPress }} />,
    )
    fireEvent.click(screen.getByTestId('dc-button-press'))
    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it('a read-only button cannot be pressed', () => {
    const onPress = vi.fn()
    render(
      <ButtonCard
        model={fixture(buttonFixtures(), 'button-readonly').model}
        actions={{ onPress }}
      />,
    )
    fireEvent.click(screen.getByTestId('dc-button-press'))
    expect(onPress).not.toHaveBeenCalled()
  })

  it('an update offers Install only while one is pending', () => {
    const onInstall = vi.fn()
    const { rerender } = render(
      <UpdateCard
        model={fixture(updateFixtures(), 'update-available').model}
        actions={{ onInstall }}
      />,
    )
    fireEvent.click(screen.getByTestId('dc-update-install'))
    expect(onInstall).toHaveBeenCalledTimes(1)
    rerender(
      <UpdateCard
        model={fixture(updateFixtures(), 'update-installing').model}
        actions={{ onInstall }}
      />,
    )
    expect(screen.queryByTestId('dc-update-install')).toBeNull()
    rerender(
      <UpdateCard
        model={fixture(updateFixtures(), 'update-current').model}
        actions={{ onInstall }}
      />,
    )
    expect(screen.queryByTestId('dc-update-install')).toBeNull()
  })

  it('a script runs, and stops while it runs', () => {
    const onRun = vi.fn()
    const onStop = vi.fn()
    const model = fixture(scriptFixtures(), 'script-ready').model
    const { rerender } = render(<ScriptCard model={model} actions={{ onRun, onStop }} />)
    fireEvent.click(screen.getByTestId('dc-script-run'))
    expect(onRun).toHaveBeenCalledTimes(1)
    rerender(<ScriptCard model={{ ...model, running: true }} actions={{ onRun, onStop }} />)
    expect(screen.queryByTestId('dc-script-run')).toBeNull()
    fireEvent.click(screen.getByTestId('dc-script-stop'))
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it("a script's last error is on the reason line", () => {
    render(
      <ScriptCard
        model={fixture(scriptFixtures(), 'script-error').model}
        actions={{ onRun: noop, onStop: noop }}
      />,
    )
    expect(screen.getByText('Servizio light.turn_off non trovato')).toBeTruthy()
  })

  it('an automation flips its own state and runs on demand', () => {
    const onEnabled = vi.fn()
    const onTrigger = vi.fn()
    const { rerender } = render(
      <AutomationCard
        model={fixture(automationFixtures(), 'automation-on').model}
        actions={{ onEnabled, onTrigger }}
      />,
    )
    fireEvent.click(screen.getByTestId('dc-automation-enabled'))
    expect(onEnabled).toHaveBeenLastCalledWith(false)
    fireEvent.click(screen.getByTestId('dc-automation-trigger'))
    expect(onTrigger).toHaveBeenCalledTimes(1)
    rerender(
      <AutomationCard
        model={fixture(automationFixtures(), 'automation-off').model}
        actions={{ onEnabled, onTrigger }}
      />,
    )
    fireEvent.click(screen.getByTestId('dc-automation-enabled'))
    expect(onEnabled).toHaveBeenLastCalledWith(true)
  })

  it('a number steps and stops at its bounds', () => {
    const onSet = vi.fn()
    const model = fixture(controlFixtures(), 'control-number').model
    render(<ControlCard model={model} actions={{ onSet }} />)
    fireEvent.click(screen.getByTestId('dc-control-up'))
    expect(onSet).toHaveBeenLastCalledWith(56)
    fireEvent.click(screen.getByTestId('dc-control-down'))
    expect(onSet).toHaveBeenLastCalledWith(54)
    expect(screen.getByTestId('dc-control-slider')).toBeTruthy()
  })

  it('a text is sent only on Save, and only when it changed', () => {
    const onSet = vi.fn()
    render(
      <ControlCard model={fixture(controlFixtures(), 'control-text').model} actions={{ onSet }} />,
    )
    const save = screen.getByTestId('dc-control-entry-save')
    expect(save.hasAttribute('disabled')).toBe(true)
    fireEvent.change(screen.getByTestId('dc-control-entry'), { target: { value: 'Ciao' } })
    fireEvent.click(save)
    expect(onSet).toHaveBeenCalledWith('Ciao')
  })

  it('a control the binding cannot set draws no editor', () => {
    const model = fixture(controlFixtures(), 'control-number').model
    render(<ControlCard model={{ ...model, settable: false }} actions={{ onSet: noop }} />)
    expect(screen.queryByTestId('dc-control-up')).toBeNull()
    expect(screen.queryByTestId('dc-control-slider')).toBeNull()
  })

  it('an event marks the one that fired last', () => {
    render(<EventCard model={fixture(eventFixtures(), 'event-vocabulary').model} />)
    expect(screen.getByTestId('dc-event-last').textContent).toContain('Doppio clic')
  })

  it('lists each source that shares PRESS_SHORT, and marks only the one that fired', () => {
    render(<EventCard model={fixture(eventFixtures(), 'event-sources').model} />)
    expect(screen.getByTestId('dc-state').textContent).toContain('Tasto 1 · Pressione breve')
    const groups = screen.getAllByTestId('dc-event-group')
    expect(groups.map((group) => group.querySelector('p')?.textContent)).toEqual([
      'Tasto 1',
      'Tasto 2',
    ])
    const rows = screen.getAllByTestId('dc-event-row')
    expect(rows.map((row) => row.getAttribute('data-event-key'))).toEqual([
      '1:PRESS_SHORT',
      '1:PRESS_LONG',
      '2:PRESS_SHORT',
      '2:PRESS_LONG',
    ])
    const last = screen.getAllByTestId('dc-event-last')
    expect(last).toHaveLength(1)
    expect(groups[0]?.contains(last[0] ?? null)).toBe(true)
    expect(screen.getAllByText('Pressione breve')).toHaveLength(2)
  })

  it('an image opens full size, and a missing one is a placeholder', () => {
    const { rerender } = render(<ImageCard model={fixture(imageFixtures(), 'image-shown').model} />)
    expect(screen.getByTestId('dc-image-open')).toBeTruthy()
    rerender(<ImageCard model={fixture(imageFixtures(), 'image-none').model} />)
    expect(screen.queryByTestId('dc-image-open')).toBeNull()
  })

  it('a failing notifier washes the scene, names why and shows its queue', () => {
    const onTest = vi.fn()
    render(
      <NotifierCard
        model={fixture(notifierFixtures(), 'notifier-failed').model}
        actions={{ onTest }}
      />,
    )
    expect(screen.getByTestId('dc-scene').getAttribute('data-alert')).toBe('true')
    expect(screen.getByText("Il server SMTP ha rifiutato l'accesso.")).toBeTruthy()
    expect(screen.getByTestId('dc-notifier-queued').textContent).toContain('3')
    fireEvent.click(screen.getByTestId('dc-notifier-test'))
    expect(onTest).toHaveBeenCalledTimes(1)
  })

  it('a gateway restarts only after the confirmation', () => {
    const onReboot = vi.fn()
    render(
      <GatewayCard
        model={fixture(gatewayFixtures(), 'gateway-connected').model}
        actions={{ onReboot }}
      />,
    )
    fireEvent.click(screen.getByTestId('dc-gateway-reboot'))
    expect(onReboot).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('dc-gateway-reboot'))
    expect(onReboot).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('dc-gateway-admin').getAttribute('href')).toBe(
      'https://192.168.1.40/',
    )
  })

  it('an unreachable gateway washes the scene', () => {
    render(
      <GatewayCard
        model={fixture(gatewayFixtures(), 'gateway-unreachable').model}
        actions={{ onReboot: noop }}
      />,
    )
    expect(screen.getByTestId('dc-scene').getAttribute('data-alert')).toBe('true')
    expect(screen.queryByTestId('dc-gateway-admin')).toBeNull()
  })

  const all: readonly [string, () => readonly ReactElement[]][] = [
    [
      'button',
      () =>
        buttonFixtures().map((f) => (
          <ButtonCard
            key={f.id}
            model={f.model}
            actions={{ onPress: noop }}
            orientation={f.orientation}
          />
        )),
    ],
    [
      'update',
      () =>
        updateFixtures().map((f) => (
          <UpdateCard
            key={f.id}
            model={f.model}
            actions={{ onInstall: noop }}
            orientation={f.orientation}
          />
        )),
    ],
    [
      'script',
      () =>
        scriptFixtures().map((f) => (
          <ScriptCard key={f.id} model={f.model} actions={{ onRun: noop, onStop: noop }} />
        )),
    ],
    [
      'automation',
      () =>
        automationFixtures().map((f) => (
          <AutomationCard
            key={f.id}
            model={f.model}
            actions={{ onEnabled: noop, onTrigger: noop }}
          />
        )),
    ],
    [
      'control',
      () =>
        controlFixtures().map((f) => (
          <ControlCard key={f.id} model={f.model} actions={{ onSet: noop }} />
        )),
    ],
    ['event', () => eventFixtures().map((f) => <EventCard key={f.id} model={f.model} />)],
    ['image', () => imageFixtures().map((f) => <ImageCard key={f.id} model={f.model} />)],
    [
      'notifier',
      () =>
        notifierFixtures().map((f) => (
          <NotifierCard key={f.id} model={f.model} actions={{ onTest: noop }} />
        )),
    ],
    [
      'gateway',
      () =>
        gatewayFixtures().map((f) => (
          <GatewayCard key={f.id} model={f.model} actions={{ onReboot: noop }} />
        )),
    ],
  ]
  it.each(all)('every %s fixture renders through the shell', (_kind, cards) => {
    const list = cards()
    render(<>{list}</>)
    expect(screen.getAllByTestId('dc-scene')).toHaveLength(list.length)
  })
})
