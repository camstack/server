import type { SystemEvent } from '@camstack/types'
import { createEvent, DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeTestSystemEvent } from '../../__tests__/support/events.js'
import type { NcDeviceLookup } from '../device-directory.js'
import { incomingFromSystemEvent } from '../event-intake.js'
import { NC_LANGUAGES, NcTextCatalog } from '../text-catalog.js'

/**
 * Every device these events name IS a camera, and the fixture says so — the
 * intake no longer assumes it (`system-event-device-kind.spec.ts`). The name is
 * a real one because the sentences below are the operator's: an id read out
 * loud is what this stopped doing.
 */
const CAMERAS: NcDeviceLookup = (deviceId: number) => ({
  deviceId,
  type: DeviceType.Camera,
  name: 'Vialetto',
  isCamera: true,
})

describe('system-event intake normalization', () => {
  it('normalizes device and stream liveness with device identity', () => {
    const camera = incomingFromSystemEvent(
      createEvent(
        'device.offline',
        { type: 'device', id: 104 },
        {
          deviceId: 104,
          providerId: 'reolink',
          reason: 'timeout',
        },
      ),
      CAMERAS,
    )
    expect(camera?.subject.systemEvent).toMatchObject({
      kind: 'device-offline',
      subject: 'device:104',
      titleKey: 'system.device-offline.title',
      bodyKey: 'system.device-offline.body',
      textParams: { deviceId: '104', deviceName: 'Vialetto' },
      deviceId: 104,
    })
    // The SENTENCE is not frozen — that is the whole point. A row that carried
    // one could never be re-worded or translated after enqueue.
    expect(camera?.subject.systemEvent?.title).toBeUndefined()
    expect(camera?.subject.systemEvent?.body).toBeUndefined()

    const stream = incomingFromSystemEvent(
      createEvent(
        'stream.online',
        { type: 'addon', id: 'stream-broker' },
        {
          deviceId: 104,
          camStreamId: 'cam-104-main',
          profile: 'high',
          brokerId: 'broker-1',
          // Only a genuine recovery is a notification — see the stream-health
          // gate (`stream-health-gate.spec.ts`).
          reason: 'recovered',
          sourceType: 'rtsp',
          lastPacketAt: 123,
        },
      ),
      CAMERAS,
    )
    expect(stream?.subject.systemEvent).toMatchObject({
      kind: 'stream-online',
      subject: 'stream:104',
      deviceId: 104,
    })

    const generic = incomingFromSystemEvent(
      {
        id: 'status-1',
        timestamp: new Date(123),
        source: { type: 'device', id: 102 },
        category: 'device.state-changed',
        data: {
          deviceId: 102,
          capName: 'device-status',
          slice: { online: false, lastChangedAt: 123 },
        },
      },
      CAMERAS,
    )
    expect(generic?.subject.systemEvent).toMatchObject({
      kind: 'device-offline',
      subject: 'device:102',
      deviceId: 102,
    })
  })

  it('normalizes agent liveness into the node family; a runner (worker) is no node (R1-H1)', () => {
    const event = incomingFromSystemEvent(
      createEvent('agent.offline', { type: 'core', id: 'cluster' }, { agentId: 'agent-a' }),
      CAMERAS,
    )
    expect(event?.subject.systemEvent).toMatchObject({
      kind: 'node-offline',
      subject: 'node:agent-a',
      nodeId: 'agent-a',
    })
    expect(event?.subject.deviceId).toBe(0)
    expect(
      incomingFromSystemEvent(
        createEvent(
          'worker.offline',
          { type: 'core', id: 'cluster' },
          { workerId: 'hub/notifiers' },
        ),
        CAMERAS,
      ),
    ).toBeNull()
  })

  it('normalizes addon/server updates and rejects malformed payloads', () => {
    const update = incomingFromSystemEvent(
      createEvent(
        'update.available',
        { type: 'core', id: 'updates' },
        {
          target: 'addon',
          packageName: '@camstack/addon-pipeline',
          currentVersion: '1.2.3',
          latestVersion: '1.2.4',
          packages: [
            {
              packageName: '@camstack/addon-pipeline',
              currentVersion: '1.2.3',
              latestVersion: '1.2.4',
            },
            {
              packageName: '@camstack/addon-provider-reolink',
              currentVersion: '1.0.0',
              latestVersion: '1.0.1',
            },
          ],
        },
      ),
      CAMERAS,
    )
    expect(update?.subject.systemEvent).toMatchObject({
      kind: 'addon-update-available',
      packageName: '@camstack/addon-pipeline',
      packageNames: ['@camstack/addon-pipeline', '@camstack/addon-provider-reolink'],
      textCount: 2,
      bodyKey: 'system.addon-update-available.body',
    })
    expect(update?.subject.systemEvent?.textParams?.['list']).toContain(
      '@camstack/addon-provider-reolink 1.0.0 → 1.0.1',
    )

    const agentUpdate = incomingFromSystemEvent(
      createEvent(
        'update.available',
        { type: 'core', id: 'updates' },
        {
          target: 'addon',
          packageName: '@camstack/addon-pipeline',
          currentVersion: '1.2.3',
          latestVersion: '1.2.4',
          nodeId: 'agent-a',
        },
      ),
      CAMERAS,
    )
    expect(agentUpdate?.subject.systemEvent).toMatchObject({
      nodeId: 'agent-a',
      bodyKey: 'system.addon-update-available.body',
      // The node is in the TITLE now, so the line is just the package.
      textParams: expect.objectContaining({ list: '@camstack/addon-pipeline 1.2.3 → 1.2.4' }),
    })
    expect(agentUpdate?.subject.systemEvent?.subject).not.toBe(update?.subject.systemEvent?.subject)

    const server = incomingFromSystemEvent(
      createEvent(
        'update.available',
        { type: 'core', id: 'updates' },
        {
          target: 'server',
          packageName: '@camstack/server',
          currentVersion: '1.0.1',
          latestVersion: '1.0.2',
          nodeIds: ['hub', 'agent-a'],
          packages: [
            {
              packageName: '@camstack/server',
              currentVersion: '1.0.1',
              latestVersion: '1.0.2',
              nodeId: 'hub',
            },
            {
              packageName: '@camstack/server',
              currentVersion: '1.0.1',
              latestVersion: '1.0.2',
              nodeId: 'agent-a',
            },
          ],
        },
      ),
      CAMERAS,
    )
    expect(server?.subject.systemEvent).toMatchObject({
      kind: 'server-update-available',
      bodyKey: 'system.server-update-available.body.onNodes',
      nodeIds: ['hub', 'agent-a'],
      textParams: expect.objectContaining({ nodes: 'hub, agent-a' }),
    })

    expect(
      incomingFromSystemEvent(
        {
          id: 'bad',
          timestamp: new Date(),
          source: { type: 'core', id: 'updates' },
          category: 'update.available',
          data: { target: 'addon' },
        },
        CAMERAS,
      ),
    ).toBeNull()
  })

  it('normalizes completed addon/server updates and a finished export', () => {
    const addons = incomingFromSystemEvent(
      createEvent(
        'addon.updated',
        { type: 'core', id: 'addons' },
        {
          addonId: 'pipeline-runner',
          packageName: '@camstack/addon-pipeline',
          fromVersion: '1.2.3',
          toVersion: '1.2.4',
        },
      ),
      CAMERAS,
    )
    expect(addons?.subject.systemEvent).toMatchObject({
      kind: 'addon-updated',
      textCount: 1,
      packageName: '@camstack/addon-pipeline',
    })
    expect(
      incomingFromSystemEvent(
        makeTestSystemEvent(
          'addon.updated',
          { type: 'addon', id: 'pipeline' },
          {
            addonId: 'pipeline',
            level: 'global',
          },
        ),
        CAMERAS,
      ),
    ).toBeNull()

    const server = incomingFromSystemEvent(
      createEvent(
        'system.restart-completed',
        { type: 'core', id: 'system' },
        {
          kind: 'framework-update',
          packageName: '@camstack/server',
          fromVersion: '1.0.1',
          toVersion: '1.0.2',
          requestedAt: 1,
          nodeId: 'agent-a',
        },
      ),
      CAMERAS,
    )
    expect(server?.subject.systemEvent).toMatchObject({
      kind: 'server-updated',
      nodeId: 'agent-a',
      bodyKey: 'system.server-updated.body',
    })
    expect(
      incomingFromSystemEvent(
        createEvent(
          'system.restart-completed',
          { type: 'core', id: 'system' },
          { kind: 'manual', requestedAt: 1, nodeId: 'hub' },
        ),
        CAMERAS,
      ),
    ).toBeNull()

    const exported = incomingFromSystemEvent(
      createEvent(
        'recording.export.completed',
        { type: 'addon', id: 'recorder' },
        { exportId: 'exp-1', fileBytes: 12_000, deviceId: 104, title: 'Hall' },
      ),
      CAMERAS,
    )
    expect(exported?.subject.systemEvent).toMatchObject({
      kind: 'export-completed',
      deviceId: 104,
      bodyKey: 'system.export-completed.body.titled',
    })
    expect(exported?.controls).toBeUndefined()

    const picked = incomingFromSystemEvent(
      createEvent(
        'recording.export.completed',
        { type: 'addon', id: 'recorder' },
        {
          exportId: 'exp-2',
          fileBytes: 1,
          deviceId: 104,
          notifyTargetIds: ['phone', 'telegram'],
        },
      ),
      CAMERAS,
    )
    expect(picked?.controls).toEqual({
      directTargetIds: ['phone', 'telegram'],
      bypassMute: true,
    })
  })
})

