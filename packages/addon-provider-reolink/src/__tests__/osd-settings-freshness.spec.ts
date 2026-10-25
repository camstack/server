import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OPERATOR_WRITTEN_STALE_MS } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  buildOsdSection,
  isOsdSnapshotStale,
  type OsdSnapshot,
  resolveOsdValues,
} from '../osd-settings-section.js'
import { reolinkCameraSchema } from '../schema.js'

/**
 * OSD overlay state honesty (D224 / D315-shape / D337 / D62-shape).
 *
 * Three defects compounded into "CamStack says the channel-name overlay is
 * ON while the camera has it OFF":
 *  1. the `getOsd` snapshot was effectively adoption-frozen — nothing on the
 *     settings-open path considered it stale (`hasIncompleteSettingsCache`
 *     never looked at `osdSnapshot`),
 *  2. a failed or sleep-skipped probe logged only at debug, so the operator
 *     was served a stale value with nothing saying so,
 *  3. the read carefully kept `null` for "the camera did not tell us", and
 *     one layer up `?? true` rendered that unknown as ENABLED.
 *
 * Follow-up, same D62 shape as the switches that wrote a store nobody read:
 * the driver config held a SECOND copy of the OSD facts (`osd*` keys written
 * by `setAll`) that shadowed the camera's snapshot forever after one CamStack
 * write. The camera is the only authority now — the config stores nothing,
 * a write is its own invalidation (the post-save `osd` slice re-read), and a
 * refused or partial `setOsd` is never stamped as fact because the snapshot
 * only ever records what `getOsd` actually returned.
 *
 * The overlay POSITIONS (`osdChannel.pos` / `osdTime.pos`) ride the same
 * `getOsd` read into the snapshot — read-only, tri-state (unknown is null,
 * not ''), surfaced so a vocabulary of real values can be collected before
 * anyone designs a position control. The write path's preservation of `pos`
 * is deliberately untouched.
 *
 * Pure-function tests cover the tri-state resolution + section rendering;
 * structural assertions (same style as the sibling battery/privacy-mask
 * discipline specs) pin the wiring inside `ReolinkCamera`, which cannot be
 * constructed without a full `DeviceContext`.
 */

const here = dirname(fileURLToPath(import.meta.url))
const cameraSource = readFileSync(resolve(here, '../reolink-camera.ts'), 'utf8')

const NOW = 1_756_000_000_000

function findField(
  section: ReturnType<typeof buildOsdSection>,
  key: string,
): (typeof section.fields)[number] {
  const field = section.fields.find((f) => 'key' in f && f.key === key)
  if (!field) throw new Error(`field ${key} not found`)
  return field
}

describe('resolveOsdValues — unknown must survive, never become a default', () => {
  it('no snapshot at all → every toggle is null, never true', () => {
    const values = resolveOsdValues(undefined)
    expect(values.osdChannelEnabled).toBeNull()
    expect(values.osdTimeEnabled).toBeNull()
    expect(values.osdWatermark).toBeNull()
    expect(values.osdChannelName).toBe('')
  })

  it('camera answered but omitted the enable flags → null survives the ?? chain', () => {
    const snapshot: OsdSnapshot = {
      channelEnabled: null,
      timeEnabled: null,
      watermark: null,
      fetchedAt: NOW,
    }
    const values = resolveOsdValues(snapshot)
    expect(values.osdChannelEnabled).toBeNull()
    expect(values.osdTimeEnabled).toBeNull()
    expect(values.osdWatermark).toBeNull()
  })

  it('camera-reported OFF is served as OFF (the operator-reported bug)', () => {
    const snapshot: OsdSnapshot = {
      channelEnabled: false,
      channelName: '',
      timeEnabled: false,
      watermark: false,
      fetchedAt: NOW,
    }
    const values = resolveOsdValues(snapshot)
    expect(values.osdChannelEnabled).toBe(false)
    expect(values.osdTimeEnabled).toBe(false)
    expect(values.osdWatermark).toBe(false)
  })
})

