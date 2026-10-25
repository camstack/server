/**
 * The subscription topology, asserted at the KEY level.
 *
 * Why a test about map keys is worth having: the bus indexes handlers by ONE
 * category pattern per `subscribe` call (`extractCategoryPattern` —
 * `packages/system/src/kernel/moleculer/event-bus-core.ts`), and an array
 * `category` collapses to its FIRST element. A single subscribe listing ten
 * categories therefore registers ONE key, the child reports ONE key to its
 * parent, and the parent forwards only that one across the UDS boundary. Nine
 * categories are silently never delivered — no error, no log, and a
 * Notification Center that looks like it has no rules matching.
 *
 * So the contract this file pins is not "the addon subscribes to these
 * categories" but "the addon registers a DISTINCT KEY per category".
 */
import type { EventFilter, SystemEvent } from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { NC_SYSTEM_EVENT_CATEGORIES, wireSubscriptions } from '../wire-subscriptions.js'
import type { WireSubscriptionsDeps } from '../wire-subscriptions.js'

/**
 * Records subscriptions the way the real bus keys them: one map key per
 * `subscribe` call, taken from the filter's category exactly as
 * `extractCategoryPattern` takes it (array → first element only).
 */
class RecordingBus {
  readonly keys: string[] = []
  readonly handlersByKey = new Map<string, ((event: SystemEvent) => void)[]>()

  subscribe(filter: EventFilter | string, handler: (event: SystemEvent) => void): () => void {
    const key = RecordingBus.keyOf(filter)
    this.keys.push(key)
    const existing = this.handlersByKey.get(key) ?? []
    this.handlersByKey.set(key, [...existing, handler])
    return () => undefined
  }

  emit(): void {
    // The addon never emits through this seam; present so the fake satisfies
    // the structural shape the deps require.
  }

  getRecent(): readonly SystemEvent[] {
    return []
  }

  /** The kernel's keying rule, reproduced verbatim (array → first element). */
  private static keyOf(filter: EventFilter | string): string {
    if (typeof filter === 'string') return filter
    const category = filter.category
    if (typeof category === 'string') return category
    if (Array.isArray(category) && category.length > 0) return String(category[0])
    return '*'
  }
}

function deps(bus: RecordingBus, isPostProcessingNode: boolean): WireSubscriptionsDeps {
  const bound: WireSubscriptionsDeps['eventBus'] = {
    emit: () => bus.emit(),
    subscribe: (filter: EventFilter, handler: (event: SystemEvent) => void) =>
      bus.subscribe(filter, handler),
    getRecent: () => bus.getRecent(),
  }
  return {
    eventBus: bound,
    isPostProcessingNode,
    onInferenceResult: async () => undefined,
    onAudioResult: async () => undefined,
    onMotionAnalysis: async () => undefined,
    onOnboardMotion: async () => undefined,
    onSensorStateChanged: async () => undefined,
    onBindingsChanged: () => undefined,
    onDeviceUnregistered: () => undefined,
    onClusterTopology: () => undefined,
    onSystemEvent: () => undefined,
  }
}

