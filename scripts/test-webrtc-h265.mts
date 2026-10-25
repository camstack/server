/**
 * Headed Playwright harness for iterative H.265 WebRTC debugging.
 *
 * Opens admin-ui, navigates to an H.265 camera stream, polls
 * `RTCPeerConnection.getStats()` every second and prints the inbound
 * video stats that matter (`framesDecoded`, `framesAssembledFromMultiplePackets`,
 * `framesReceived`, `pliCount`, `keyFramesDecoded`).
 *
 * Headed mode is required: Chromium headless-shell ships without
 * VideoToolbox HEVC support. Running headed uses the user's macOS
 * VideoToolbox HEVC decoder — same path real Chrome takes.
 *
 * Usage:
 *   npx tsx scripts/test-webrtc-h265.mts <camera-url-or-name>
 *
 * Env:
 *   ADMIN_URL  default https://localhost:4443
 *   ADMIN_USER / ADMIN_PASS  for login (auto-detected if cookie persisted)
 */
import { chromium, type Page } from 'playwright'

const ADMIN_URL = process.env.ADMIN_URL ?? 'https://localhost:4443'
const ADMIN_USER = process.env.ADMIN_USER ?? 'admin'
const ADMIN_PASS = process.env.ADMIN_PASS ?? 'admin'
const cameraQuery = process.argv[2] ?? 'hall'
const POLL_INTERVAL_MS = 1_000
const RUN_DURATION_MS = 60_000

interface InboundVideoStats {
  framesDecoded: number
  framesReceived: number
  framesDropped: number
  framesAssembledFromMultiplePackets: number
  keyFramesDecoded: number
  pliCount: number
  packetsReceived: number
  packetsLost: number
  bytesReceived: number
  decoderImplementation: string | undefined
  codecMime: string | undefined
}

async function pollStats(page: Page): Promise<InboundVideoStats | null> {
  return page.evaluate(async () => {
    // Walk all peer connections we can reach. Admin-ui exposes them
    // via globalThis.__pcs (set by the player) when test-mode flag is on.
    // Fall back to enumerating window.RTCPeerConnection instances if any
    // external probe captured them.
    const pcs: RTCPeerConnection[] =
      (globalThis as unknown as { __pcs?: RTCPeerConnection[] }).__pcs ?? []
    if (pcs.length === 0) return null
    const pc = pcs[pcs.length - 1]
    const report = await pc.getStats()
    const out: Partial<InboundVideoStats> = {}
    let codecId: string | undefined
    report.forEach((s: { type: string; kind?: string; [k: string]: unknown }) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') {
        out.framesDecoded = (s.framesDecoded as number) ?? 0
        out.framesReceived = (s.framesReceived as number) ?? 0
        out.framesDropped = (s.framesDropped as number) ?? 0
        out.framesAssembledFromMultiplePackets =
          (s.framesAssembledFromMultiplePackets as number) ?? 0
        out.keyFramesDecoded = (s.keyFramesDecoded as number) ?? 0
        out.pliCount = (s.pliCount as number) ?? 0
        out.packetsReceived = (s.packetsReceived as number) ?? 0
        out.packetsLost = (s.packetsLost as number) ?? 0
        out.bytesReceived = (s.bytesReceived as number) ?? 0
        out.decoderImplementation = s.decoderImplementation as string | undefined
        codecId = s.codecId as string | undefined
      }
    })
    if (codecId) {
      report.forEach((s: { id: string; mimeType?: string; [k: string]: unknown }) => {
        if (s.id === codecId) out.codecMime = s.mimeType as string | undefined
      })
    }
    return out as InboundVideoStats
  })
}

