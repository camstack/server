/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- Electron types not resolved by eslint */
/**
 * The viewer role's window: a browser on a REMOTE hub's origin.
 *
 * It starts no child process. It loads `https://<hub>/viewer/camstack/` in a
 * PERSISTENT session partition (`persist:hub-<id>`) so the hub's
 * `camstack_session` cookie — and therefore the login — survives a quit, and so
 * two hubs never share a cookie jar or a certificate pin.
 *
 * Nothing about authentication is invented here: the window is, to the hub,
 * indistinguishable from a browser tab on the same origin, so the SPA's own
 * `auth.exchangeSession` bootstrap and the bounce to `/login` work unchanged.
 * The ONLY navigation ever intercepted is `camstack-trust:accept`, the shell
 * trust page's own button (`TRUST_ACCEPT_URL`) — a scheme no hub can produce.
 * Every http(s) navigation is left alone, which is what keeps that bounce
 * working. No credential storage, no `Authorization` header injection.
 *
 * When the hub is not usable the window shows a SHELL page, never Chromium's
 * error page, and a `/health` probe with bounded exponential backoff (1 s → 30 s)
 * recovers automatically. Every state transition logs — a shell that silently
 * shows a blank window is a failure this repo has already paid for.
 *
 * Pure logic (backoff, classification, the pages) lives in
 * `viewer-connection.ts`; certificate policy in `cert-trust.ts`.
 */
import { BrowserWindow, nativeImage, net, session } from 'electron'
import type { CertTrustRejection } from './cert-trust'
import { installCertificateTrust } from './cert-trust'
import type { HubEntry } from './hub-pin-store'
import { healthUrlForOrigin, partitionForHub, viewerUrlForOrigin } from './hub-pin-store'
import type { ProbeOutcome, ViewerConnectionState } from './viewer-connection'
import {
  classifyProbeOutcome,
  nextProbeDelayMs,
  renderCertTrustPage,
  renderUnreachablePage,
  renderViewerStartingPage,
  shouldLoadViewerUi,
  TRUST_ACCEPT_URL,
} from './viewer-connection'

/** How long a probe may take before it counts as unreachable. */
const PROBE_TIMEOUT_MS = 5_000

export interface ViewerWindowBounds {
  readonly width: number
  readonly height: number
  readonly x?: number
  readonly y?: number
}

export interface ViewerWindowDeps {
  /** The hub to show, read fresh (the operator can switch hubs at runtime). */
  readonly hub: () => HubEntry | null
  readonly bounds: () => ViewerWindowBounds
  readonly onBoundsChanged: (bounds: ViewerWindowBounds) => void
  /** Notify the shell so the tray's connection line follows the state. */
  readonly onStateChanged: (state: ViewerConnectionState) => void
  readonly log: (message: string) => void
  readonly preloadPath: string
  readonly iconPath: string
  /** True while the app is quitting — the window then closes for real. */
  readonly isQuitting: () => boolean
  /** True when a tray exists, so a close hides instead of destroying. */
  readonly hasTray: () => boolean
  /**
   * Persist the operator's trust decision for the ACTIVE hub.
   *
   * Takes no fingerprint: the value pinned is the one this controller already
   * holds from the refusal it is displaying, never a string handed back by a
   * renderer. Returns false when there is nothing to pin (no hub, or a refusal
   * that presented no issuer at all), so the caller can say so instead of
   * reloading into the same wall.
   */
  readonly pinActiveHub: (fingerprint: string) => boolean
}

/**
 * Owns the viewer window and its connection state. One instance per app run;
 * switching hubs goes through `switchHub()`, which drops the window so the new
 * origin gets its own partition.
 */
export class ViewerWindowController {
  private window: BrowserWindow | null = null
  private state: ViewerConnectionState = 'connecting'
  private consecutiveFailures = 0
  private probeTimer: NodeJS.Timeout | null = null
  private lastRejection: CertTrustRejection | null = null
  private trustedPartitions = new Set<string>()

  constructor(private readonly deps: ViewerWindowDeps) {}

  get connectionState(): ViewerConnectionState {
    return this.state
  }

  /** Show (creating if needed) the viewer window and start probing. */
  show(): void {
    const hub = this.deps.hub()
    if (hub === null) {
      this.deps.log('[viewer] no hub configured — nothing to show')
      return
    }
    if (this.window !== null) {
      this.window.show()
      this.window.focus()
      return
    }
    this.window = this.createWindow(hub)
    this.state = 'connecting'
    this.deps.onStateChanged(this.state)
    this.deps.log(`[viewer] window opened for ${hub.origin} (partition ${partitionForHub(hub.id)})`)
    this.probeNow()
  }

  /** Re-load the hub UI on operator request (tray → Reload UI). */
  reload(): void {
    this.consecutiveFailures = 0
    const hub = this.deps.hub()
    if (hub === null || this.window === null) return
    this.deps.log(`[viewer] operator reload of ${hub.origin}`)
    this.transition('connecting', hub)
    this.probeNow()
  }