/**
 * The two update sentences the operator actually receives, rendered.
 *
 * Both were reported on 2026-08-19 from a real phone: "Server aggiornato" with
 * no versions at all, and THREE identical "aggiornamenti addon disponibili"
 * that named no node and listed the whole cluster each time.
 */
describe('an update notification names the node and the versions', () => {
  const texts = new NcTextCatalog({ language: 'it' })

  function sentence(event: SystemEvent): string {
    const system = incomingFromSystemEvent(event, CAMERAS)?.subject.systemEvent
    const vars = system?.textParams ?? {}
    const title = texts.text({
      key: system?.titleKey ?? '',
      vars,
      ...(system?.textCount !== undefined ? { count: system.textCount } : {}),
    })
    const body = texts.text({
      key: system?.bodyKey ?? '',
      vars,
      ...(system?.textCount !== undefined ? { count: system.textCount } : {}),
    })
    return `${title} — ${body}`
  }

  it('a completed server update reads node, previous version and new version', () => {
    expect(
      sentence(
        createEvent(
          'system.restart-completed',
          { type: 'core', id: 'system' },
          {
            kind: 'framework-update',
            packageName: '@camstack/server',
            fromVersion: '1.2.137',
            toVersion: '1.2.138',
            requestedAt: 1,
            nodeId: 'hub',
          },
        ),
      ),
    ).toBe('Server aggiornato — @camstack/server sul nodo hub è ora 1.2.138 (era 1.2.137)')
  })

  it('never drops a version it HAS because the other one is missing', () => {
    // The live 2026-08-19 marker, verbatim: a toVersion and no fromVersion.
    // It rendered "è stato aggiornato" — neither version, though one was known.
    expect(
      sentence(
        createEvent(
          'system.restart-completed',
          { type: 'core', id: 'system' },
          {
            kind: 'framework-update',
            packageName: '@camstack/server',
            toVersion: '1.2.138',
            requestedAt: 1,
            requestedBy: 'server-update: @camstack/server@1.2.138',
            nodeId: 'hub',
          },
        ),
      ),
    ).toBe('Server aggiornato — @camstack/server sul nodo hub è ora 1.2.138')
  })

  it('a completed ADDON update reads both versions and the node', () => {
    expect(
      sentence(
        makeTestSystemEvent(
          'addon.updated',
          { type: 'core', id: 'addons' },
          {
            addonId: 'terminal',
            packageName: '@camstack/addon-terminal',
            fromVersion: '0.1.47',
            toVersion: '0.1.51',
            nodeId: 'hub',
          },
        ),
      ),
    ).toBe('1 addon aggiornato — @camstack/addon-terminal 0.1.47 → 0.1.51 (hub)')
  })

  it('an UNKNOWN predecessor is left out of the sentence, not printed as a version', () => {
    // The emitter omits `fromVersion` when it cannot read what was there (a
    // first install, an unreadable tree). It used to send `'0.0.0'`, and the
    // operator read "@camstack/addon-terminal 0.0.0 → latest" as a fact. The
    // notification must still ARRIVE — the update happened — and must not
    // state a version nobody installed.
    const rendered = sentence(
      makeTestSystemEvent(
        'addon.updated',
        { type: 'core', id: 'addons' },
        {
          addonId: 'terminal',
          packageName: '@camstack/addon-terminal',
          toVersion: '0.1.51',
          nodeId: 'hub',
        },
      ),
    )
    expect(rendered).toBe('1 addon aggiornato — @camstack/addon-terminal → 0.1.51 (hub)')
    expect(rendered).not.toContain('0.0.0')
  })

  it('a SETTINGS save still carries no versions and is still not an update', () => {
    // `BaseAddon.updateGlobalSettings` emits `addon.updated` with neither
    // version. Relaxing `fromVersion` must not let those through — `toVersion`
    // is the discriminator, and a settings save is not a package update.
    expect(
      incomingFromSystemEvent(
        makeTestSystemEvent(
          'addon.updated',
          { type: 'addon', id: 'pipeline' },
          {
            addonId: 'pipeline',
            level: 'global',
          },
        ),
        CAMERAS,
      ),
    ).toBeNull()
  })

  it('a version-less restart under the server-update prefix is not an update', () => {
    // `RootUpdateService.restartNode` reuses the prefix for a PLAIN restart.
    expect(
      incomingFromSystemEvent(
        createEvent(
          'system.restart-completed',
          { type: 'core', id: 'system' },
          {
            kind: 'manual',
            requestedAt: 1,
            requestedBy: 'server-update: manual restart',
            nodeId: 'hub',
          },
        ),
        CAMERAS,
      ),
    ).toBeNull()
  })

  it('an addon-update list belongs to ONE node, and says which', () => {
    const event = createEvent(
      'update.available',
      { type: 'core', id: 'updates' },
      {
        target: 'addon',
        packageName: '@camstack/addon-pipeline',
        currentVersion: '1.2.3',
        latestVersion: '1.2.4',
        nodeId: 'agent-a',
        nodeIds: ['agent-a'],
        packages: [
          {
            packageName: '@camstack/addon-pipeline',
            currentVersion: '1.2.3',
            latestVersion: '1.2.4',
            nodeId: 'agent-a',
          },
          {
            packageName: '@camstack/addon-ai',
            currentVersion: '0.4.8',
            latestVersion: '0.4.13',
            nodeId: 'agent-a',
          },
        ],
      },
    )
    const system = incomingFromSystemEvent(event, CAMERAS)?.subject.systemEvent
    expect(system?.nodeId).toBe('agent-a')
    expect(system?.titleKey).toBe('system.addon-update-available.title.onNode')
    // The node is named ONCE, in the title — the lines below it are the list.
    expect(system?.textParams?.['list']).toBe(
      '@camstack/addon-pipeline 1.2.3 → 1.2.4\n@camstack/addon-ai 0.4.8 → 0.4.13',
    )
    expect(sentence(event)).toBe(
      '2 aggiornamenti addon disponibili su agent-a — ' +
        '@camstack/addon-pipeline 1.2.3 → 1.2.4\n@camstack/addon-ai 0.4.8 → 0.4.13',
    )
  })

  it('a multi-node list still names each node on its own line', () => {
    const system = incomingFromSystemEvent(
      createEvent(
        'update.available',
        { type: 'core', id: 'updates' },
        {
          target: 'addon',
          packageName: '@camstack/addon-pipeline',
          currentVersion: '1.2.3',
          latestVersion: '1.2.4',
          packages: [
            {
              packageName: '@camstack/addon-pipeline',
              currentVersion: '1.2.3',
              latestVersion: '1.2.4',
              nodeId: 'hub',
            },
            {
              packageName: '@camstack/addon-ai',
              currentVersion: '0.4.8',
              latestVersion: '0.4.13',
              nodeId: 'agent-a',
            },
          ],
        },
      ),
      CAMERAS,
    )?.subject.systemEvent
    expect(system?.titleKey).toBe('system.addon-update-available.title')
    expect(system?.textParams?.['list']).toBe(
      '@camstack/addon-pipeline 1.2.3 → 1.2.4 (hub)\n@camstack/addon-ai 0.4.8 → 0.4.13 (agent-a)',
    )
  })
})