async function main(): Promise<void> {
  const browser = await chromium.launch({
    headless: false,
    args: ['--ignore-certificate-errors', '--use-fake-ui-for-media-stream'],
  })
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  const page = await context.newPage()

  // Inject __pcs collector on every page so getStats() can reach the
  // admin-ui's peer connections without modifying the app code.
  await page.addInitScript(() => {
    const w = globalThis as unknown as {
      __pcs?: RTCPeerConnection[]
      RTCPeerConnection: typeof RTCPeerConnection
    }
    if (!w.__pcs) w.__pcs = []
    const Orig = w.RTCPeerConnection
    w.RTCPeerConnection = new Proxy(Orig, {
      construct(t, args) {
        const pc = new (t as new (...a: unknown[]) => RTCPeerConnection)(...args)
        w.__pcs!.push(pc)
        return pc
      },
    }) as unknown as typeof RTCPeerConnection
  })

  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      console.error(`[browser:${m.type()}] ${m.text()}`)
    }
  })

  await page.goto(ADMIN_URL)
  await page.waitForLoadState('domcontentloaded')

  // Auto-login via data-testid selectors (added to admin-ui Login.tsx).
  const loginUser = page.locator('[data-testid="login-username"]')
  if (await loginUser.isVisible({ timeout: 8_000 }).catch(() => false)) {
    console.error('[harness] login form visible — submitting credentials')
    await loginUser.fill(ADMIN_USER)
    await page.locator('[data-testid="login-password"]').fill(ADMIN_PASS)
    await page.locator('[data-testid="login-submit"]').click()
    await page
      .waitForFunction(() => !document.querySelector('[data-testid="login-username"]'), {
        timeout: 15_000,
      })
      .catch(() => undefined)
    console.error('[harness] login submitted')
  }

  // Sidebar nav → Cameras.
  const navCameras = page.locator('[data-testid="nav-cameras"]')
  if (await navCameras.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await navCameras.click()
    console.error('[harness] clicked nav-cameras')
  } else {
    await page.goto(`${ADMIN_URL}/cameras`)
  }
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined)

  // Wait for at least one camera card to render. Cameras page has a
  // known cold-load race: provider integrations may register AFTER the
  // initial `listDevices` query fires, leaving the list empty. The page
  // does refetch every 5s, but Playwright must wait long enough for at
  // least one refetch cycle. If still empty after 30s, force a reload —
  // matches the manual workaround users currently take.
  let cardsAppeared = await page
    .waitForFunction(() => document.querySelectorAll('[data-testid^="camera-card-"]').length > 0, {
      timeout: 30_000,
    })
    .then(() => true)
    .catch(() => false)
  if (!cardsAppeared) {
    console.error('[harness] no cards after 30s — reloading page')
    await page.reload()
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined)
    cardsAppeared = await page
      .waitForFunction(
        () => document.querySelectorAll('[data-testid^="camera-card-"]').length > 0,
        { timeout: 30_000 },
      )
      .then(() => true)
      .catch(() => false)
  }

  // Click camera card matching the query string by data-camera-name.
  console.error(`[harness] looking for camera card matching /${cameraQuery}/i…`)
  const cam = page
    .locator(`[data-testid^="camera-card-"]`)
    .filter({
      has: page.locator(
        `[data-camera-name=${JSON.stringify(cameraQuery)}], :text-matches("${cameraQuery}", "i")`,
      ),
    })
    .first()
  // Fallback: filter cards by data-camera-name attribute via JS evaluation.
  const targetCardId = await page.evaluate((q) => {
    const cards = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="camera-card-"]'),
    )
    const re = new RegExp(q, 'i')
    const match = cards.find((c) => re.test(c.getAttribute('data-camera-name') ?? ''))
    return match?.getAttribute('data-testid') ?? null
  }, cameraQuery)
  if (!targetCardId) {
    await page.screenshot({ path: '/tmp/harness-no-camera.png' })
    const cardCount = await page.locator('[data-testid^="camera-card-"]').count()
    const allNames = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="camera-card-"]')).map(
        (c) => `${c.getAttribute('data-testid')}:${c.getAttribute('data-camera-name')}`,
      ),
    )
    console.error(`[harness] cards on page: ${cardCount}, names: ${JSON.stringify(allNames)}`)
    console.error(`[harness] page url: ${page.url()}, title: ${await page.title()}`)
    throw new Error(`camera /${cameraQuery}/i not found`)
  }
  console.error(`[harness] clicking ${targetCardId}`)
  await page.locator(`[data-testid="${targetCardId}"]`).click()
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined)
  await page.waitForTimeout(2_000)
  console.error('[harness] device page url:', page.url())

  // Select HIGH stream via stream-profile-select. Options are like
  // "Adaptive", "HIGH (3840×2160)", "MID (...)", "LOW (...)" with
  // values = streamId ("high" / "mid" / "low" / "adaptive"). Match by
  // option whose value contains the requested profile keyword.
  const profileSelect = page.locator('[data-testid="stream-profile-select"]').first()
  if (await profileSelect.isVisible({ timeout: 3_000 }).catch(() => false)) {
    const wanted = (process.env.STREAM_PROFILE ?? 'high').toLowerCase()
    const optionValues = await profileSelect.evaluate((el) =>
      Array.from((el as HTMLSelectElement).options).map((o) => ({
        value: o.value,
        label: o.label,
      })),
    )
    console.error('[harness] available stream options:', JSON.stringify(optionValues))
    const match = optionValues.find(
      (o) => o.value.toLowerCase().includes(wanted) || o.label.toLowerCase().includes(wanted),
    )
    if (match) {
      await profileSelect.selectOption({ value: match.value })
      console.error(`[harness] selected stream ${match.value} (${match.label})`)
    } else {
      console.error(`[harness] no profile match for "${wanted}", leaving default`)
    }
    await page.waitForTimeout(1_500)
  }

  // Click Play to start WebRTC stream.
  const playBtn = page.locator('[data-testid="stream-play-toggle"]').first()
  if (await playBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    const playing = await playBtn.getAttribute('data-stream-playing')
    if (playing !== 'true') {
      await playBtn.click()
      console.error('[harness] clicked play')
    } else {
      console.error('[harness] stream already playing')
    }
  }
  await page.waitForTimeout(3_000)
  void cam // keep ref

  // Try selecting HIGH stream profile if a profile selector is visible.
  for (const label of ['High', 'high', 'HIGH']) {
    const btn = page.getByRole('button', { name: label }).first()
    if (await btn.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await btn.click()
      console.error(`[harness] selected profile ${label}`)
      break
    }
  }
  await page.waitForTimeout(3_000)

  const start = Date.now()
  console.log(
    'time(s),framesDecoded,framesReceived,framesAssembled,keyFramesDecoded,pliCount,framesDropped,packetsReceived,bytesReceived,codec,decoder',
  )
  while (Date.now() - start < RUN_DURATION_MS) {
    const stats = await pollStats(page)
    if (stats) {
      const t = ((Date.now() - start) / 1000).toFixed(1)
      console.log(
        `${t},${stats.framesDecoded},${stats.framesReceived},${stats.framesAssembledFromMultiplePackets},${stats.keyFramesDecoded},${stats.pliCount},${stats.framesDropped},${stats.packetsReceived},${stats.bytesReceived},${stats.codecMime ?? '?'},${stats.decoderImplementation ?? '?'}`,
      )
    } else {
      const t = ((Date.now() - start) / 1000).toFixed(1)
      console.log(`${t},,,,,,,,,(no pc yet),`)
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
  }

  await browser.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
