import type { ConfigSection } from '@camstack/types'
import { z } from 'zod'

/**
 * Driver-authored device-settings sections for the camera facts that no
 * vendor-neutral cap models: the IR illuminator, the status LED, NTP /
 * timezone, and the auto-reboot schedule. Taxonomy (section ids + tabs)
 * matches the Reolink driver (`ir-lights` on `image`, `time-ntp` on
 * `network`, `auto-reboot` on `advanced`) so the operator sees the same
 * layout regardless of vendor.
 *
 * D62 discipline: none of these keys is stored in the device config —
 * the CAMERA is the authority. `applySettingsPatch` maps them onto
 * `configManager.cgi?action=setConfig` writes (via
 * {@link extrasPatchToCgiParams}) and re-reads the camera into the
 * `deviceCache.extras` snapshot; `config.setAll` strips them because
 * they are not in the schema.
 *
 * Every Dahua key, token and bound below was verified against the live
 * IP4M-1041B (firmware 2.800.1ENN001.0.R) on 2026-09-04:
 *   - `Lighting[0][0].Mode` — Auto/Manual/Off. The firmware stores ANY
 *     string verbatim (even `TotallyBogusMode`), so THIS module is the
 *     validator. `Manual` + `MiddleLight[0].Light=100` was proven
 *     functionally: with the IR-cut forced open, the dark half of the
 *     frame lit up; `Off` left it dark.
 *   - `LightGlobal[0].Enable` — status-LED switch, boolean round-trip.
 *   - `NTP.*` — `TimeZone` accepts 0..33 (60 → HTTP 400); `Enable`,
 *     `Address`, `Port`, `UpdatePeriod` (minutes) all round-trip.
 *   - `AutoMaintain.AutoReboot{Enable,Day,Hour,Minute}` — `Day` accepts
 *     -1..7 (8 → HTTP 400); 0..6 = Sunday..Saturday, 7 = every day.
 */

/** Read-projection of the four extras config tables. All fields optional
 *  — a table the camera omitted stays absent (unknown, never fabricated). */
export const amcrestExtrasSnapshotSchema = z
  .object({
    /** `Lighting[0][0].Mode` — only the verified enum; an unknown stored
     *  token reads as absent. */
    irLightMode: z.enum(['Auto', 'Manual', 'Off']),
    /** `Lighting[0][0].MiddleLight[0].Light` 0..100. */
    irLightBrightness: z.number(),
    /** `LightGlobal[0].Enable`. */
    statusLedEnabled: z.boolean(),
    ntpEnabled: z.boolean(),
    ntpServer: z.string(),
    ntpPort: z.number(),
    /** `NTP.UpdatePeriod`, minutes. */
    ntpUpdatePeriodMin: z.number(),
    /** Dahua timezone index (`NTP.TimeZone`), 0..33. */
    ntpTimeZoneIndex: z.number(),
    autoRebootEnabled: z.boolean(),
    /** 0..6 = Sunday..Saturday, 7 = every day. */
    autoRebootDay: z.number(),
    autoRebootHour: z.number(),
    autoRebootMinute: z.number(),
    /** Wall-clock ms of the read that produced this snapshot. */
    fetchedAt: z.number(),
  })
  .partial()

export type AmcrestExtrasSnapshot = z.infer<typeof amcrestExtrasSnapshotSchema>

/** The config tables one multi-name `getConfig` call reads to build the
 *  snapshot (the CGI accepts repeated `name=` params — verified live). */
export const AMCREST_EXTRAS_CONFIG_NAMES = [
  'Lighting',
  'LightGlobal',
  'NTP',
  'AutoMaintain',
] as const

const IR_LIGHT_MODES = ['Auto', 'Manual', 'Off'] as const
type IrLightMode = (typeof IR_LIGHT_MODES)[number]

function isIrLightMode(value: string): value is IrLightMode {
  return (IR_LIGHT_MODES as readonly string[]).includes(value)
}

function intOrUndefined(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : undefined
}

function boolOrUndefined(raw: string | undefined): boolean | undefined {
  if (raw === 'true') return true
  if (raw === 'false') return false
  return undefined
}

/** Project the flat Dahua table (multi-name getConfig result) into the
 *  extras snapshot. Absent keys stay absent. */
