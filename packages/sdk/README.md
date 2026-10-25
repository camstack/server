# @camstack/sdk

The client library for talking to a **CamStack hub**.

It gives you `System` — a connected client that owns the transport (tRPC over
WebSocket, or HTTP), the login flow, a warm cache of the hub's devices, and live
event subscriptions — plus the shared TypeScript types (detections, timeline,
devices, cameras) that the hub's API speaks.

This is what the CamStack Viewer app is built on.

## Install

```bash
npm install @camstack/sdk @camstack/types @trpc/client
```

`@camstack/types` and `@trpc/client` are not bundled: the published build imports
both at runtime, so they must be installed alongside.

## Quickstart

```ts
import { createSystem } from '@camstack/sdk'
import { EventCategory } from '@camstack/types'

// Log in (a tokenless System is enough — `login` is a public procedure).
const { token } = await createSystem({ serverUrl: 'http://hub.local:4443' })
  .login('admin', 'hunter2')

const system = createSystem({
  serverUrl: 'http://hub.local:4443',
  token,
  onConnectionChange: (state) => console.info('transport:', state),
})

// Warm-boot the device mirror, then read devices synchronously.
await system.init()
for (const info of system.listDeviceInfos()) {
  console.info(info.id, info.name, info.online)
}

// Fully typed calls against the hub's tRPC router.
const snapshot = await system.trpcClient.snapshot.getSnapshot.query({ deviceId: 42 })

// Live events, one subscription per category, fanned out to all listeners.
const unsubscribe = system.subscribeEvent(EventCategory.MotionOnMotionChanged, (event) => {
  console.info(event.source, event.data)
})

// …later
unsubscribe()
system.close()
```

If `login` returns `requiresTotp`, the returned `token` is a challenge — pass it
to `system.loginVerifyTotp(challengeToken, code)` to exchange it for a session
token. Passkeys have an equivalent pair of methods.

## What's exported

`packages/sdk/src/index.ts` is the authoritative list. In broad strokes:

| Surface | What it is |
| --- | --- |
| `System`, `createSystem`, `SystemConfig` | The client. Connection lifecycle, auth, devices, live events. |
| `raceFastestEndpoint` | Probes candidate base URLs against `/trpc/health` and returns the first to answer. For clients that reach the same hub over several routes. |
| `BackendAppRouter` (alias `AppRouter`) | Type-only. The hub's tRPC router type — use it to type your own tRPC client if you don't want `System`. |
| `DetectionClass` + classifiers | The detection-class vocabulary (`isPersonClassname`, `getParentClass`, timeline presets, …). |
| Device types | `CanonicalDeviceType`, `getCanonicalDeviceType`, and the raw→canonical maps. |
| Timeline / NVR / camera types | Type-only shapes for events, clusters, recordings, clips, PTZ, camera status. |
| `FEATURE_MATRIX`, `isFeatureAvailable` | Static table of which features a given source/platform supports. |

`System` also exposes the hub's system-scoped capabilities as typed namespaces
(`system.storage`, `system.userManagement`, `system.streamBroker`, …), and
`system.trpcClient` as the escape hatch for anything not wrapped.

## What it is not

- **Not a REST wrapper.** Everything goes over tRPC to a CamStack hub. There is
  no stable HTTP surface here to call by hand.
- **Not a standalone NVR client.** It does not talk to plus catalog, plugin catalog, ONVIF
  or a camera directly — the hub does that. Names like `CameraSourceType` are
  how the hub *describes* a source, not clients for it.
- **Not versioned independently of the hub.** The router types are generated
  from the server, so an SDK build matches the hub it was built against. Expect
  to keep the two roughly in step; no compatibility window is promised.

## License

MIT
