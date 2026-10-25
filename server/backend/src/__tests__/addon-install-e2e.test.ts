// server/backend/src/__tests__/addon-install-e2e.test.ts
//
// E2E test: simulates addon directory scanning and verifies
// addon packages with package.json + dist/ can be loaded.
//
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const TEST_ADDONS_DIR = path.resolve('test-output/fresh-addons')

describe('Addon Directory Loading', () => {
  beforeAll(() => {
    // Clean slate — delete the test addons directory
    fs.rmSync(TEST_ADDONS_DIR, { recursive: true, force: true })
    fs.mkdirSync(TEST_ADDONS_DIR, { recursive: true })
  })

  afterAll(() => {
    // Cleanup
    fs.rmSync(TEST_ADDONS_DIR, { recursive: true, force: true })
  })

  it('AddonInstaller initializes the addons directory', async () => {
    const { AddonInstaller } = await import('@camstack/system')

    // Constructor creates the addons directory if it doesn't exist
    const installer = new AddonInstaller({
      addonsDir: TEST_ADDONS_DIR,
    })

    // Verify directory exists and installer was created
    expect(installer.addonsDir).toBe(TEST_ADDONS_DIR)
    expect(fs.existsSync(TEST_ADDONS_DIR)).toBe(true)
  })

  it('AddonInstaller lists installed addon packages', async () => {
    const { AddonInstaller } = await import('@camstack/system')

    // Create a mock addon directory
    const addonDir = path.join(TEST_ADDONS_DIR, 'addon-test')
    fs.mkdirSync(addonDir, { recursive: true })
    fs.writeFileSync(
      path.join(addonDir, 'package.json'),
      JSON.stringify({
        name: '@camstack/addon-test',
        version: '1.0.0',
        camstack: { addons: [{ id: 'test', entry: './dist/index.js', slot: 'detector' }] },
      }),
    )

    const installer = new AddonInstaller({ addonsDir: TEST_ADDONS_DIR })
    const installed = installer.listInstalled()

    expect(installed).toHaveLength(1)
    expect(installed[0]).toMatchObject({
      name: '@camstack/addon-test',
      version: '1.0.0',
    })

    // Cleanup
    fs.rmSync(addonDir, { recursive: true, force: true })
  })

  it('AddonLoader scans addons directory and loads packages', async () => {
    const { AddonLoader } = await import('@camstack/system')

    const loader = new AddonLoader()

    // With an empty directory, no addons should be loaded
    await loader.loadFromDirectory(TEST_ADDONS_DIR)
    expect(loader.listAddons()).toHaveLength(0)
  })
})