  /** Point the window at a different hub — a new origin means a new window. */
  switchHub(): void {
    this.stopProbe()
    if (this.window !== null) {
      this.window.destroy()
      this.window = null
    }
    this.consecutiveFailures = 0
    this.lastRejection = null
    this.show()
  }

  /** Stop the probe loop (app quit). */
  dispose(): void {
    this.stopProbe()
  }

  /**
   * Pin the root this hub just presented, then try again.
   *
   * `trustedPartitions` is cleared so the verify proc runs FRESH — without that
   * the session would keep answering from the decision it had already made and
   * the operator's click would appear to do nothing. The reload is what proves
   * it worked: either the UI loads, or the same page comes back with a reason.
   */
  private acceptPresentedCertificate(): void {
    const rejection = this.lastRejection
    if (rejection === null || rejection.issuerFingerprint === null) {
      this.deps.log('[viewer] trust accepted but nothing to pin — no issuer was presented')
      return
    }
    if (!this.deps.pinActiveHub(rejection.issuerFingerprint)) {
      this.deps.log('[viewer] trust accepted but no active hub to pin it to')
      return
    }
    this.deps.log(
      `[viewer] operator pinned ${rejection.issuerFingerprint} for ${rejection.hostname}`,
    )
    this.lastRejection = null
    this.trustedPartitions.clear()
    this.consecutiveFailures = 0
    this.probeNow()
  }

  private createWindow(hub: HubEntry): BrowserWindow {
    const partition = partitionForHub(hub.id)
    this.installTrust(partition)
    const bounds = this.deps.bounds()
    const win = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      title: 'CamStack',
      backgroundColor: '#0c0a09',
      icon: nativeImage.createFromPath(this.deps.iconPath),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        devTools: true,
        partition,
        preload: this.deps.preloadPath,
      },
    })

    // The trust page's accept button, and nothing else. `will-navigate` fires
    // for the shell page's own click; every other url — including the SPA's
    // bounce to `/login` and back — falls through untouched.
    win.webContents.on('will-navigate', (event, url) => {
      if (url !== TRUST_ACCEPT_URL) return
      event.preventDefault()
      this.acceptPresentedCertificate()
    })

    win.on('close', (event) => {
      if (this.deps.hasTray() && !this.deps.isQuitting()) {
        event.preventDefault()
        win.hide()
      }
    })
    win.on('closed', () => {
      this.window = null
      this.stopProbe()
    })
    win.on('resize', () => {
      const b = win.getBounds()
      this.deps.onBoundsChanged({ width: b.width, height: b.height, x: b.x, y: b.y })
    })
    return win
  }

  /**
   * Install the TOFU policy on this hub's partition, once. The pin is read
   * FRESH on every verification so an operator's trust decision takes effect
   * without recreating the session.
   */
  private installTrust(partition: string): void {
    if (this.trustedPartitions.has(partition)) return
    this.trustedPartitions.add(partition)
    installCertificateTrust(session.fromPartition(partition), {
      pinnedFingerprint: () => this.deps.hub()?.pinnedIssuerFingerprint ?? null,
      onDecision: (decision, hostname, verificationResult) => {
        this.deps.log(
          `[viewer] certificate ${decision.accept ? 'accepted' : 'REFUSED'} for ${hostname} (${decision.reason}, ${verificationResult})`,
        )
      },
      onRejected: (rejection) => {
        this.lastRejection = rejection
      },
    })
  }

  // -- Probe loop -----------------------------------------------------------

  private stopProbe(): void {
    if (this.probeTimer !== null) {
      clearTimeout(this.probeTimer)
      this.probeTimer = null
    }
  }

  private scheduleProbe(): void {
    this.stopProbe()
    const delayMs = nextProbeDelayMs(this.consecutiveFailures)
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null
      this.probeNow()
    }, delayMs)
  }

  private probeNow(): void {
    const hub = this.deps.hub()
    if (hub === null || this.window === null) return
    void this.probeHub(hub).then((outcome) => {
      if (this.window === null) return
      const next = classifyProbeOutcome(outcome)
      if (next === 'connected') {
        this.consecutiveFailures = 0
      } else {
        this.consecutiveFailures += 1
      }
      const shouldLoad = shouldLoadViewerUi(this.state, next)
      this.transition(next, hub, outcome)
      if (shouldLoad) {
        const url = viewerUrlForOrigin(hub.origin)
        this.deps.log(`[viewer] loading ${url}`)
        this.window.loadURL(url).catch((err: unknown) => {
          this.deps.log(`[viewer] load failed: ${errorText(err)}`)
          this.state = 'unreachable'
          this.consecutiveFailures += 1
          this.scheduleProbe()
        })
        return
      }
      if (next !== 'connected') this.scheduleProbe()
    })
  }

  /**
   * A transition is never silent, and never repaints a window that is already
   * in the state being entered (which, for `connected`, would throw away a live
   * session).
   */
  private transition(next: ViewerConnectionState, hub: HubEntry, outcome?: ProbeOutcome): void {
    if (next === this.state) return
    this.deps.log(
      `[viewer] ${this.state} → ${next} (hub=${hub.origin}${outcome !== undefined ? `, probe=${describeOutcome(outcome)}` : ''})`,
    )
    this.state = next
    this.deps.onStateChanged(next)
    if (next === 'connected' || next === 'connecting') return
    this.showFallbackPage(next, hub, outcome)
  }

  private showFallbackPage(
    state: ViewerConnectionState,
    hub: HubEntry,
    outcome?: ProbeOutcome,
  ): void {
    if (this.window === null) return
    const html = this.renderFallback(state, hub, outcome)
    if (html === null) return
    this.window
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
      .catch((err: unknown) => {
        this.deps.log(`[viewer] could not show the ${state} page: ${errorText(err)}`)
      })
  }

  private renderFallback(
    state: ViewerConnectionState,
    hub: HubEntry,
    outcome?: ProbeOutcome,
  ): string | null {
    if (state === 'viewer-starting') return renderViewerStartingPage(hub.origin)
    if (state === 'unreachable') {
      const detail = outcome !== undefined && outcome.kind === 'unreachable' ? outcome.detail : ''
      return renderUnreachablePage(hub.origin, detail)
    }
    if (state === 'cert-not-trusted') {
      const rejection = this.lastRejection
      return renderCertTrustPage({
        hubUrl: hub.origin,
        hostname: rejection?.hostname ?? new URL(hub.origin).hostname,
        hadPin: hub.pinnedIssuerFingerprint !== null,
        presentedIssuerFingerprint: rejection?.issuerFingerprint ?? null,
        leafSubjectName: rejection?.leafSubjectName ?? 'unknown',
        leafIssuerName: rejection?.leafIssuerName ?? 'unknown',
        validFrom: formatCertTime(rejection?.validStart),
        validTo: formatCertTime(rejection?.validExpiry),
        verificationResult: rejection?.verificationResult ?? 'unknown',
      })
    }
    return null
  }

  /**
   * One probe: `/health` first (cheap, does not touch the SPA mount), then the
   * viewer mount only to tell a hub that is up-but-still-forking from one that
   * is ready. A refusal recorded by the verify proc outranks both.
   */
  private async probeHub(hub: HubEntry): Promise<ProbeOutcome> {
    const partition = partitionForHub(hub.id)
    this.lastRejection = null
    const health = await httpStatus(healthUrlForOrigin(hub.origin), partition)
    if (health.kind === 'error') {
      if (this.lastRejection !== null) return { kind: 'cert-rejected' }
      return { kind: 'unreachable', detail: health.detail }
    }
    const viewer = await httpStatus(viewerUrlForOrigin(hub.origin), partition)
    if (viewer.kind === 'error') {
      if (this.lastRejection !== null) return { kind: 'cert-rejected' }
      return { kind: 'unreachable', detail: viewer.detail }
    }
    if (viewer.status === 503) return { kind: 'viewer-starting' }
    return { kind: 'reachable' }
  }
}

