/**
 * Integration test for directive scope enforcement.
 *
 * Drives `dispatchDirective` directly and verifies that the scope gate
 * rejects or passes directives based on `callerIdentity.scopes`, WITHOUT
 * invoking any handler for rejected directives. All 4 cases are fully
 * asserted — the two rejection cases (1 and 3) are the security-critical
 * ones; the passing cases (2 and 4) additionally verify handler
 * reachability via spies.
 */

import type { AddonContext, IScopedLogger, TokenScope } from '@camstack/types'
import { describe, expect, it, type MockedFunction, vi } from 'vitest'
import {
  type DirectiveRouterDeps,
  dispatchDirective,
  type VerifiedDirectiveIdentity,
} from '../directive-router.js'
import type { ExposedDeviceEntry } from '../types.js'
import { allowAllAccess, snapshotsOff, visionOff } from './helpers/allow-all-access.js'

// ── Shared test fixtures ────────────────────────────────────────────

const BASE_HEADER = {
  payloadVersion: '3',
  messageId: 'msg-test-001',
}

const VIEW_ONLY_SCOPES: readonly TokenScope[] = [
  { type: 'category', target: 'device', access: ['view'] },
]

const CONTROL_SCOPES: readonly TokenScope[] = [
  { type: 'category', target: 'device', access: ['view', 'create'] },
]

const EMPTY_SCOPES: readonly TokenScope[] = []

function makeIdentity(scopes: readonly TokenScope[]): VerifiedDirectiveIdentity {
  return { userId: 'user-42', username: 'tester', scopes }
}

// ── Minimal stub builder ────────────────────────────────────────────
//
// Handlers that are blocked by the scope gate are NEVER reached, so
// their context fields only need to satisfy TypeScript's structural
// checks — they are never actually called.
//
// Handlers we DO expect to be reached carry observable spies.

// Spy signatures match the real handler-context callback shapes so the
// stubs are assignable without any cast.
type ListExposedSpy = MockedFunction<() => Promise<readonly ExposedDeviceEntry[]>>

interface StubDepsOptions {
  readonly listExposedForDiscovery?: ListExposedSpy
}

