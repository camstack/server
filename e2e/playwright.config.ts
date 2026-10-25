import { defineConfig } from '@playwright/test'

/**
 * Playwright config for camstack browser E2E flows.
 *
 * Vitest owns the suite orchestration (spawn hub, fixtures, assertions).
 * Playwright is used INSIDE specs that need a real browser — typically
 * the WebRTC streaming / admin-UI flows. Boot scripts/test-webrtc-h265.mts
 * is the canonical example (headed, VideoToolbox-backed HEVC).
 *
 * Playwright `test()` runs are NOT used here directly — `npx playwright test`
 * is not the entry point; vitest invokes browser code via the playwright
 * library API. This config exists so engineers can run a headed playwright
 * session against an already-running hub for debugging.
 */
export default defineConfig({
  testDir: './suites',
  // Browser specs use vitest. This config is for ad-hoc playwright runs.
  testIgnore: ['**/*.spec.ts'],
  timeout: 60_000,
  use: {
    baseURL: 'https://localhost:4443',
    ignoreHTTPSErrors: true,
    headless: false,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  outputDir: 'test-results/',
})
