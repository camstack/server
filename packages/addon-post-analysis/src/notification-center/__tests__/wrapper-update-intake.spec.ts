import { createEvent, DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { NcDeviceLookup } from '../device-directory.js'
import { incomingFromSystemEvent } from '../event-intake.js'
import { buildServerUpdateButtons, serverUpdateButtonRefusal } from '../server-update-buttons.js'
import { systemEventTapPath } from '../system-event-tap-url.js'
import { NC_LANGUAGES, NcTextCatalog } from '../text-catalog.js'

/**
 * The SHELL announcement (D437).
 *
 * `runningVersion` can be perfectly current while the container is 13 days old
 * from a repository nothing rebuilds — that was 2026-08-02, and every existing
 * surface said "up to date". This kind exists to say the opposite thing out
 * loud, and its body has to carry the ONE instruction that is actionable for
 * the shell it names, because no node can replace its own shell.
 */
const CAMERAS: NcDeviceLookup = (deviceId: number) => ({
  deviceId,
  type: DeviceType.Camera,
  name: 'Vialetto',
  isCamera: true,
})

function wrapperEvent(
  wrapperKind: 'contradictory' | 'docker' | 'electron' | 'native' | 'unknown',
  nodeId: string,
) {
  return createEvent(
    'update.available',
    { type: 'core', id: 'updates' },
    {
      target: 'wrapper',
      packageName: 'camstack-wrapper',
      currentVersion: '1.1.74',
      latestVersion: '1.2.32',
      nodeId,
      nodeIds: [nodeId],
      wrapperKind,
      packages: [
        {
          packageName: 'camstack-wrapper',
          currentVersion: '1.1.74',
          latestVersion: '1.2.32',
          nodeId,
        },
      ],
    },
  )
}

describe('wrapper-update-available intake', () => {
  it('is its OWN kind, not a server update — the versions are the shell, not the code', () => {
    const incoming = incomingFromSystemEvent(wrapperEvent('docker', 'hub'), CAMERAS)

    expect(incoming?.subject.systemEvent?.kind).toBe('wrapper-update-available')
    expect(incoming?.subject.systemEvent?.nodeId).toBe('hub')
    expect(incoming?.subject.systemEvent?.textParams).toMatchObject({
      currentVersion: '1.1.74',
      latestVersion: '1.2.32',
    })
  })

  it('picks the body by SHELL, so a docker node is told the command and an electron node is not', () => {
    const docker = incomingFromSystemEvent(wrapperEvent('docker', 'hub'), CAMERAS)
    const electron = incomingFromSystemEvent(wrapperEvent('electron', 'mac-mini'), CAMERAS)

    expect(docker?.subject.systemEvent?.bodyKey).toBe('system.wrapper-update-available.body.docker')
    expect(electron?.subject.systemEvent?.bodyKey).toBe(
      'system.wrapper-update-available.body.electron',
    )
  })

  it('falls back to the shell-agnostic body when the shell could not be identified', () => {
    const unknown = incomingFromSystemEvent(wrapperEvent('unknown', 'hub'), CAMERAS)
    // A missing `wrapperKind` (an older publisher) must land on the same
    // honest sentence rather than claiming a shell nobody observed.
    const absent = incomingFromSystemEvent(
      createEvent(
        'update.available',
        { type: 'core', id: 'updates' },
        {
          target: 'wrapper',
          packageName: 'camstack-wrapper',
          currentVersion: '1.1.74',
          latestVersion: '1.2.32',
          nodeId: 'hub',
          packages: [
            {
              packageName: 'camstack-wrapper',
              currentVersion: '1.1.74',
              latestVersion: '1.2.32',
              nodeId: 'hub',
            },
          ],
        },
      ),
      CAMERAS,
    )

    expect(unknown?.subject.systemEvent?.bodyKey).toBe('system.wrapper-update-available.body')
    expect(absent?.subject.systemEvent?.bodyKey).toBe('system.wrapper-update-available.body')
  })

  it('renders in both languages, and the docker sentence carries a runnable command', () => {
    const incoming = incomingFromSystemEvent(wrapperEvent('docker', 'hub'), CAMERAS)
    const event = incoming?.subject.systemEvent
    if (event === undefined) throw new Error('no system event')

    for (const language of NC_LANGUAGES) {
      const catalog = new NcTextCatalog({ language })
      const body = catalog.text({ key: event.bodyKey ?? '', vars: event.textParams ?? {} })
      // No node can pull its own image: the command IS the message.
      expect(body).toContain('docker')
      expect(body).toContain('1.2.32')
      const title = catalog.text({
        key: event.titleKey ?? '',
        vars: event.textParams ?? {},
        count: 1,
      })
      expect(title.length).toBeGreaterThan(0)
    }
  })

  it('tells an electron node it installs itself, and never hands it a docker command', () => {
    const incoming = incomingFromSystemEvent(wrapperEvent('electron', 'mac-mini'), CAMERAS)
    const event = incoming?.subject.systemEvent
    if (event === undefined) throw new Error('no system event')

    for (const language of NC_LANGUAGES) {
      const catalog = new NcTextCatalog({ language })
      const body = catalog.text({ key: event.bodyKey ?? '', vars: event.textParams ?? {} })
      expect(body).not.toContain('docker')
      expect(body).toContain('1.2.32')
    }
  })

  it('mints NO apply button — nothing can replace a shell from inside it', () => {
    const incoming = incomingFromSystemEvent(wrapperEvent('electron', 'mac-mini'), CAMERAS)
    const event = incoming?.subject.systemEvent
    if (event === undefined) throw new Error('no system event')

    expect(
      buildServerUpdateButtons({
        subject: {
          kind: event.kind,
          ...(event.nodeId !== undefined ? { nodeId: event.nodeId } : {}),
        },
        recipient: { ownerUserId: 'operator' },
        mintUrl: () => 'https://hub/apply',
        label: () => 'Apply',
      }),
    ).toEqual([])
    expect(
      serverUpdateButtonRefusal(
        { kind: event.kind, ...(event.nodeId !== undefined ? { nodeId: event.nodeId } : {}) },
        { ownerUserId: 'operator' },
      ),
    ).toBe('not-a-server-update')
  })

  it('taps through to the node card on the Cluster page, scoped to the node it names', () => {
    expect(systemEventTapPath({ kind: 'wrapper-update-available', nodeId: 'agent-a' })).toBe(
      '/system/nodes?node=agent-a',
    )
  })
})