describe('the camera is the ONLY authority — no second copy in the config (D62/D224)', () => {
  it('the config schema no longer stores the osd* keys — a stored value would be a shadow copy', () => {
    const parsed = reolinkCameraSchema.parse({
      host: '10.0.0.5',
      username: 'admin',
      password: 'pw',
      osdChannelEnabled: true,
      osdChannelName: 'shadow',
      osdTimeEnabled: true,
      osdWatermark: true,
    })
    // Zod strips unknown keys: a legacy stored override is dropped on the
    // next re-parse instead of shadowing the camera forever.
    expect('osdChannelEnabled' in parsed).toBe(false)
    expect('osdChannelName' in parsed).toBe(false)
    expect('osdTimeEnabled' in parsed).toBe(false)
    expect('osdWatermark' in parsed).toBe(false)
  })

  it('applySettingsPatch routes osd* keys straight to the camera, never into setAll', () => {
    // The osd keys are destructured OUT of the patch alongside the email
    // fields (the established "camera owns that state" pattern) before the
    // `...rest` that feeds `this.config.setAll(rest)`.
    expect(cameraSource).toMatch(
      /const \{[\s\S]{0,900}?osdChannelEnabled[\s\S]{0,200}?osdChannelName[\s\S]{0,200}?osdChannelPosition[\s\S]{0,200}?osdTimeEnabled[\s\S]{0,200}?osdTimePosition[\s\S]{0,200}?osdWatermark[\s\S]{0,900}?\.\.\.rest\s*\} = patch/,
    )
    expect(cameraSource).not.toMatch(/config\.get\('osdChannelPosition'\)/)
    expect(cameraSource).not.toMatch(/config\.get\('osdTimePosition'\)/)
    // And the settings form no longer reads a config copy of them.
    expect(cameraSource).not.toMatch(/config\.get\('osdChannelEnabled'\)/)
    expect(cameraSource).not.toMatch(/config\.get\('osdChannelName'\)/)
    expect(cameraSource).not.toMatch(/config\.get\('osdTimeEnabled'\)/)
    expect(cameraSource).not.toMatch(/config\.get\('osdWatermark'\)/)
  })

  it('a refused setOsd is visible per-camera and never stamped as fact', () => {
    const failLog = cameraSource.match(
      /logger\.warn\('osd push failed[^']*',\s*\{[\s\S]{0,200}?\}\)/,
    )
    expect(failLog).not.toBeNull()
    expect(failLog?.[0]).toContain('tags: { deviceId: this.id }')
    // The only writer of osdSnapshot is the getOsd probe — nothing stamps
    // the snapshot from the values the operator INTENDED to write.
    const stampSites = cameraSource.match(/cacheUpdate\.osdSnapshot = /g) ?? []
    expect(stampSites).toHaveLength(1)
    expect(cameraSource).not.toMatch(/osdSnapshot\s*=\s*\{[\s\S]{0,400}?typedPatch/)
  })

  it('registerOsdCap is defined — a missing method fails every camera restore', () => {
    // Deployed once with `this.registerOsdCap()` and no method: 7/26 devices
    // permanently failed restore (`registerOsdCap is not a function`),
    // rfc4571 stayed on stale loopback ports, recording stopped.
    expect(cameraSource).toMatch(/private registerOsdCap\(\): void \{/)
    expect(cameraSource).toMatch(/this\.registerOsdCap\(\)/)
  })
})

describe('isOsdSnapshotStale — the window belongs to the reader (D224)', () => {
  it('no snapshot → stale', () => {
    expect(isOsdSnapshotStale(undefined, NOW)).toBe(true)
  })

  it('legacy snapshot without fetchedAt (pre-freshness persist) → stale', () => {
    expect(isOsdSnapshotStale({ channelEnabled: true }, NOW)).toBe(true)
  })

  it('fresh snapshot → not stale; older than OPERATOR_WRITTEN_STALE_MS → stale', () => {
    expect(isOsdSnapshotStale({ fetchedAt: NOW - 1000 }, NOW)).toBe(false)
    expect(isOsdSnapshotStale({ fetchedAt: NOW - OPERATOR_WRITTEN_STALE_MS - 1 }, NOW)).toBe(true)
  })
})

describe('buildOsdSection — unknown renders disabled, never as ON', () => {
  it('unknown toggles are disabled with an honest description and a null default', () => {
    const values = resolveOsdValues(undefined)
    const section = buildOsdSection(undefined, values, { sleeping: false, now: NOW })
    for (const key of ['osdChannelEnabled', 'osdTimeEnabled', 'osdWatermark']) {
      const field = findField(section, key)
      if (field.type !== 'boolean') throw new Error(`${key} should be a boolean field`)
      expect(field.default).toBeNull()
      expect(field.disabled).toBe(true)
      expect(field.description).toMatch(/not reported/i)
    }
  })

  it('known values render as ordinary enabled switches', () => {
    const snapshot: OsdSnapshot = {
      channelEnabled: false,
      channelName: 'Front door',
      timeEnabled: true,
      watermark: false,
      fetchedAt: NOW,
    }
    const values = resolveOsdValues(snapshot)
    const section = buildOsdSection(snapshot, values, { sleeping: false, now: NOW })
    const channel = findField(section, 'osdChannelEnabled')
    if (channel.type !== 'boolean') throw new Error('expected boolean field')
    expect(channel.default).toBe(false)
    expect(channel.disabled).toBeUndefined()
  })

  it('awake + fresh snapshot → no state banner', () => {
    const snapshot: OsdSnapshot = { channelEnabled: true, fetchedAt: NOW }
    const values = resolveOsdValues(snapshot)
    const section = buildOsdSection(snapshot, values, { sleeping: false, now: NOW })
    expect(section.fields.some((f) => 'key' in f && f.key === 'osdSnapshotState')).toBe(false)
  })

  it('awake + never read → banner says the state has not been read', () => {
    const values = resolveOsdValues(undefined)
    const section = buildOsdSection(undefined, values, { sleeping: false, now: NOW })
    const banner = findField(section, 'osdSnapshotState')
    if (banner.type !== 'info') throw new Error('expected info banner')
    expect(banner.variant).toBe('warning')
    expect(banner.content).toMatch(/not been read/i)
  })

  it('sleeping battery cam + stale reading → banner names the last read and refuses to wake', () => {
    const snapshot: OsdSnapshot = {
      channelEnabled: true,
      fetchedAt: NOW - OPERATOR_WRITTEN_STALE_MS - 60_000,
    }
    const values = resolveOsdValues(snapshot)
    const section = buildOsdSection(snapshot, values, { sleeping: true, now: NOW })
    const banner = findField(section, 'osdSnapshotState')
    if (banner.type !== 'info') throw new Error('expected info banner')
    expect(banner.variant).toBe('warning')
    expect(banner.content).toMatch(/asleep/i)
    expect(banner.content).toMatch(/last read/i)
    expect(banner.content).toMatch(/never woken/i)
  })

  it('sleeping battery cam + never read → toggles stay unknown and the banner says why', () => {
    const values = resolveOsdValues(undefined)
    const section = buildOsdSection(undefined, values, { sleeping: true, now: NOW })
    const banner = findField(section, 'osdSnapshotState')
    if (banner.type !== 'info') throw new Error('expected info banner')
    expect(banner.content).toMatch(/asleep/i)
    expect(banner.content).toMatch(/never woken/i)
    const channel = findField(section, 'osdChannelEnabled')
    if (channel.type !== 'boolean') throw new Error('expected boolean field')
    expect(channel.default).toBeNull()
    expect(channel.disabled).toBe(true)
  })
})

describe('overlay positions — writable, from the vocabulary the cameras report', () => {
  /** Device 3825 as the operator configured it: name bottom-right, timestamp
   *  top-right, watermark on. Read through `getOsdDatetime` (cmd_id 44). */
  const SNAPSHOT_3825: OsdSnapshot = {
    channelEnabled: true,
    channelName: 'Magicam',
    channelX: 65_536,
    channelY: 65_536,
    timeEnabled: true,
    timeX: 65_536,
    timeY: 1,
    watermark: true,
    fetchedAt: NOW,
  }

  function positionField(snapshot: OsdSnapshot, key: string) {
    const section = buildOsdSection(snapshot, resolveOsdValues(snapshot), {
      sleeping: false,
      now: NOW,
    })
    const field = findField(section, key)
    if (field.type !== 'select') throw new Error(`${key} should be a select`)
    return field
  }

  it('both overlays get a WRITABLE position control, not a read-only info line', () => {
    const section = buildOsdSection(SNAPSHOT_3825, resolveOsdValues(SNAPSHOT_3825), {
      sleeping: false,
      now: NOW,
    })
    expect(section.fields.some((f) => 'key' in f && f.key === 'osdPositions')).toBe(false)
    expect(positionField(SNAPSHOT_3825, 'osdChannelPosition').type).toBe('select')
    expect(positionField(SNAPSHOT_3825, 'osdTimePosition').type).toBe('select')
  })

  it("device 3825's real placement is what the form shows", () => {
    expect(positionField(SNAPSHOT_3825, 'osdChannelPosition').default).toBe('bottom-right')
    expect(positionField(SNAPSHOT_3825, 'osdTimePosition').default).toBe('top-right')
  })

  it('only placements a camera was OBSERVED to hold are offered — never a guessed one', () => {
    // Six, not four: a capture of the Reolink app on 2026-09-19 caught it
    // writing `(65537, 1)` for top-centre and `(65537, 65536)` for
    // bottom-centre. `65537` is the CENTRE of an axis, and reading it as a
    // coordinate put it inside the far edge's tolerance — which is how every
    // centred overlay was being reported as right/bottom.
    //
    // A centred Y is still NOT offered: it has never been observed, and this
    // list exists precisely to keep values the camera might refuse off it.
    const field = positionField(SNAPSHOT_3825, 'osdChannelPosition')
    expect(field.options.map((o) => o.value)).toEqual([
      'top-left',
      'top-center',
      'top-right',
      'bottom-left',
      'bottom-center',
      'bottom-right',
    ])
    expect(field.disabled).toBeUndefined()
  })

  it('a hand-dragged placement keeps a "custom" option carrying the raw pair, so opening the form cannot move it', () => {
    const snapshot: OsdSnapshot = { ...SNAPSHOT_3825, channelX: 30_000, channelY: 40_000 }
    const field = positionField(snapshot, 'osdChannelPosition')
    expect(field.default).toBe('custom')
    expect(field.options[0]?.value).toBe('custom')
    expect(field.options[0]?.label).toContain('x=30000, y=40000')
  })

  it('an unreported anchor is a DISABLED select with a null default, never a corner nobody read', () => {
    const snapshot: OsdSnapshot = { channelEnabled: true, fetchedAt: NOW }
    const field = positionField(snapshot, 'osdChannelPosition')
    expect(field.default).toBeNull()
    expect(field.disabled).toBe(true)
    expect(field.description).toMatch(/not reported/i)
  })

  it('the config schema persists the anchors as nullable numbers', () => {
    const parsed = reolinkCameraSchema.parse({
      host: '10.0.0.5',
      username: 'admin',
      password: 'pw',
      deviceCache: {
        osdSnapshot: { channelX: 65_536, channelY: 65_536, timeX: null, fetchedAt: NOW },
      },
    })
    expect(parsed.deviceCache?.osdSnapshot?.channelX).toBe(65_536)
    expect(parsed.deviceCache?.osdSnapshot?.timeX).toBeNull()
  })

  it('the legacy `pos` strings are gone — they only ever held the placeholder read output', () => {
    const parsed = reolinkCameraSchema.parse({
      host: '10.0.0.5',
      username: 'admin',
      password: 'pw',
      deviceCache: { osdSnapshot: { channelPos: 'Lower Right', timePos: '', fetchedAt: NOW } },
    })
    const snapshot = parsed.deviceCache?.osdSnapshot ?? {}
    expect('channelPos' in snapshot).toBe(false)
    expect('timePos' in snapshot).toBe(false)
  })
})

describe('osdSnapshot freshness is persistable', () => {
  it('the config schema accepts and preserves fetchedAt', () => {
    const parsed = reolinkCameraSchema.parse({
      host: '10.0.0.5',
      username: 'admin',
      password: 'pw',
      deviceCache: { osdSnapshot: { channelEnabled: false, fetchedAt: NOW } },
    })
    expect(parsed.deviceCache?.osdSnapshot?.fetchedAt).toBe(NOW)
    expect(parsed.deviceCache?.osdSnapshot?.channelEnabled).toBe(false)
  })
})

describe('ReolinkCamera wiring (structural)', () => {
  it('the settings form resolves OSD values through resolveOsdValues — no ?? true left', () => {
    expect(cameraSource).toContain('resolveOsdValues(')
    expect(cameraSource).toContain('buildOsdSection(')
    // The exact coercions that rendered "the camera did not tell us" as ON.
    expect(cameraSource).not.toMatch(/osdSnapshot\?\.channelEnabled \?\? true/)
    expect(cameraSource).not.toMatch(/osdSnapshot\?\.timeEnabled \?\? true/)
    expect(cameraSource).not.toMatch(/osdSnapshot\?\.watermark \?\? false/)
  })

  it('the settings open revalidates a stale OSD slice behind the form', () => {
    expect(cameraSource).toContain('isOsdSnapshotStale(')
    expect(cameraSource).toContain("refreshParentSettingsSnapshot(new Set<SnapshotSlice>(['osd']))")
  })

  it('the OSD probe stamps freshness on success', () => {
    expect(cameraSource).toContain('cacheUpdate.osdSnapshot = projectOsdSnapshot(osd, Date.now())')
  })

  it('the OSD slice is read through the library OSD command, not a second copy of it', () => {
    // `getOsd` was the placeholder that issued cmd_id 26 (GetImage) and
    // grepped the ISP reply for OSD tags it does not carry — the whole
    // reported bug. It speaks cmd_id 44 as of the library's 0.7.0, so the
    // driver reads through it again. What must not come back is this driver
    // reaching past it: `getOsdDatetime`/`setOsdDatetime` are the raw pair,
    // and duplicating the corner encoding here is what D374 retired.
    expect(cameraSource).toContain('api.getOsd(channel')
    expect(cameraSource).not.toMatch(/api\.getOsdDatetime\(/)
    expect(cameraSource).not.toMatch(/api\.setOsdDatetime\(/)
  })

  it('a failed OSD probe is visible at info, tagged with the deviceId', () => {
    const failLog = cameraSource.match(
      /logger\.info\('reolink getOsd probe failed[^']*',\s*\{[\s\S]{0,200}?\}\)/,
    )
    expect(failLog).not.toBeNull()
    expect(failLog?.[0]).toContain('tags: { deviceId: this.id }')
  })

  it('a sleep-skipped snapshot refresh is visible at info', () => {
    expect(cameraSource).toMatch(
      /logger\.info\('refreshParentSettingsSnapshot skipped — battery cam is sleeping'/,
    )
  })

  it('the write path pushes ONLY the touched fields — the camera keeps the rest', () => {
    // `setOsd` read-modify-writes the camera's own XML, so the patch
    // must name nothing the operator did not change. A hand-built full
    // object here is what would overwrite an anchor, a language or a
    // background-colour flag nobody touched.
    expect(cameraSource).toContain('buildOsdPatch({')
    expect(cameraSource).toContain('await api.setOsd(this.getChannel(), osdPatch)')
    expect(cameraSource).not.toMatch(/next\.osdChannel/)
    expect(cameraSource).not.toMatch(/next\.osdTime/)
  })
})
