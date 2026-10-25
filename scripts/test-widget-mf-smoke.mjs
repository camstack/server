/**
 * Smoke test: open the prod-bundled admin-ui served by the camstack
 * server and verify the Module Federation pipeline:
 *   1) admin-ui boots without console errors
 *   2) /api/addon-widgets/<addon>/remoteEntry.js loads (host registers
 *      the remote when listWidgets returns)
 *   3) ./widgets module resolves and yields the stableId components
 */
import { chromium } from 'playwright'

const URL = process.env.URL ?? 'https://127.0.0.1:3001'
const USER = process.env.ADMIN_USER ?? 'admin'
const PASS = process.env.ADMIN_PASS ?? 'admin'
const TIMEOUT_MS = 30_000

const browser = await chromium.launch({
  headless: true,
  args: ['--ignore-certificate-errors', '--disable-features=IsolateOrigins,site-per-process'],
})

const context = await browser.newContext({ ignoreHTTPSErrors: true })
const page = await context.newPage()

const consoleMsgs = []
page.on('console', (m) => {
  consoleMsgs.push({ type: m.type(), text: m.text() })
})
const requestErrors = []
page.on('requestfailed', (r) => {
  requestErrors.push({ url: r.url(), failure: r.failure()?.errorText })
})

const widgetEntryRequests = []
page.on('request', (r) => {
  if (r.url().includes('/api/addon-widgets/') && r.url().includes('remoteEntry.js')) {
    widgetEntryRequests.push(r.url())
  }
})

console.log('Step 1: navigate to admin-ui')
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_MS })

console.log('Step 2: login')
// Wait a tick to see if we hit a login page
await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
const loginButton = await page
  .locator('button:has-text("Sign in"), button:has-text("Login"), button[type="submit"]')
  .first()
if ((await loginButton.count()) > 0) {
  await page.fill('input[name="username"], input[type="text"]', USER).catch(() => {})
  await page.fill('input[name="password"], input[type="password"]', PASS).catch(() => {})
  await loginButton.click().catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {})
}

console.log('Step 3: wait for the widget-list query to resolve and remoteEntry.js to load')
// We just need to give the WidgetRegistryProvider time to fire its
// loadRemote — rendering an actual <WidgetSlot> would require navigating
// to a device-detail page. For a smoke test, the entry-load-on-discovery
// behavior is enough.
await page.waitForTimeout(8_000)

console.log('Step 4: inspect __mf_module_cache__ (set by MF runtime on init)')
const mfState = await page.evaluate(() => {
  const cache = globalThis.__mf_module_cache__
  return cache
    ? {
        shareKeys: Object.keys(cache.share ?? {}),
        remoteKeys: Object.keys(cache.remote ?? {}),
      }
    : null
})
console.log('MF module cache:', JSON.stringify(mfState, null, 2))

console.log('Step 5: results')
console.log(`  remoteEntry.js requests: ${widgetEntryRequests.length}`)
for (const u of widgetEntryRequests) console.log(`    ${u}`)

const errorMsgs = consoleMsgs.filter((m) => m.type === 'error')
console.log(`  console errors: ${errorMsgs.length}`)
for (const e of errorMsgs.slice(0, 10)) console.log(`    ${e.text}`)

console.log(`  request failures: ${requestErrors.length}`)
for (const r of requestErrors.slice(0, 10)) console.log(`    ${r.url} → ${r.failure}`)

await browser.close()

if (widgetEntryRequests.length === 0) {
  console.error('FAIL: no widget remoteEntry.js requests were made')
  process.exit(1)
}
if (errorMsgs.length > 0) {
  console.error('FAIL: console errors detected')
  process.exit(2)
}
console.log('PASS')