describe('the system-event subscription topology', () => {
  it('registers a DISTINCT key for every category the Notification Center intake consumes', () => {
    const bus = new RecordingBus()
    wireSubscriptions(deps(bus, true))

    for (const category of NC_SYSTEM_EVENT_CATEGORIES) {
      expect(bus.keys, `no subscription key for ${category}`).toContain(category)
    }
  })

  it('names every category the intake can turn into a notification', () => {
    // The intake's switch is the authority; this list is what the wiring
    // promises to deliver to it. A category added there and not here is a
    // notification kind that can never fire.
    expect([...NC_SYSTEM_EVENT_CATEGORIES].toSorted()).toEqual(
      [
        EventCategory.AgentOffline,
        EventCategory.AgentOnline,
        // The alert centre's episode announcements (alert-critical, alert-error,
        // alert-critical-resolved) — the alert centre notifies nothing itself.
        EventCategory.AlertEpisode,
        EventCategory.AddonRunnerFailed,
        // Never notified: what revives a state-summary fault (D647 review I5).
        EventCategory.AddonRestarted,
        EventCategory.AddonStarted,
        EventCategory.PipelineCameraAssigned,
        EventCategory.AddonUpdated,
        // The RUN, not `BackupCompleted` which fires once per destination — an
        // operator with three destinations must be told once.
        EventCategory.BackupRunCompleted,
        EventCategory.DeviceDisabled,
        EventCategory.DeviceEnabled,
        EventCategory.DeviceOffline,
        EventCategory.DeviceOnline,
        EventCategory.DeviceStateChanged,
        // A notification rule that cannot work, and its clear (D905).
        EventCategory.NotificationRuleBroken,
        EventCategory.NotificationRuleRepaired,
        EventCategory.PipelineDetectionBlind,
        EventCategory.PipelineMotionCalm,
        EventCategory.PipelineMotionNoisy,
        EventCategory.PipelineNodeInferenceUnavailable,
        EventCategory.RecordingExportCompleted,
        EventCategory.RecordingHealthDegraded,
        EventCategory.RecordingHealthOk,
        EventCategory.RecordingHealthStalled,
        EventCategory.StorageLocationCritical,
        EventCategory.StorageLocationLow,
        EventCategory.StorageLocationOk,
        EventCategory.StreamOffline,
        EventCategory.StreamOnline,
        EventCategory.SystemRestartCompleted,
        // D723: an agent's restart announcement crosses only when declared.
        EventCategory.SystemRestarting,
        EventCategory.UpdateAvailable,
        EventCategory.WorkerOffline,
        EventCategory.WorkerOnline,
      ].toSorted(),
    )
  })

  it('routes every one of those keys to the system-event intake', () => {
    const bus = new RecordingBus()
    const seen: string[] = []
    const base = deps(bus, true)
    wireSubscriptions({
      ...base,
      onSystemEvent: (event: SystemEvent) => {
        seen.push(event.category)
      },
    })

    for (const category of NC_SYSTEM_EVENT_CATEGORIES) {
      const handlers = bus.handlersByKey.get(category) ?? []
      for (const handler of handlers) {
        handler({
          id: `e-${category}`,
          timestamp: new Date(0),
          source: { type: 'core', id: 'test' },
          category,
          data: {},
        })
      }
    }

    for (const category of NC_SYSTEM_EVENT_CATEGORIES) {
      expect(seen, `${category} never reached onSystemEvent`).toContain(category)
    }
  })

  it('installs none of them off the post-processing node', () => {
    const bus = new RecordingBus()
    wireSubscriptions(deps(bus, false))

    for (const category of NC_SYSTEM_EVENT_CATEGORIES) {
      // `device.state-changed` has no non-NC subscriber outside the processing
      // tier either, so the whole set is absent — the addon stays fully inert
      // on every other node.
      expect(bus.keys, `${category} must not install off the processing node`).not.toContain(
        category,
      )
    }
    // The two lifecycle subscriptions install everywhere, unchanged.
    expect(bus.keys).toContain(EventCategory.DeviceBindingsChanged)
    expect(bus.keys).toContain(EventCategory.DeviceUnregistered)
  })
})

/**
 * `DeviceUnregistered` drives a DESTRUCTIVE prune in the notification centre,
 * so its payload is read through a guard: a version-skewed emitter whose
 * `deviceId` is not an integer must reach NOTHING, never `NaN` or a string id.
 */
describe('the DeviceUnregistered payload', () => {
  function fire(data: Record<string, unknown>): number[] {
    const bus = new RecordingBus()
    const seen: number[] = []
    wireSubscriptions({
      ...deps(bus, false),
      onDeviceUnregistered: (deviceId) => {
        seen.push(deviceId)
      },
    })
    for (const handler of bus.handlersByKey.get(EventCategory.DeviceUnregistered) ?? []) {
      handler({
        id: 'e1',
        timestamp: new Date(0),
        source: { type: 'core', id: 'device-manager' },
        category: EventCategory.DeviceUnregistered,
        data,
      })
    }
    return seen
  }

  it('forwards an integer deviceId', () => {
    expect(fire({ deviceId: 102 })).toEqual([102])
  })

  it('drops a payload whose deviceId is missing or not an integer', () => {
    expect(fire({})).toEqual([])
    expect(fire({ deviceId: '102' })).toEqual([])
    expect(fire({ deviceId: 1.5 })).toEqual([])
  })
})