/**
 * Every key a producer can freeze must EXIST in every language.
 *
 * The CI guard checks the two files against each other; this checks them
 * against the code that names them. A key the intake invents and no file
 * carries is the one failure mode the parity guard cannot see, and it delivers
 * a blank notification — so the sentence is rendered here, not just looked up.
 */
describe('every frozen key resolves, in every language', () => {
  const events: readonly SystemEvent[] = [
    createEvent(
      'device.offline',
      { type: 'device', id: 104 },
      {
        deviceId: 104,
        providerId: 'reolink',
      },
    ),
    createEvent(
      'device.online',
      { type: 'device', id: 104 },
      {
        deviceId: 104,
        providerId: 'reolink',
      },
    ),
    {
      id: 'status-1',
      timestamp: new Date(123),
      source: { type: 'device', id: 102 },
      category: 'device.state-changed',
      data: {
        deviceId: 102,
        capName: 'device-status',
        slice: { online: true, lastChangedAt: 1 },
      },
    },
    createEvent(
      'stream.online',
      { type: 'addon', id: 'stream-broker' },
      {
        deviceId: 104,
        camStreamId: 'cam-104-main',
        profile: 'high',
        brokerId: 'broker-1',
        sourceType: 'rtsp',
        lastPacketAt: 123,
        reason: 'recovered',
      },
    ),
    // …and the same stream event with NO profile: a different key, deliberately.
    createEvent(
      'stream.offline',
      { type: 'addon', id: 'stream-broker' },
      {
        deviceId: 104,
        camStreamId: 'cam-104-main',
        profile: null,
        brokerId: 'broker-1',
        sourceType: 'rtsp',
        lastPacketAt: 123,
        reason: 'stale-timeout',
      },
    ),
    createEvent('agent.online', { type: 'core', id: 'cluster' }, { agentId: 'agent-a' }),
    // A runner (`worker.*`) is no node and freezes no key (R1-H1): both node keys are the agent's.
    createEvent('agent.offline', { type: 'core', id: 'cluster' }, { agentId: 'agent-a' }),
    createEvent(
      'update.available',
      { type: 'core', id: 'updates' },
      {
        target: 'addon',
        packageName: '@camstack/addon-pipeline',
        currentVersion: '1.2.3',
        latestVersion: '1.2.4',
      },
    ),
    createEvent(
      'update.available',
      { type: 'core', id: 'updates' },
      {
        target: 'server',
        packageName: '@camstack/server',
        currentVersion: '1.0.1',
        latestVersion: '1.0.2',
        nodeId: 'agent-a',
      },
    ),
    createEvent(
      'addon.updated',
      { type: 'core', id: 'addons' },
      {
        addonId: 'pipeline-runner',
        packageName: '@camstack/addon-pipeline',
        fromVersion: '1.2.3',
        toVersion: '1.2.4',
      },
    ),
    createEvent(
      'system.restart-completed',
      { type: 'core', id: 'system' },
      {
        kind: 'framework-update',
        packageName: '@camstack/server',
        fromVersion: '1.0.1',
        toVersion: '1.0.2',
        requestedAt: 1,
        nodeId: 'hub',
      },
    ),
    // …and the same update with only the version it went TO.
    createEvent(
      'system.restart-completed',
      { type: 'core', id: 'system' },
      {
        kind: 'framework-update',
        packageName: '@camstack/server',
        toVersion: '1.0.2',
        requestedAt: 1,
        nodeId: 'hub',
      },
    ),
    // An addon list scoped to one node: a different title key, deliberately.
    createEvent(
      'update.available',
      { type: 'core', id: 'updates' },
      {
        target: 'addon',
        packageName: '@camstack/addon-pipeline',
        currentVersion: '1.2.3',
        latestVersion: '1.2.4',
        nodeId: 'agent-a',
        nodeIds: ['agent-a'],
      },
    ),
    createEvent(
      'recording.export.completed',
      { type: 'addon', id: 'recorder' },
      { exportId: 'exp-1', fileBytes: 12_000, deviceId: 104, title: 'Hall' },
    ),
  ]

  for (const language of NC_LANGUAGES) {
    it(`renders a non-empty title and body for every intake variant (${language})`, () => {
      const texts = new NcTextCatalog({ language })
      let checked = 0
      for (const event of events) {
        const incoming = incomingFromSystemEvent(event, CAMERAS)
        const system = incoming?.subject.systemEvent
        expect(system).toBeDefined()
        if (system === undefined) continue
        expect(system.titleKey).toBeDefined()
        expect(system.bodyKey).toBeDefined()
        const vars = system.textParams ?? {}
        expect(texts.text({ key: system.titleKey ?? '', vars })).not.toBe('')
        expect(texts.text({ key: system.bodyKey ?? '', vars })).not.toBe('')
        // …and every placeholder was filled: a leftover gap means a param the
        // intake did not freeze.
        expect(texts.text({ key: system.bodyKey ?? '', vars })).not.toContain('  ')
        checked += 1
      }
      expect(checked).toBe(events.length)
    })
  }

  it('the profiled and unprofiled stream bodies are different sentences', () => {
    const texts = new NcTextCatalog({ language: 'it' })
    const withProfile = incomingFromSystemEvent(events[3] as SystemEvent, CAMERAS)?.subject
      .systemEvent
    const without = incomingFromSystemEvent(events[4] as SystemEvent, CAMERAS)?.subject.systemEvent
    expect(
      texts.text({
        key: withProfile?.bodyKey ?? '',
        vars: withProfile?.textParams ?? {},
      }),
    ).toBe('Lo stream high della camera Vialetto è di nuovo online')
    expect(
      texts.text({
        key: without?.bodyKey ?? '',
        vars: without?.textParams ?? {},
      }),
    ).toBe('Lo stream della camera Vialetto è offline')
  })

  it('the node keys are the agent`s, in both directions (a runner is no node, R1-H1)', () => {
    const texts = new NcTextCatalog({ language: 'it' })
    const online = incomingFromSystemEvent(events[5] as SystemEvent, CAMERAS)?.subject.systemEvent
    const offline = incomingFromSystemEvent(events[6] as SystemEvent, CAMERAS)?.subject.systemEvent
    expect(texts.text({ key: online?.bodyKey ?? '', vars: online?.textParams ?? {} })).toBe(
      "L'agent agent-a è di nuovo online",
    )
    expect(texts.text({ key: offline?.bodyKey ?? '', vars: offline?.textParams ?? {} })).toBe(
      "L'agent agent-a è offline",
    )
  })
})