export function parseExtrasSnapshot(
  table: ReadonlyMap<string, string>,
  now: number,
): AmcrestExtrasSnapshot {
  const out: AmcrestExtrasSnapshot = { fetchedAt: now }
  const modeRaw = table.get('Lighting[0][0].Mode')
  if (modeRaw !== undefined && isIrLightMode(modeRaw)) out.irLightMode = modeRaw
  const light = intOrUndefined(table.get('Lighting[0][0].MiddleLight[0].Light'))
  if (light !== undefined) out.irLightBrightness = light
  const led = boolOrUndefined(table.get('LightGlobal[0].Enable'))
  if (led !== undefined) out.statusLedEnabled = led
  const ntpEnabled = boolOrUndefined(table.get('NTP.Enable'))
  if (ntpEnabled !== undefined) out.ntpEnabled = ntpEnabled
  const ntpServer = table.get('NTP.Address')
  if (ntpServer !== undefined) out.ntpServer = ntpServer
  const ntpPort = intOrUndefined(table.get('NTP.Port'))
  if (ntpPort !== undefined) out.ntpPort = ntpPort
  const period = intOrUndefined(table.get('NTP.UpdatePeriod'))
  if (period !== undefined) out.ntpUpdatePeriodMin = period
  const tz = intOrUndefined(table.get('NTP.TimeZone'))
  if (tz !== undefined) out.ntpTimeZoneIndex = tz
  const rebootEnabled = boolOrUndefined(table.get('AutoMaintain.AutoRebootEnable'))
  if (rebootEnabled !== undefined) out.autoRebootEnabled = rebootEnabled
  const rebootDay = intOrUndefined(table.get('AutoMaintain.AutoRebootDay'))
  if (rebootDay !== undefined) out.autoRebootDay = rebootDay
  const rebootHour = intOrUndefined(table.get('AutoMaintain.AutoRebootHour'))
  if (rebootHour !== undefined) out.autoRebootHour = rebootHour
  const rebootMinute = intOrUndefined(table.get('AutoMaintain.AutoRebootMinute'))
  if (rebootMinute !== undefined) out.autoRebootMinute = rebootMinute
  return out
}

/**
 * Build the three extras sections from the last camera read. NO snapshot
 * → NO sections: rendering fabricated defaults for a camera nobody has
 * reached would make not-yet-known look like known (D337-shape), and a
 * Save against those phantoms would overwrite real camera state.
 */
