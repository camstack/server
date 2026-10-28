import type { EspConnection } from '../config.js'
import {
  EspLinkError,
  type EspBoardInfo,
  type EspCommand,
  type EspEntity,
  type EspLink,
  type EspLinkFactory,
  type EspServiceArgValue,
  type EspServiceInfo,
  type EspState,
} from '../esphome-link.js'

export const BOARD_INFO: EspBoardInfo = {
  name: 'board-a',
  friendlyName: 'Board A',
  model: 'esp32',
  manufacturer: 'acme',
  esphomeVersion: '2024.4.2',
  macAddress: 'AA:BB:CC:00:00:01',
  encrypted: true,
}

export function entity(partial: Partial<EspEntity> & Pick<EspEntity, 'id' | 'type'>): EspEntity {
  return {
    name: partial.id,
    deviceClass: '',
    category: 'none',
    disabledByDefault: false,
    unit: '',
    supportsPosition: false,
    supportsStop: false,
    isStatusBinarySensor: false,
    supportsBrightness: false,
    min: null,
    max: null,
    step: null,
    options: [],
    eventTypes: [],
    ...partial,
  }
}

/** A scripted board session. */
export class FakeLink implements EspLink {
  readonly commands: EspCommand[] = []
  readonly serviceCalls: {
    name: string
    args: Record<string, EspServiceArgValue>
  }[] = []
  services: readonly EspServiceInfo[] = []
  closed = false
  private states: EspState[]
  private readonly stateHandlers = new Set<(state: EspState) => void>()
  private readonly closeHandlers = new Set<(cause: EspLinkError | null) => void>()

  constructor(
    private readonly board: readonly EspEntity[],
    initial: readonly EspState[] = [],
  ) {
    this.states = [...initial]
  }

  entities(): readonly EspEntity[] {
    return this.board
  }
  snapshot(): readonly EspState[] {
    return this.states
  }
  info(): EspBoardInfo {
    return BOARD_INFO
  }
  onState(handler: (state: EspState) => void): () => void {
    this.stateHandlers.add(handler)
    return () => {
      this.stateHandlers.delete(handler)
    }
  }
  onClose(handler: (cause: EspLinkError | null) => void): () => void {
    this.closeHandlers.add(handler)
    return () => {
      this.closeHandlers.delete(handler)
    }
  }
  command(command: EspCommand): void {
    this.commands.push(command)
  }
  listServices(): readonly EspServiceInfo[] {
    return this.services
  }
  async executeService(
    name: string,
    args: Readonly<Record<string, EspServiceArgValue>>,
  ): Promise<void> {
    this.serviceCalls.push({ name, args: { ...args } })
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const h of this.closeHandlers) h(null)
  }

  /** Test driver: the board reports a state. */
  push(state: EspState): void {
    this.states = [...this.states.filter((s) => s.id !== state.id), state]
    for (const h of this.stateHandlers) h(state)
  }
  /** Test driver: the connection drops. */
  drop(cause: EspLinkError | null): void {
    this.closed = true
    for (const h of this.closeHandlers) h(cause)
  }
}

export type OpenOutcome = FakeLink | EspLinkError

/** A factory that serves the queued outcomes in order, then repeats the last one. */
export class FakeFactory implements EspLinkFactory {
  readonly opened: EspConnection[] = []
  private readonly outcomes: OpenOutcome[]

  constructor(...outcomes: OpenOutcome[]) {
    this.outcomes = outcomes
  }

  enqueue(outcome: OpenOutcome): void {
    this.outcomes.push(outcome)
  }

  async open(connection: Readonly<EspConnection>): Promise<EspLink> {
    this.opened.push({ ...connection })
    const next = this.outcomes.length > 1 ? this.outcomes.shift() : this.outcomes[0]
    if (next === undefined) throw new EspLinkError('error', 'no scripted outcome')
    if (next instanceof EspLinkError) throw next
    return next
  }
}
