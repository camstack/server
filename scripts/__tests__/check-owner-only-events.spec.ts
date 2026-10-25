/**
 * D224/D663 — the owner-only-events guard, on fixtures.
 *
 * Two structural rules. (a) Only the composer SUBSCRIBES to the native shadow
 * (`device.native-shadow-changed`): the enum defines it, the mirror emits it,
 * nobody else names it. (b) Every event history read (`getRecent(`) and every
 * bus subscription (`.subscribe(` on a bus) under `server/backend/src/api/**`
 * filters with `isPublicEvent` — the eighth public path was found by a review,
 * not by a test, because a raw forwarder subscribes to nothing BY NAME. Each
 * rule goes red on its fixture; the last test runs the real tree, where the
 * eight known paths pass.
 */
import { describe, expect, it } from 'vitest'
import { itRealTree } from './lib/real-tree.js'
import {
  checkOwnerOnlyEventFacts,
  collectOwnerOnlyEventFiles,
  type GuardFile,
} from '../owner-only-events-guard.ts'
import { stripComments } from '../lib/walk-sources.ts'

/** A fixture as the walker would hand it over: comments blanked. */
const file = (rel: string, text: string): GuardFile => ({ rel, code: stripComments(text) })

const FILTERED_SUBSCRIBE = `
  return iterableSubscription<SystemEvent>((push) => {
    return eb.subscribe(filter, (evt) => {
      if (isPublicEvent(evt)) push(evt)
    })
  })`

describe('rule (a): only the composer subscribes to the native shadow', () => {
  it('passes the definer, the emitter and the composer', () => {
    expect(
      checkOwnerOnlyEventFacts([
        file(
          'packages/types/src/enums/event-category.ts',
          "DeviceNativeShadowChanged = 'device.native-shadow-changed'",
        ),
        file(
          'packages/system/src/builtins/device-manager/device-state-mirror.ts',
          'EventCategory.DeviceNativeShadowChanged',
        ),
        file(
          'packages/system/src/builtins/composer/source-tracker.ts',
          'category: EventCategory.DeviceNativeShadowChanged',
        ),
        file(
          'packages/system/src/builtins/x/__tests__/y.spec.ts',
          'EventCategory.DeviceNativeShadowChanged',
        ),
      ]),
    ).toEqual([])
  })

  it('refuses any other subscriber, by enum member or by string', () => {
    const failures = checkOwnerOnlyEventFacts([
      file(
        'packages/addon-provider-homeassistant/src/x.ts',
        'eb.subscribe({ category: EventCategory.DeviceNativeShadowChanged }, h)',
      ),
      file('packages/ui-library/src/y.tsx', "useEvents('device.native-shadow-changed')"),
    ])
    expect(failures).toHaveLength(2)
    expect(failures[0]).toMatch(/addon-provider-homeassistant\/src\/x\.ts/)
    expect(failures[1]).toMatch(/ui-library\/src\/y\.tsx/)
  })
})

describe('rule (b): every public event path filters with isPublicEvent', () => {
  it('passes a filtered subscription and the publicRecent definer', () => {
    expect(
      checkOwnerOnlyEventFacts([
        file('server/backend/src/api/core/live-events.router.ts', FILTERED_SUBSCRIBE),
        file(
          'server/backend/src/api/core/public-event-filter.ts',
          'source.getRecent(filter).filter(isPublicEvent)',
        ),
        file(
          'server/backend/src/api/core/system-events.router.ts',
          'return publicRecent(eb, filter, input.limit, keep).map(serialize)',
        ),
      ]),
    ).toEqual([])
  })

  it('refuses a raw history read', () => {
    const failures = checkOwnerOnlyEventFacts([
      file(
        'server/backend/src/api/core/new.router.ts',
        'return eventBus.getRecent(filter, input.limit).map(serialize)',
      ),
    ])
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatch(/new\.router\.ts/)
    expect(failures[0]).toMatch(/getRecent/)
  })

  it('refuses an unfiltered bus subscription, however the bus is named', () => {
    const failures = checkOwnerOnlyEventFacts([
      file(
        'server/backend/src/api/core/new.router.ts',
        'return eb.subscribe(filter, (evt) => push(evt))',
      ),
      file(
        'server/backend/src/api/core/other.router.ts',
        'ctx.eventBus.subscribe({}, (evt) => { push(serialize(evt)) })',
      ),
    ])
    expect(failures).toHaveLength(2)
    expect(failures[0]).toMatch(/subscribe/)
  })

  it('a predicate OUTSIDE the call does not count — the filter must be in the handler', () => {
    const failures = checkOwnerOnlyEventFacts([
      file(
        'server/backend/src/api/core/new.router.ts',
        'const keep = isPublicEvent\nreturn eb.subscribe(filter, (evt) => push(evt))',
      ),
    ])
    expect(failures).toHaveLength(1)
  })

  it('ignores subscriptions that are not to the event bus, and files outside api/**', () => {
    expect(
      checkOwnerOnlyEventFacts([
        file(
          'server/backend/src/api/core/logs.router.ts',
          'return logging.subscribe((line) => push(line))',
        ),
        file(
          'server/backend/src/api/core/cap-providers.ts',
          'toastService.subscribe(connectionId, userId, (toast) => push(toast))',
        ),
        file(
          'server/backend/src/api/trpc/generated-cap-routers.ts',
          'return p.subscribe(methodInput as any)',
        ),
        file('server/backend/src/core/x.ts', 'eb.subscribe(filter, (evt) => push(evt))'),
      ]),
    ).toEqual([])
  })

  itRealTree('the real tree passes — the eight known public paths are filtered', () => {
    expect(checkOwnerOnlyEventFacts(collectOwnerOnlyEventFiles())).toEqual([])
  })
})
