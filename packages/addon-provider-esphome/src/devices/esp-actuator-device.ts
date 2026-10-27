import {
  brightnessCapability,
  buttonCapability,
  controlCapability,
  coverCapability,
  switchCapability,
  type BrightnessStatus,
  type ControlStatus,
  type CoverStatus,
  type DeviceContext,
  type InferNativeProvider,
  type SwitchStatus,
} from '@camstack/types'
import {
  decodeBrightnessPercent,
  decodeCover,
  decodeLightOn,
  decodeNumber,
  decodeSwitch,
  decodeText,
} from '../esphome-decode.js'
import type { EspState } from '../esphome-link.js'
import { EspChildDevice, stampOnChange, type EspStateOrigin } from './esp-child-device.js'

const COLD_SWITCH: SwitchStatus = { on: false, lastChangedAt: 0 }
const COLD_BRIGHTNESS: BrightnessStatus = { level: 0, lastChangedAt: 0 }
const COLD_COVER: CoverStatus = {
  state: 'closed',
  position: null,
  tiltPosition: null,
  lastChangedAt: 0,
}

/**
 * The ESPHome children that WRITE: switch, light (switch + brightness), cover,
 * button, and the number / select controls. State flows back through the board's
 * own subscription, so a command never writes a slice itself — the slice shows
 * what the board reports, and a failed write leaves it as it was.
 */
export class EspActuatorDevice extends EspChildDevice {
  constructor(ctx: DeviceContext) {
    super(ctx)
    this.registerCaps()
    this.attach()
  }

  private get entityId(): string {
    const id = this.child.entityId
    if (id === undefined) throw new Error(`ESPHome child ${this.id} has no entity`)
    return id
  }

  protected ownedEntityIds(): readonly string[] {
    return this.child.entityId === undefined ? [] : [this.child.entityId]
  }

  private registerCaps(): void {
    switch (this.child.kind) {
      case 'switch':
        return this.registerSwitch()
      case 'light':
        this.registerSwitch()
        if (this.child.supportsBrightness === true) this.registerBrightness()
        return
      case 'cover':
        return this.registerCover()
      case 'button':
        return this.registerButton()
      case 'number-control':
      case 'select-control':
        return this.registerControl()
      default:
        return
    }
  }

  // ── switch / light ─────────────────────────────────────────────────────

  private registerSwitch(): void {
    const isLight = this.child.kind === 'light'
    const provider: InferNativeProvider<typeof switchCapability> = {
      getStatus: async () => this.runtimeState.getCapState<SwitchStatus>('switch') ?? COLD_SWITCH,
      setState: async ({ on }) => {
        this.send(
          isLight
            ? { type: 'light', id: this.entityId, state: on }
            : { type: 'switch', id: this.entityId, state: on },
        )
      },
    }
    this.ctx.registerNativeCap(switchCapability, provider)
    this.runtimeState.setCapState('switch', COLD_SWITCH)
  }