describe('recording and storage location intake', () => {
  it('maps recording.health.stalled / ok / degraded onto NC kinds', () => {
    const stalled = incomingFromSystemEvent(
      createEvent(
        'recording.health.stalled',
        { type: 'addon', id: 'recorder' },
        { deviceId: 101, idleMs: 300_000, thresholdMs: 300_000 },
      ),
      CAMERAS,
    )
    expect(stalled?.subject.systemEvent).toMatchObject({
      kind: 'recording-stalled',
      subject: 'recording:101',
      deviceId: 101,
      textParams: { deviceId: '101', deviceName: 'Vialetto', minutes: '5' },
    })

    const ok = incomingFromSystemEvent(
      createEvent('recording.health.ok', { type: 'addon', id: 'recorder' }, { deviceId: 101 }),
      CAMERAS,
    )
    expect(ok?.subject.systemEvent).toMatchObject({
      kind: 'recording-healthy',
      subject: 'recording:101',
    })

    const degraded = incomingFromSystemEvent(
      createEvent(
        'recording.health.degraded',
        { type: 'addon', id: 'recorder' },
        { deviceId: 101, message: 'writer gave up' },
      ),
      CAMERAS,
    )
    expect(degraded?.subject.systemEvent).toMatchObject({
      kind: 'recording-degraded',
      subject: 'recording-degraded:101',
      textParams: expect.objectContaining({ message: 'writer gave up' }),
    })
  })

  it('maps storage.location.* onto NC kinds with a shared subject', () => {
    const critical = incomingFromSystemEvent(
      createEvent(
        'storage.location.critical',
        { type: 'addon', id: 'storage-orchestrator' },
        {
          locationId: 'recordings:default',
          nodeId: 'hub',
          locationName: 'Recordings',
          freePercent: null,
          reason: 'capacity-unreadable',
        },
      ),
      CAMERAS,
    )
    expect(critical?.subject.systemEvent).toMatchObject({
      kind: 'storage-location-critical',
      subject: 'storage-location:recordings:default',
      nodeId: 'hub',
      textParams: expect.objectContaining({
        locationName: 'Recordings',
        reason: 'capacity-unreadable',
      }),
    })

    const recovered = incomingFromSystemEvent(
      createEvent(
        'storage.location.ok',
        { type: 'addon', id: 'storage-orchestrator' },
        { locationId: 'recordings:default', nodeId: 'hub', locationName: 'Recordings' },
      ),
      CAMERAS,
    )
    expect(recovered?.subject.systemEvent).toMatchObject({
      kind: 'storage-location-ok',
      subject: 'storage-location:recordings:default',
    })
  })
})

