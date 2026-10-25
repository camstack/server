import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/**
 * Reolink battery-cam scheduled full refresh (D847) — the wiring.
 *
 * The behaviour itself (windows, wake deadline, retry bound, single flight) is
 * driven on a fake clock in `battery-hourly-refresh.spec.ts`. What is pinned
 * HERE is structural: a 60 s in-memory check armed for every battery camera
 * (standalone and hub child), delegating to the controller, whose refresh
 * reads every fact and the snapshot, serialised.
 *
 * Source-structure assertions, for the same reason as the sibling battery
 * specs: constructing a real `ReolinkCamera` needs the whole `DeviceContext`.
 */

const here = dirname(fileURLToPath(import.meta.url))
const cameraSource = readFileSync(resolve(here, '../reolink-camera.ts'), 'utf8')

function sliceMethodBody(source: string, methodSignature: string): string {
  const start = source.indexOf(methodSignature)
  if (start === -1) throw new Error(`method not found: ${methodSignature}`)
  let depth = 0
  let i = source.indexOf('{', start)
  if (i === -1) throw new Error(`opening brace not found for ${methodSignature}`)
  const bodyStart = i
  for (; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(bodyStart, i + 1)
    }
  }
  throw new Error(`closing brace not found for ${methodSignature}`)
}

describe('Reolink battery-cam scheduled full refresh — wiring', () => {
  it('declares the timer field, and no second in-flight guard beside the controller', () => {
    expect(cameraSource).toContain('private batteryUpdateTimer')
    expect(cameraSource).not.toContain('batteryUpdateInFlight')
  })

  describe('startBatteryUpdatePolling', () => {
    const body = sliceMethodBody(cameraSource, 'private startBatteryUpdatePolling()')

    it('is idempotent (early-returns if timer already armed)', () => {
      expect(body).toMatch(/if\s*\(this\.batteryUpdateTimer\)\s*return/)
    })

    it('gates on isBattery (no-op for wired cams)', () => {
      expect(body).toMatch(/if\s*\(!this\.isBattery\)\s*return/)
    })

    it('does NOT gate on isHubChild — hub-child battery cams arm the timer too', () => {
      expect(body).not.toMatch(/if\s*\(this\.isHubChild\(\)\)\s*return/)
    })

    it('arms a setInterval at the cheap tick, not at the window', () => {
      expect(body).toContain('setInterval')
      expect(body).toContain('BATTERY_REFRESH_TICK_MS')
    })

    it('calls runBatteryUpdate on each fire and unrefs the timer', () => {
      expect(body).toContain('this.runBatteryUpdate()')
      expect(body).toContain('this.batteryUpdateTimer.unref()')
    })
  })

  describe('runBatteryUpdate', () => {
    const body = sliceMethodBody(cameraSource, 'private async runBatteryUpdate()')

    it('only delegates to the controller — it never reaches the camera itself', () => {
      expect(body).toContain('this.getBatteryRefresh().tick()')
      expect(body).not.toContain('ensureApi')
    })
  })

  describe('the controller wiring', () => {
    const body = sliceMethodBody(cameraSource, 'private getBatteryRefresh()')

    it('wakes only through the existing wake path, and stamps the battery slice', () => {
      expect(body).toContain("this.canProactivelyWake('scheduled-refresh')")
      expect(body).toContain('return this.wakeIfSleeping()')
      expect(body).toContain('this.state.battery.lastFullRefreshAt = at')
    })

    it('reads the window from the per-device setting', () => {
      expect(body).toContain("this.config.get('batteryRefreshMinutes')")
    })
  })

  describe('refreshEverythingNow', () => {
    const body = sliceMethodBody(cameraSource, 'private async refreshEverythingNow()')

    it('reads every fact and the snapshot, SEQUENTIALLY (one round-trip at a time on BCUDP)', () => {
      expect(body).not.toContain('Promise.all')
      const order = [
        "refreshBatteryFromApi('demand')",
        'populateMetadataFromFirmware',
        'warmCapSlicesOnWake({ force: true })',
        "alignAuxDevicesState('wake')",
        "refreshParentSettingsSnapshot(undefined, 'scheduled')",
        'refreshSnapshotCache()',
      ].map((needle) => body.indexOf(needle))
      for (const idx of order) expect(idx).toBeGreaterThan(-1)
      expect([...order].sort((x, y) => x - y)).toEqual(order)
    })

    it('names every step that did not land instead of swallowing it', () => {
      expect(body).toContain('failed.push(name)')
    })
  })

  describe('lifecycle wiring', () => {
    it('starts the timer alongside startSleepPoll in the adoptApi battery branch', () => {
      // The adoptApi battery path is the one that uses persistedDeviceType
      // and calls api.setIdleDisconnect(true). Find that block and assert
      // both startSleepPoll and startBatteryUpdatePolling fire inside it.
      const marker = "persistedDeviceType === 'battery-cam'"
      const occurrences: number[] = []
      let cursor = 0
      while (true) {
        const found = cameraSource.indexOf(marker, cursor)
        if (found === -1) break
        occurrences.push(found)
        cursor = found + marker.length
      }
      expect(occurrences.length).toBeGreaterThanOrEqual(1)
      for (const start of occurrences) {
        const block = cameraSource.slice(start, start + 1500)
        if (block.includes('this.startSleepPoll()')) {
          expect(block).toContain('this.startBatteryUpdatePolling()')
        }
      }
    })

    it('starts the timer alongside startSleepPoll in the full-login battery branch', () => {
      // The full-login battery branch is the one immediately AFTER live
      // probe / persisted-flag resolution. It calls startSleepPoll +
      // registerBatteryIfSupported + refreshBatteryFromApi.
      const blockStart = cameraSource.indexOf(
        'if (this.isBattery) {\n        this.startSleepPoll()',
      )
      expect(blockStart).toBeGreaterThan(-1)
      const block = cameraSource.slice(blockStart, blockStart + 600)
      expect(block).toContain('this.startBatteryUpdatePolling()')
    })

    it('arms the timer at construction time too — covers hub-child battery cams', () => {
      // Hub-child battery cams never go through `adoptApi`/`login`
      // (they borrow the parent Hub's socket). The constructor-time
      // `hasBattery` / persisted `battery-cam` branch must arm the
      // timer or those cams never get periodic refresh.
      const blockStart = cameraSource.indexOf(
        "cache?.deviceType === 'battery-cam' || cache?.hasBattery === true",
      )
      expect(blockStart).toBeGreaterThan(-1)
      const block = cameraSource.slice(blockStart, blockStart + 1500)
      expect(block).toContain('this.startBatteryUpdatePolling()')
    })

    it('stops the timer in disconnectAll', () => {
      const body = sliceMethodBody(cameraSource, 'async disconnectAll()')
      expect(body).toContain('this.stopBatteryUpdatePolling()')
    })
  })
})