  private registerBrightness(): void {
    const provider: InferNativeProvider<typeof brightnessCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<BrightnessStatus>('brightness') ?? COLD_BRIGHTNESS,
      setBrightness: async ({ level: percentage }) => {
        this.send({
          type: 'light',
          id: this.entityId,
          state: percentage > 0,
          brightness: percentage / 100,
        })
      },
    }
    this.ctx.registerNativeCap(brightnessCapability, provider)
    this.runtimeState.setCapState('brightness', COLD_BRIGHTNESS)
  }

  // ── cover ──────────────────────────────────────────────────────────────

  private registerCover(): void {
    const provider: InferNativeProvider<typeof coverCapability> = {
      getStatus: async () => this.runtimeState.getCapState<CoverStatus>('cover') ?? COLD_COVER,
      open: async () => this.send({ type: 'cover', id: this.entityId, position: 1 }),
      close: async () => this.send({ type: 'cover', id: this.entityId, position: 0 }),
      stop: async () => {
        if (this.child.supportsStop === false) this.unsupported('cover stop')
        this.send({ type: 'cover', id: this.entityId, stop: true })
      },
      setPosition: async ({ position }) => {
        if (this.child.supportsPosition !== true) this.unsupported('cover position')
        this.send({ type: 'cover', id: this.entityId, position: position / 100 })
      },
      setTiltPosition: async () => this.unsupported('cover tilt'),
    }
    this.ctx.registerNativeCap(coverCapability, provider)
    this.runtimeState.setCapState('cover', COLD_COVER)
  }

  // ── button ─────────────────────────────────────────────────────────────

  private registerButton(): void {
    const provider: InferNativeProvider<typeof buttonCapability> = {
      press: async () => this.send({ type: 'button', id: this.entityId }),
    }
    this.ctx.registerNativeCap(buttonCapability, provider)
  }

  // ── number / select ────────────────────────────────────────────────────

  private coldControl(): ControlStatus {
    if (this.child.kind === 'number-control') {
      return {
        kind: 'numeric',
        value: 0,
        options: [],
        lastChangedAt: 0,
        ...(this.child.min != null ? { min: this.child.min } : {}),
        ...(this.child.max != null ? { max: this.child.max } : {}),
        ...(this.child.step != null ? { step: this.child.step } : {}),
      }
    }
    const options = this.child.options ?? []
    return { kind: 'select', value: options[0] ?? '', options: [...options], lastChangedAt: 0 }
  }

  private registerControl(): void {
    const provider: InferNativeProvider<typeof controlCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<ControlStatus>('control') ?? this.coldControl(),
      setValue: async ({ control }) => {
        if (control.kind === 'numeric' && this.child.kind === 'number-control') {
          this.send({ type: 'number', id: this.entityId, state: control.value })
          return
        }
        if (control.kind === 'select' && this.child.kind === 'select-control') {
          this.send({ type: 'select', id: this.entityId, state: control.value })
          return
        }
        this.unsupported(`control kind '${control.kind}'`)
      },
    }
    this.ctx.registerNativeCap(controlCapability, provider)
    this.runtimeState.setCapState('control', this.coldControl())
  }

  // ── state decode ───────────────────────────────────────────────────────

  protected applyState(state: EspState, _origin: EspStateOrigin): void {
    const now = Date.now()
    switch (state.type) {
      case 'switch':
        return this.applySwitch(decodeSwitch(state), now)
      case 'light':
        this.applySwitch(decodeLightOn(state), now)
        if (this.child.supportsBrightness === true) this.applyBrightness(state, now)
        return
      case 'cover':
        return this.applyCover(state, now)
      case 'number':
        return this.applyNumber(state, now)
      case 'select':
        return this.applySelect(state, now)
      default:
        return
    }
  }

  private applySwitch(on: boolean, now: number): void {
    const prev = this.runtimeState.getCapState<SwitchStatus>('switch') ?? COLD_SWITCH
    this.runtimeState.setCapState('switch', {
      on,
      lastChangedAt: stampOnChange(prev.lastChangedAt, prev.on !== on, now),
    })
  }

  private applyBrightness(state: Extract<EspState, { type: 'light' }>, now: number): void {
    const prev = this.runtimeState.getCapState<BrightnessStatus>('brightness') ?? COLD_BRIGHTNESS
    // A light that is off reports no brightness; the cap keeps the last level
    // the operator chose rather than showing a dimmed lamp as 0 %.
    if (!decodeLightOn(state)) return
    const percentage = decodeBrightnessPercent(state)
    this.runtimeState.setCapState('brightness', {
      level: percentage,
      lastChangedAt: stampOnChange(prev.lastChangedAt, prev.level !== percentage, now),
    })
  }

  private applyCover(state: Extract<EspState, { type: 'cover' }>, now: number): void {
    const prev = this.runtimeState.getCapState<CoverStatus>('cover') ?? COLD_COVER
    const next = decodeCover(state)
    const position = this.child.supportsPosition === true ? next.position : null
    this.runtimeState.setCapState('cover', {
      state: next.state,
      position,
      tiltPosition: null,
      lastChangedAt: stampOnChange(
        prev.lastChangedAt,
        prev.state !== next.state || prev.position !== position,
        now,
      ),
    })
  }

  private applyNumber(state: Extract<EspState, { type: 'number' }>, now: number): void {
    const value = decodeNumber(state)
    // An unknown value keeps the previous reading; a control is never shown as 0.
    if (value === null) return
    const prev = this.runtimeState.getCapState<ControlStatus>('control') ?? this.coldControl()
    this.runtimeState.setCapState('control', {
      ...prev,
      kind: 'numeric',
      value,
      lastChangedAt: stampOnChange(prev.lastChangedAt, prev.value !== value, now),
    })
  }

  private applySelect(state: Extract<EspState, { type: 'select' }>, now: number): void {
    const value = decodeText(state)
    if (value === null) return
    const prev = this.runtimeState.getCapState<ControlStatus>('control') ?? this.coldControl()
    this.runtimeState.setCapState('control', {
      ...prev,
      kind: 'select',
      value,
      lastChangedAt: stampOnChange(prev.lastChangedAt, prev.value !== value, now),
    })
  }
}
