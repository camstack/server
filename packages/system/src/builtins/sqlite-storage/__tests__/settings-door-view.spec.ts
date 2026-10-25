/**
 * Caller-side acceptance for isolating sqlite-settings: an `await` of the
 * settings door must look like the yielding control, not like the engine burst.
 *
 * In-process `createDataStoreDispatch(backend)` does NOT count — `async set`
 * still runs `Statement.run` on this isolate before the promise settles. The
 * door that isolate produces is a UDS hop; this spec uses a timer-shaped door
 * as the same await boundary.
 */
import { describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach } from 'vitest'
import { createDataStoreDispatch } from '../../storage-orchestrator/data-store-dispatch.js'
import { SqliteSettingsBackend } from '../sqlite-settings-backend.js'
import { createDoorSettingsView } from '../../../kernel/settings-door-view.js'

/** Event-loop turns that must pass while the door is still pending. */
const LOOP_TURNS_WHILE_PENDING = 10

/** The door the test holds open: how often the view called it, and how to answer. */
interface DoorGate {
  calls: number
  release: () => void
}

const tmpDirs: string[] = []

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

describe('settings door view occupies sqlite through an await', () => {
  it('round-trips runtime state through the door, not ISettingsStore', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sqlite-door-view-'))
    tmpDirs.push(dir)
    const backend = new SqliteSettingsBackend(path.join(dir, 'camstack.db'))
    await backend.initialize()
    const door = createDataStoreDispatch(() => [backend])
    const view = createDoorSettingsView('device-manager', door, {
      getSection: async () => ({}),
      setSection: () => undefined,
    })

    await view.writeDeviceRuntimeState(101, { battery: { percentage: 41 } })
    await expect(view.readDeviceRuntimeState(101)).resolves.toEqual({
      battery: { percentage: 41 },
    })
    await view.writeAddonStore({ nextDeviceId: 900 })
    await expect(view.readAddonStore()).resolves.toMatchObject({ nextDeviceId: 900 })
    await backend.shutdown()
  })

  // Deterministic rather than measured: an earlier version timed a 40 ms
  // timer door against an event-loop probe, and a loaded CI runner paused the
  // loop for 21 ms on its own — a wall-clock threshold judged the machine, not
  // the view. The claim is structural: the engine never runs in this isolate,
  // the view hands the write to the door exactly once, and the loop keeps
  // turning for as long as the door has not answered.
  it('an awaiting door looks like a timer, not like Statement.run', async () => {
    const door = createDataStoreDispatch(() => {
      throw new Error('in-process engine must not run — isolate is the await')
    })
    const gate: DoorGate = { calls: 0, release: () => undefined }
    const yielding = {
      ...door,
      set: async () => {
        gate.calls += 1
        await new Promise<void>((resolve) => {
          gate.release = resolve
        })
      },
    }
    const view = createDoorSettingsView('device-manager', yielding, {
      getSection: async () => ({}),
      setSection: () => undefined,
    })
    let settled = false
    const write = view.writeDeviceRuntimeState(101, { battery: { percentage: 1 } }).then(() => {
      settled = true
    })

    for (let turn = 0; turn < LOOP_TURNS_WHILE_PENDING; turn++) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve)
      })
    }
    expect(gate.calls).toBe(1)
    expect(settled).toBe(false)

    gate.release()
    await write
    expect(settled).toBe(true)
  })
})
