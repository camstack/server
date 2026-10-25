/**
 * CLI E2E tests — verify `camstack serve` and `camstack agent` boot correctly.
 *
 * These tests spawn real processes using the CLI entry point and verify:
 * - Server starts and responds on the configured port
 * - Agent starts and attempts hub connection
 * - Info command prints version and platform
 *
 * Uses random ports to avoid conflicts with running servers.
 *
 * The serve/agent tests require the full server build (@camstack/server/main.js)
 * and are gated behind CAMSTACK_TEST_CLI_FULL=true.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { fork, type ChildProcess } from 'node:child_process'
import { resolve as resolvePath } from 'node:path'
import * as https from 'node:https'
import * as fs from 'node:fs'

const CLI_PATH = resolvePath(__dirname, '../../../../packages/cli/dist/cli.js')
const TEST_DATA_DIR = resolvePath(__dirname, '../../../../.test-data-cli-e2e')

const CLI_EXISTS = fs.existsSync(CLI_PATH)

// Random port in 10000-60000 range
function randomPort(): number {
  return 10000 + Math.floor(Math.random() * 50000)
}

function waitForPort(port: number, timeoutMs: number = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const check = () => {
      const req = https.request(
        { hostname: '127.0.0.1', port, path: '/', method: 'GET', rejectUnauthorized: false },
        (res) => {
          res.resume()
          resolve()
        },
      )
      req.on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error(`Port ${port} not responding after ${timeoutMs}ms`))
        } else {
          setTimeout(check, 500)
        }
      })
      req.end()
    }
    check()
  })
}

describe('CLI E2E', () => {
  const processes: ChildProcess[] = []

  afterEach(async () => {
    for (const proc of processes) {
      proc.kill('SIGTERM')
    }
    processes.length = 0
    // Small delay for cleanup
    await new Promise((r) => setTimeout(r, 500))
  })

  // Full server boot tests require the entire build chain
  const fullTest = process.env.CAMSTACK_TEST_CLI_FULL === 'true' && CLI_EXISTS ? it : it.skip

  fullTest(
    'camstack serve boots and responds on HTTPS',
    async () => {
      const port = randomPort()
      const proc = fork(CLI_PATH, ['serve', '--port', String(port), '--data', TEST_DATA_DIR], {
        stdio: 'pipe',
        env: { ...process.env, CAMSTACK_TLS_ENABLED: 'true' },
      })
      processes.push(proc)

      await waitForPort(port)

      // Verify HTTPS response
      const body = await new Promise<string>((resolve, reject) => {
        const req = https.request(
          { hostname: '127.0.0.1', port, path: '/', method: 'GET', rejectUnauthorized: false },
          (res) => {
            let data = ''
            res.on('data', (chunk) => {
              data += chunk
            })
            res.on('end', () => resolve(data))
          },
        )
        req.on('error', reject)
        req.end()
      })

      // Should return something (admin UI or health endpoint)
      expect(body.length).toBeGreaterThan(0)
    },
    30000,
  )

  fullTest(
    'camstack agent boots and stays alive',
    async () => {
      const proc = fork(
        CLI_PATH,
        ['agent', '--hub', '127.0.0.1', '--token', 'test_token', '--port', String(randomPort())],
        {
          stdio: 'pipe',
          env: {
            ...process.env,
            CAMSTACK_AGENT_NAME: 'test-agent',
            CAMSTACK_DATA: TEST_DATA_DIR,
          },
        },
      )
      processes.push(proc)

      // Agent should start even if hub is unreachable (retries in background)
      await new Promise((r) => setTimeout(r, 5000))

      // Process should still be alive (not crashed)
      expect(proc.exitCode).toBeNull()
    },
    15000,
  )

  it.skipIf(!CLI_EXISTS)(
    'camstack info prints version and platform',
    async () => {
      const output = await new Promise<string>((resolve, reject) => {
        let stdout = ''
        const proc = fork(CLI_PATH, ['info'], { stdio: 'pipe' })
        proc.stdout?.on('data', (chunk) => {
          stdout += chunk
        })
        proc.on('exit', (code) => {
          if (code === 0) resolve(stdout)
          else reject(new Error(`Exit code ${code}`))
        })
      })

      expect(output).toContain('camstack v')
      expect(output).toContain('Platform:')
      expect(output).toContain('Node.js:')
    },
    10000,
  )
})