export function buildExtrasSections(
  snap: AmcrestExtrasSnapshot | undefined,
): readonly ConfigSection[] {
  if (snap === undefined) return []
  return [
    {
      id: 'ir-lights',
      tab: 'image',
      title: 'IR + status LED',
      titleKey: 'provider-amcrest:extrasSections.s_ir-lights.title',
      description:
        '`Auto` follows ambient light; `Manual` forces the LEDs on at the set brightness.',
      descriptionKey: 'provider-amcrest:extrasSections.s_ir-lights.description',
      columns: 2,
      fields: [
        {
          type: 'select',
          key: 'irLightMode',
          label: 'IR illuminator',
          labelKey: 'provider-amcrest:extrasSections.s_ir-lights.irLightMode.label',
          default: snap.irLightMode ?? 'Auto',
          options: [
            {
              value: 'Auto',
              label: 'Auto (camera decides)',
              labelKey: 'provider-amcrest:extrasSections.s_ir-lights.irLightMode.o_Auto.label',
            },
            {
              value: 'Manual',
              label: 'Always on',
              labelKey: 'provider-amcrest:extrasSections.s_ir-lights.irLightMode.o_Manual.label',
            },
            {
              value: 'Off',
              label: 'Always off',
              labelKey: 'provider-amcrest:extrasSections.s_ir-lights.irLightMode.o_Off.label',
            },
          ],
        },
        {
          type: 'slider',
          key: 'irLightBrightness',
          label: 'IR brightness',
          labelKey: 'provider-amcrest:extrasSections.s_ir-lights.irLightBrightness.label',
          min: 0,
          max: 100,
          step: 5,
          default: snap.irLightBrightness ?? 50,
          showValue: true,
          showStepper: true,
        },
        {
          type: 'boolean',
          key: 'statusLedEnabled',
          label: 'Status LED',
          labelKey: 'provider-amcrest:extrasSections.s_ir-lights.statusLedEnabled.label',
          default: snap.statusLedEnabled ?? true,
          style: 'switch',
          span: 2,
        },
      ],
    },
    {
      id: 'time-ntp',
      tab: 'network',
      title: 'Time / NTP',
      titleKey: 'provider-amcrest:extrasSections.s_time-ntp.title',
      description: "With NTP disabled this camera's clock drifts badly.",
      descriptionKey: 'provider-amcrest:extrasSections.s_time-ntp.description',
      columns: 2,
      fields: [
        {
          type: 'boolean',
          key: 'ntpEnabled',
          label: 'NTP sync',
          labelKey: 'provider-amcrest:extrasSections.s_time-ntp.ntpEnabled.label',
          default: snap.ntpEnabled ?? false,
          style: 'switch',
          span: 2,
        },
        {
          type: 'text',
          key: 'ntpServer',
          label: 'NTP server',
          labelKey: 'provider-amcrest:extrasSections.s_time-ntp.ntpServer.label',
          default: snap.ntpServer ?? 'pool.ntp.org',
          placeholder: 'pool.ntp.org',
          span: 2,
        },
        {
          type: 'number',
          key: 'ntpPort',
          label: 'NTP port',
          labelKey: 'provider-amcrest:extrasSections.s_time-ntp.ntpPort.label',
          default: snap.ntpPort ?? 123,
          min: 1,
          max: 65535,
          step: 1,
        },
        {
          type: 'number',
          key: 'ntpUpdatePeriodMin',
          label: 'Sync interval (min)',
          labelKey: 'provider-amcrest:extrasSections.s_time-ntp.ntpUpdatePeriodMin.label',
          default: snap.ntpUpdatePeriodMin ?? 10,
          min: 1,
          max: 65535,
          step: 1,
        },
        {
          type: 'number',
          key: 'ntpTimeZoneIndex',
          label: 'Timezone index (Dahua, 0–33)',
          labelKey: 'provider-amcrest:extrasSections.s_time-ntp.ntpTimeZoneIndex.label',
          description:
            'Dahua numeric index (0–33) from the camera web UI timezone list, not an IANA zone. 26 = GMT+8.',
          descriptionKey: 'provider-amcrest:extrasSections.s_time-ntp.ntpTimeZoneIndex.description',
          default: snap.ntpTimeZoneIndex ?? 26,
          min: 0,
          max: 33,
          step: 1,
          span: 2,
        },
      ],
    },
    {
      id: 'auto-reboot',
      tab: 'advanced',
      title: 'Auto reboot',
      titleKey: 'provider-amcrest:extrasSections.s_auto-reboot.title',
      columns: 2,
      fields: [
        {
          type: 'boolean',
          key: 'autoRebootEnabled',
          label: 'Auto reboot',
          labelKey: 'provider-amcrest:extrasSections.s_auto-reboot.autoRebootEnabled.label',
          default: snap.autoRebootEnabled ?? false,
          style: 'switch',
          span: 2,
        },
        {
          type: 'select',
          key: 'autoRebootDay',
          label: 'Day',
          labelKey: 'provider-amcrest:extrasSections.s_auto-reboot.autoRebootDay.label',
          // Select values are strings on the wire; `extrasPatchToCgiParams`
          // coerces back to the numeric Dahua day index.
          default: String(snap.autoRebootDay ?? 7),
          span: 2,
          options: [
            {
              value: '7',
              label: 'Every day',
              labelKey: 'provider-amcrest:extrasSections.s_auto-reboot.autoRebootDay.o_7.label',
            },
            {
              value: '0',
              label: 'Sunday',
              labelKey: 'provider-amcrest:extrasSections.s_auto-reboot.autoRebootDay.o_0.label',
            },
            {
              value: '1',
              label: 'Monday',
              labelKey: 'provider-amcrest:extrasSections.s_auto-reboot.autoRebootDay.o_1.label',
            },
            {
              value: '2',
              label: 'Tuesday',
              labelKey: 'provider-amcrest:extrasSections.s_auto-reboot.autoRebootDay.o_2.label',
            },
            {
              value: '3',
              label: 'Wednesday',
              labelKey: 'provider-amcrest:extrasSections.s_auto-reboot.autoRebootDay.o_3.label',
            },
            {
              value: '4',
              label: 'Thursday',
              labelKey: 'provider-amcrest:extrasSections.s_auto-reboot.autoRebootDay.o_4.label',
            },
            {
              value: '5',
              label: 'Friday',
              labelKey: 'provider-amcrest:extrasSections.s_auto-reboot.autoRebootDay.o_5.label',
            },
            {
              value: '6',
              label: 'Saturday',
              labelKey: 'provider-amcrest:extrasSections.s_auto-reboot.autoRebootDay.o_6.label',
            },
          ],
        },
        {
          type: 'number',
          key: 'autoRebootHour',
          label: 'Hour (0-23)',
          labelKey: 'provider-amcrest:extrasSections.s_auto-reboot.autoRebootHour.label',
          default: snap.autoRebootHour ?? 2,
          min: 0,
          max: 23,
          step: 1,
        },
        {
          type: 'number',
          key: 'autoRebootMinute',
          label: 'Minute (0-59)',
          labelKey: 'provider-amcrest:extrasSections.s_auto-reboot.autoRebootMinute.label',
          default: snap.autoRebootMinute ?? 30,
          min: 0,
          max: 59,
          step: 1,
        },
      ],
    },
  ]
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)))
}