function makeMinimalDeps(opts: StubDepsOptions = {}): DirectiveRouterDeps {
  // Minimal AddonContext stub — the handlers exercised here are either
  // blocked by the scope gate (never reached) or return INVALID_DIRECTIVE
  // for a bare camera endpointId BEFORE touching `ctx.api`, so `ctx` is
  // never actually dereferenced. The empty object widens to the full
  // `AddonContext` via a single documented test-stub boundary — no
  // `as never`, no `as unknown as`.
  const stubCtx = {} as Partial<AddonContext> as AddonContext

  // Typed `IScopedLogger` stub. `withTags`/`child` return the same stub so
  // a child logger (e.g. the rtc-session handler's
  // `deps.logger.withTags({ deviceId, sessionId })`) keeps the same
  // observable call surface.
  const stubLogger: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withTags: () => stubLogger,
    child: () => stubLogger,
  }
  const stubLoggerRef = stubLogger

  return {
    discovery: {
      ctx: stubCtx,
      logger: stubLoggerRef,
      listExposed: opts.listExposedForDiscovery ?? vi.fn().mockResolvedValue([]),
      buildEndpoints: vi.fn().mockResolvedValue([]),
    },
    cameraStream: {
      ctx: stubCtx,
      logger: stubLoggerRef,
      listExposed: vi.fn().mockReturnValue([]),
    },
    rtcSession: {
      ctx: stubCtx,
      logger: stubLoggerRef,
      listExposed: vi.fn().mockReturnValue([]),
    },
    ptzPreset: {
      ctx: stubCtx,
      logger: stubLoggerRef,
    },
    powerController: {
      ctx: stubCtx,
      logger: stubLoggerRef,
    },
    brightnessController: {
      ctx: stubCtx,
      logger: stubLoggerRef,
    },
    ptzDirection: {
      ctx: stubCtx,
      logger: stubLoggerRef,
    },
    reportState: {
      ctx: stubCtx,
      logger: stubLoggerRef,
    },
    securityPanel: {
      ctx: stubCtx,
      logger: stubLoggerRef,
    },
    snapshotProvider: snapshotsOff().provider,
    vision: visionOff(),
    lockController: { ctx: stubCtx, logger: stubLoggerRef },
    coverController: { ctx: stubCtx, logger: stubLoggerRef, sendAsyncResponse: async () => true },
    climateController: { ctx: stubCtx, logger: stubLoggerRef },
    access: allowAllAccess(),
    afterDiscovery: () => {},
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function isAuthCredentialError(result: { status: number; body: unknown }): boolean {
  const body = result.body as Record<string, unknown>
  const event = body?.event as Record<string, unknown> | undefined
  const payload = event?.payload as Record<string, unknown> | undefined
  return payload?.type === 'INVALID_AUTHORIZATION_CREDENTIAL'
}

// ── Test suite ───────────────────────────────────────────────────────

describe('dispatchDirective — scope enforcement', () => {
  // ── Case 1 ──────────────────────────────────────────────────────────
  it('case 1: control directive (PowerController/TurnOn) with view-only scope → rejected', async () => {
    const deps = makeMinimalDeps()

    const result = await dispatchDirective(
      {
        directive: {
          header: {
            ...BASE_HEADER,
            namespace: 'Alexa.PowerController',
            name: 'TurnOn',
          },
          endpoint: {
            endpointId: '42',
            scope: { type: 'BearerToken', token: 'tok' },
          },
        },
      },
      deps,
      makeIdentity(VIEW_ONLY_SCOPES),
    )

    expect(result.status).toBe(200)
    expect(isAuthCredentialError(result)).toBe(true)

    // The power handler is never reached: ctx.api is not accessed (it
    // would throw if called since ctx is an empty stub).
    // We additionally assert the logger was NOT called (it's only called
    // inside the handler, never in the scope gate).
    expect(deps.powerController.logger.info).not.toHaveBeenCalled()
  })

  // ── Case 2 ──────────────────────────────────────────────────────────
  it('case 2: control directive (PowerController/TurnOn) with control scope → passes scope gate', async () => {
    const deps = makeMinimalDeps()

    // A bare numeric endpointId ("42") routes to parsedId.kind === 'camera'
    // which returns INVALID_DIRECTIVE without touching ctx.api. This lets
    // the power handler be reached while keeping the ctx stub minimal.
    const result = await dispatchDirective(
      {
        directive: {
          header: {
            ...BASE_HEADER,
            namespace: 'Alexa.PowerController',
            name: 'TurnOn',
          },
          endpoint: {
            endpointId: '42',
            scope: { type: 'BearerToken', token: 'tok' },
          },
        },
      },
      deps,
      makeIdentity(CONTROL_SCOPES),
    )

    // The scope gate passed — the result is NOT the auth-credential error.
    expect(isAuthCredentialError(result)).toBe(false)

    // The handler ran and returned INVALID_DIRECTIVE (bare camera endpoint
    // is rejected at the handler level, not the scope gate level).
    const body = result.body as Record<string, unknown>
    const payload = (body?.event as Record<string, unknown>)?.payload as Record<string, unknown>
    expect(payload?.type).toBe('INVALID_DIRECTIVE')
  })

  // ── Case 3 ──────────────────────────────────────────────────────────
  it('case 3: read directive (Discovery/Discover) with empty scopes → rejected', async () => {
    const deps = makeMinimalDeps()

    const result = await dispatchDirective(
      {
        directive: {
          header: {
            ...BASE_HEADER,
            namespace: 'Alexa.Discovery',
            name: 'Discover',
          },
          payload: {
            scope: { type: 'BearerToken', token: 'tok' },
          },
        },
      },
      deps,
      makeIdentity(EMPTY_SCOPES),
    )

    expect(result.status).toBe(200)
    expect(isAuthCredentialError(result)).toBe(true)

    // Discovery's listExposed spy must not have been called.
    expect(deps.discovery.listExposed).not.toHaveBeenCalled()
  })

  // ── Case 4 ──────────────────────────────────────────────────────────
  it('case 4: read directive (Discovery/Discover) with view scope → passes scope gate, handler invoked', async () => {
    const listExposedSpy = vi.fn().mockResolvedValue([])
    const deps = makeMinimalDeps({ listExposedForDiscovery: listExposedSpy })

    const result = await dispatchDirective(
      {
        directive: {
          header: {
            ...BASE_HEADER,
            namespace: 'Alexa.Discovery',
            name: 'Discover',
          },
          payload: {
            scope: { type: 'BearerToken', token: 'tok' },
          },
        },
      },
      deps,
      makeIdentity(VIEW_ONLY_SCOPES),
    )

    // Scope gate passed — not an auth error.
    expect(isAuthCredentialError(result)).toBe(false)

    // Discovery handler was invoked.
    expect(listExposedSpy).toHaveBeenCalledOnce()

    // Response is a valid Discover.Response envelope.
    const body = result.body as Record<string, unknown>
    const header = (body?.event as Record<string, unknown>)?.header as Record<string, unknown>
    expect(header?.name).toBe('Discover.Response')
  })
})
