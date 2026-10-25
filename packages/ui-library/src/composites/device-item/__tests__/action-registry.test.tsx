/**
 * Verifies that the DEVICE_TYPE_CONTROL registry (which replaced the
 * old per-type popover action registry) covers every DeviceType and
 * that types with real inline controls are wired correctly while
 * genuine placeholder types still resolve to DummyInline.
 *
 * The old `DEVICE_TYPE_ACTIONS` / `resolveRowActions` registry has been
 * retired: per-type controls now come from `resolveDeviceControl` in
 * `device-controls/control-registry.tsx`. Sensor rows display their
 * live value via `SensorValueAtom` directly in `DeviceItemActions`.
 */
import { describe, it, expect } from 'vitest'
import { DeviceType } from '@camstack/types'
import { DEVICE_TYPE_CONTROL, resolveDeviceControl } from '../../device-controls/control-registry'
import { CoverInlineControl } from '../../device-controls/cover-inline'
import { DummyInline } from '../../device-controls/dummy-hero-card'
import {
  SwitchInlineControl,
  LockInlineControl,
  LightInlineControl,
  FanInlineControl,
  ThermostatInlineControl,
  MediaPlayerInlineControl,
  AlarmPanelInlineControl,
  ScriptInlineControl,
  AutomationInlineControl,
  ControlInlineControl,
} from '../../device-controls/panel-controls'
import { SensorInlineControl } from '../../device-controls/sensor-inline-control'
import { ButtonControl } from '../../device-controls/button-control'
import { VacuumInlineControl } from '../../device-controls/vacuum-control'
import { LawnMowerInlineControl } from '../../device-controls/lawn-mower-control'
import { DishwasherInlineControl } from '../../device-controls/dishwasher-control'

describe('DEVICE_TYPE_CONTROL (replaces DEVICE_TYPE_ACTIONS)', () => {
  it('maps every DeviceType (exhaustive)', () => {
    for (const t of Object.values(DeviceType)) {
      expect(DEVICE_TYPE_CONTROL[t]).toBeDefined()
    }
  })

  it('Cover → CoverInlineControl (real inline control)', () => {
    expect(DEVICE_TYPE_CONTROL[DeviceType.Cover].InlineControl).toBe(CoverInlineControl)
  })

  /**
   * Types that now have real inline controls — assert each one is wired
   * to its specific control so a regression to DummyInline is caught.
   */
  it('types with real inline controls are NOT DummyInline', () => {
    const realControls: Array<[DeviceType, (p: never) => unknown]> = [
      [DeviceType.Cover, CoverInlineControl],
      [DeviceType.Switch, SwitchInlineControl],
      [DeviceType.Siren, SwitchInlineControl],
      [DeviceType.Light, LightInlineControl],
      [DeviceType.Fan, FanInlineControl],
      [DeviceType.Sensor, SensorInlineControl],
      [DeviceType.Presence, SensorInlineControl],
      [DeviceType.Thermostat, ThermostatInlineControl],
      [DeviceType.Button, ButtonControl],
      [DeviceType.Lock, LockInlineControl],
      [DeviceType.MediaPlayer, MediaPlayerInlineControl],
      [DeviceType.AlarmPanel, AlarmPanelInlineControl],
      [DeviceType.Control, ControlInlineControl],
      [DeviceType.Vacuum, VacuumInlineControl],
      [DeviceType.LawnMower, LawnMowerInlineControl],
      [DeviceType.Dishwasher, DishwasherInlineControl],
      // Promoted 2026-08-05. This test is what caught the promotion — it
      // failed with `expected ScriptInlineControl to be DummyInline` the
      // moment the kind changed, which is the review it exists to force.
      [DeviceType.Script, ScriptInlineControl],
      [DeviceType.Automation, AutomationInlineControl],
    ]
    for (const [type, expectedControl] of realControls) {
      expect(DEVICE_TYPE_CONTROL[type].InlineControl).toBe(expectedControl)
      expect(DEVICE_TYPE_CONTROL[type].InlineControl).not.toBe(DummyInline)
    }
  })

  /**
   * Types that are genuine DummyInline placeholders (no real inline control
   * yet) — assert they still resolve to DummyInline so a silent promotion
   * to a real control is flagged and reviewed.
   */
  it('genuine placeholder types → DummyInline', () => {
    const dummyTypes: DeviceType[] = [
      DeviceType.Camera,
      DeviceType.Hub,
      DeviceType.Generic,
      DeviceType.Notifier,
      DeviceType.Container,
    ]
    for (const t of dummyTypes) {
      expect(DEVICE_TYPE_CONTROL[t].InlineControl).toBe(DummyInline)
    }
  })

  it('resolveDeviceControl returns null for unknown type strings', () => {
    expect(resolveDeviceControl('unknown-type-xyz')).toBeNull()
  })

  it('resolveDeviceControl returns a DeviceTypeControl for known types', () => {
    const result = resolveDeviceControl(DeviceType.Cover)
    expect(result).not.toBeNull()
    expect(result?.InlineControl).toBe(CoverInlineControl)
  })

  it('resolveDeviceControl returns DummyInline for Camera, Hub, Generic (no real control)', () => {
    expect(resolveDeviceControl(DeviceType.Camera)?.InlineControl).toBe(DummyInline)
    expect(resolveDeviceControl(DeviceType.Hub)?.InlineControl).toBe(DummyInline)
    expect(resolveDeviceControl(DeviceType.Generic)?.InlineControl).toBe(DummyInline)
  })

  it('Button → ButtonControl (real inline control, not DummyInline)', () => {
    expect(resolveDeviceControl(DeviceType.Button)?.InlineControl).toBe(ButtonControl)
    expect(resolveDeviceControl(DeviceType.Button)?.InlineControl).not.toBe(DummyInline)
  })

  it('Container type → DummyInline (no per-type control on container row)', () => {
    expect(resolveDeviceControl(DeviceType.Container)?.InlineControl).toBe(DummyInline)
  })
})