/** Coerce a select/number value that may arrive as a numeric string. */
function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

export interface ExtrasPatchResult {
  /** Dahua `setConfig` params (raw config paths → values). */
  readonly params: Readonly<Record<string, string | number>>
  /** The patch keys this module consumed (for logging / dispatch checks). */
  readonly handled: readonly string[]
}

/**
 * Map an extras settings patch onto Dahua `setConfig` params. Wrongly
 * typed values are DROPPED, and every numeric is clamped into its
 * live-verified writable window — an out-of-window value would fail the
 * whole multi-key CGI write with HTTP 400, silently losing the other
 * fields in the same save.
 */
export function extrasPatchToCgiParams(
  patch: Readonly<Record<string, unknown>>,
): ExtrasPatchResult {
  const params: Record<string, string | number> = {}
  const handled: string[] = []

  const consume = (key: string): void => {
    if (key in patch) handled.push(key)
  }

  consume('irLightMode')
  const irMode = patch['irLightMode']
  if (typeof irMode === 'string' && isIrLightMode(irMode)) {
    params['Lighting[0][0].Mode'] = irMode
  }

  consume('irLightBrightness')
  const irBrightness = asNumber(patch['irLightBrightness'])
  if (irBrightness !== undefined) {
    params['Lighting[0][0].MiddleLight[0].Light'] = clampInt(irBrightness, 0, 100)
  }

  consume('statusLedEnabled')
  const led = patch['statusLedEnabled']
  if (typeof led === 'boolean') params['LightGlobal[0].Enable'] = led ? 'true' : 'false'

  consume('ntpEnabled')
  const ntpEnabled = patch['ntpEnabled']
  if (typeof ntpEnabled === 'boolean') params['NTP.Enable'] = ntpEnabled ? 'true' : 'false'

  consume('ntpServer')
  const ntpServer = patch['ntpServer']
  if (typeof ntpServer === 'string' && ntpServer.trim() !== '') {
    params['NTP.Address'] = ntpServer.trim()
  }

  consume('ntpPort')
  const ntpPort = asNumber(patch['ntpPort'])
  if (ntpPort !== undefined) params['NTP.Port'] = clampInt(ntpPort, 1, 65535)

  consume('ntpUpdatePeriodMin')
  const ntpPeriod = asNumber(patch['ntpUpdatePeriodMin'])
  if (ntpPeriod !== undefined) params['NTP.UpdatePeriod'] = clampInt(ntpPeriod, 1, 65535)

  consume('ntpTimeZoneIndex')
  const tz = asNumber(patch['ntpTimeZoneIndex'])
  if (tz !== undefined) params['NTP.TimeZone'] = clampInt(tz, 0, 33)

  consume('autoRebootEnabled')
  const rebootEnabled = patch['autoRebootEnabled']
  if (typeof rebootEnabled === 'boolean') {
    params['AutoMaintain.AutoRebootEnable'] = rebootEnabled ? 'true' : 'false'
  }

  consume('autoRebootDay')
  const rebootDay = asNumber(patch['autoRebootDay'])
  if (rebootDay !== undefined) params['AutoMaintain.AutoRebootDay'] = clampInt(rebootDay, 0, 7)

  consume('autoRebootHour')
  const rebootHour = asNumber(patch['autoRebootHour'])
  if (rebootHour !== undefined) params['AutoMaintain.AutoRebootHour'] = clampInt(rebootHour, 0, 23)

  consume('autoRebootMinute')
  const rebootMinute = asNumber(patch['autoRebootMinute'])
  if (rebootMinute !== undefined) {
    params['AutoMaintain.AutoRebootMinute'] = clampInt(rebootMinute, 0, 59)
  }

  return { params, handled }
}