describe('D905 — a notification rule that cannot work', () => {
  it('maps broken and repaired onto ONE subject per rule, with a sentence per reason', () => {
    const texts = new NcTextCatalog({ language: 'en' })
    const broken = incomingFromSystemEvent(
      createEvent(
        'notification.rule-broken',
        { type: 'addon', id: 'notification-center' },
        {
          ruleId: 'r-robot',
          ruleName: 'Robot',
          reason: 'device-deleted',
          reasons: [{ code: 'device-deleted', ids: ['4483'] }],
          offendingIds: ['4483'],
        },
      ),
      CAMERAS,
    )?.subject.systemEvent
    expect(broken).toMatchObject({ kind: 'rule-broken', subject: 'rule-health:r-robot' })
    expect(texts.text({ key: broken?.bodyKey ?? '', vars: broken?.textParams ?? {} })).toBe(
      'The rule "Robot" still names a deleted device (4483) and was switched off. Pick the device again.',
    )

    const repaired = incomingFromSystemEvent(
      createEvent(
        'notification.rule-repaired',
        { type: 'addon', id: 'notification-center' },
        { ruleId: 'r-robot', ruleName: 'Robot' },
      ),
      CAMERAS,
    )?.subject.systemEvent
    expect(repaired).toMatchObject({ kind: 'rule-repaired', subject: 'rule-health:r-robot' })
  })
})
