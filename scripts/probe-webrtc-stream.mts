/**
 * Headed Playwright probe: play ONE device's stream and poll the
 * receiver-side RTCPeerConnection.getStats() every second.
 *
 * Navigates directly to /devices/:id (the device-detail page) — avoids the
 * stale /cameras route (now a client redirect → ERR_ABORTED) and the gone
 * nav-cameras/camera-card testids. Reuses the proven __pcs getStats probe.
 *
 * The decisive question this answers for the "porch HIGH freezes" bug:
 *   framesReceived climbing but framesDecoded PLATEAU + framesDropped rising
 *     → receiver decoder can't keep up (bitrate/overload)
 *   framesReceived also plateau / framesAssembled stuck
 *     → framing/timestamp problem upstream
 *   pliCount climbing → decoder asking for keyframes (reference loss)
 *
 * Usage:  DEVICE_ID=12 STREAM_PROFILE=high npx tsx scripts/probe-webrtc-stream.mts
 */
import { chromium, type Page } from 'playwright'

const ADMIN_URL = process.env.ADMIN_URL ?? 'https://localhost:4443'
const ADMIN_USER = process.env.ADMIN_USER ?? 'admin'
const ADMIN_PASS = process.env.ADMIN_PASS ?? 'admin'
const DEVICE_ID = process.env.DEVICE_ID ?? '12'
const WANT_PROFILE = (process.env.STREAM_PROFILE ?? 'high').toLowerCase()
const RUN_MS = Number(process.env.RUN_MS ?? 45_000)

interface InboundVideoStats {
  framesReceived: number
  framesDecoded: number
  framesDropped: number
  framesAssembledFromMultiplePackets: number
  keyFramesDecoded: number
  pliCount: number
  packetsReceived: number
  packetsLost: number
  bytesReceived: number
  frameWidth: number | undefined
  frameHeight: number | undefined
  decoderImplementation: string | undefined
  codecMime: string | undefined
}

async function pollStats(page: Page): Promise<InboundVideoStats | null> {
  return page.evaluate(async () => {
    const pcs: RTCPeerConnection[] =
      (globalThis as unknown as { __pcs?: RTCPeerConnection[] }).__pcs ?? []
    if (pcs.length === 0) return null
    const pc = pcs[pcs.length - 1]
    const report = await pc.getStats()
    const out: Partial<InboundVideoStats> = {}
    let codecId: string | undefined
    report.forEach((s: { type: string; kind?: string; [k: string]: unknown }) => {
      if (s.type === 'inbound-rtp' && s.kind === 'video') {
        out.framesReceived = (s.framesReceived as number) ?? 0
        out.framesDecoded = (s.framesDecoded as number) ?? 0
        out.framesDropped = (s.framesDropped as number) ?? 0
        out.framesAssembledFromMultiplePackets =
          (s.framesAssembledFromMultiplePackets as number) ?? 0
        out.keyFramesDecoded = (s.keyFramesDecoded as number) ?? 0
        out.pliCount = (s.pliCount as number) ?? 0
        out.packetsReceived = (s.packetsReceived as number) ?? 0
        out.packetsLost = (s.packetsLost as number) ?? 0
        out.bytesReceived = (s.bytesReceived as number) ?? 0
        out.frameWidth = s.frameWidth as number | undefined
        out.frameHeight = s.frameHeight as number | undefined
        out.decoderImplementation = s.decoderImplementation as string | undefined
        codecId = s.codecId as string | undefined
      }
    })
    if (codecId) {
      report.forEach((s: { id: string; mimeType?: string }) => {
        if (s.id === codecId) out.codecMime = s.mimeType
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
    if (m.type() === 'error' || m.type() === 'warning')
      console.error(`[browser:${m.type()}] ${m.text()}`)
  })

  // Login first (root → dashboard), then hard-nav to the device detail route.
  await page.goto(ADMIN_URL, { waitUntil: 'domcontentloaded' })
  const loginUser = page.locator('[data-testid="login-username"]')
  if (await loginUser.isVisible({ timeout: 8_000 }).catch(() => false)) {
    await loginUser.fill(ADMIN_USER)
    await page.locator('[data-testid="login-password"]').fill(ADMIN_PASS)
    await page.locator('[data-testid="login-submit"]').click()
    await page
      .waitForFunction(() => !document.querySelector('[data-testid="login-username"]'), {
        timeout: 15_000,
      })
      .catch(() => undefined)
    console.error('[probe] logged in')
  }

  console.error(`[probe] navigating to /devices/${DEVICE_ID}`)
  await page.goto(`${ADMIN_URL}/devices/${DEVICE_ID}`, { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined)

  // Select the requested profile, if the selector is present.
  const profileSelect = page.locator('[data-testid="stream-profile-select"]').first()
  if (await profileSelect.isVisible({ timeout: 8_000 }).catch(() => false)) {
    const opts = await profileSelect.evaluate((el) =>
      Array.from((el as HTMLSelectElement).options).map((o) => ({
        value: o.value,
        label: o.label,
      })),
    )
    console.error('[probe] stream options:', JSON.stringify(opts))
    const match =
      opts.find(
        (o) =>
          o.value.toLowerCase().includes(WANT_PROFILE) ||
          o.label.toLowerCase().includes(WANT_PROFILE),
      ) ?? opts.find((o) => o.value.toLowerCase().includes('main') || o.label.includes('3840'))
    if (match) {
      await profileSelect.selectOption({ value: match.value })
      console.error(`[probe] selected ${match.value} (${match.label})`)
    } else {
      console.error(`[probe] no option matched "${WANT_PROFILE}"`)
    }
    await page.waitForTimeout(1_000)
  } else {
    console.error('[probe] stream-profile-select not visible')
  }

  // Play.
  const playBtn = page.locator('[data-testid="stream-play-toggle"]').first()
  if (await playBtn.isVisible({ timeout: 8_000 }).catch(() => false)) {
    if ((await playBtn.getAttribute('data-stream-playing')) !== 'true') {
      await playBtn.click()
      console.error('[probe] clicked play')
    } else {
      console.error('[probe] already playing')
    }
  } else {
    console.error('[probe] stream-play-toggle not visible')
  }

  const start = Date.now()
  console.log(
    't(s),recv,decoded,dropped,assembled,keyDec,pli,pktRecv,pktLost,bytes,WxH,codec,decoder',
  )
  while (Date.now() - start < RUN_MS) {
    const s = await pollStats(page)
    const t = ((Date.now() - start) / 1000).toFixed(1)
    if (s) {
      console.log(
        `${t},${s.framesReceived},${s.framesDecoded},${s.framesDropped},${s.framesAssembledFromMultiplePackets},${s.keyFramesDecoded},${s.pliCount},${s.packetsReceived},${s.packetsLost},${s.bytesReceived},${s.frameWidth ?? '?'}x${s.frameHeight ?? '?'},${s.codecMime ?? '?'},${s.decoderImplementation ?? '?'}`,
      )
    } else {
      console.log(`${t},,,,,,,,,,,(no pc yet),`)
    }
    await new Promise((r) => setTimeout(r, 1_000))
  }
  await browser.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