type HttpProbeResult =
  | { readonly kind: 'status'; readonly status: number }
  | { readonly kind: 'error'; readonly detail: string }

/**
 * A HEAD-like GET through the hub's own session partition, so the request is
 * adjudicated by the same certificate policy the window uses.
 */
function httpStatus(url: string, partition: string): Promise<HttpProbeResult> {
  return new Promise<HttpProbeResult>((resolve) => {
    let settled = false
    const finish = (result: HttpProbeResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    let request: Electron.ClientRequest
    try {
      request = net.request({ method: 'GET', url, partition })
    } catch (err: unknown) {
      finish({ kind: 'error', detail: errorText(err) })
      return
    }
    const timer = setTimeout(() => {
      request.abort()
      finish({ kind: 'error', detail: `timed out after ${PROBE_TIMEOUT_MS}ms` })
    }, PROBE_TIMEOUT_MS)
    request.on('response', (response) => {
      clearTimeout(timer)
      response.on('data', () => {
        /* drained — only the status matters */
      })
      response.on('end', () => {
        /* nothing to do */
      })
      finish({ kind: 'status', status: response.statusCode })
    })
    request.on('error', (err: Error) => {
      clearTimeout(timer)
      finish({ kind: 'error', detail: err.message })
    })
    request.end()
  })
}

function describeOutcome(outcome: ProbeOutcome): string {
  return outcome.kind === 'unreachable' ? `unreachable:${outcome.detail}` : outcome.kind
}

function formatCertTime(seconds: number | undefined): string {
  if (seconds === undefined) return 'unknown'
  return new Date(seconds * 1000).toISOString()
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
