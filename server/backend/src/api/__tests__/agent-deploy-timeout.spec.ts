/**
 * The `$agent.deploy` timeout is sized for the INSTALL, not for a control call.
 *
 * ## 2026-09-11 — the same node, the same symptom, a third cause
 *
 * `agent-a` spent an evening running a previous `addon-pipeline` dist
 * while three `camstack deploy` runs each printed `✓ Deployed to 1 target(s)`.
 * The hub log said what the CLI did not:
 *
 *   agent deploy: FAILED {nodeId=agent-a
 *     error="Request is timed out when call '$agent.deploy' action ..."}
 *
 * Three times, each exactly 30 s after the call — the constant, not the work.
 * The Mac agent answered the same call in under a second on every one of them.
 *
 * The constant carried the claim that made it wrong: *"a control call: install
 * work is bounded well inside this"*. `$agent.deploy` is not a control call —
 * the agent pulls the tarball, unpacks it and runs its installer, and on this
 * node `/data` is an shfs/FUSE mount where that is minutes. The SAME node needs
 * ~15 minutes for an `npm install` of the server closure for the same reason.
 *
 * The other half of the system already knew. `AGENT_BACKFILL_RPC_TIMEOUT_MS` is
 * 300 000 and says so: *"Generous on purpose… For the pipeline stack that is
 * minutes, and a timeout here aborts the call even though the deploy already
 * landed."* One path had the lesson written down; the other asserted its
 * opposite about the same RPC.
 *
 * ## Why a test and not just a bigger number
 *
 * Because the bug is the DRIFT, not the value. Two constants for one RPC will
 * separate again, and the failure is invisible from the CLI — a bundle that
 * lands while the reload never runs looks exactly like a deploy that worked.
 * This pins the relationship instead of the number.
 */
import { describe, expect, it } from 'vitest'
import { AGENT_BACKFILL_RPC_TIMEOUT_MS } from '../../core/agent/agent-registry.service.js'
import {
  AGENT_DEPLOY_CONTROL_TIMEOUT_MS,
  AGENT_RELOAD_TIMEOUT_MS,
} from '../agent-addon-delivery.js'

describe('agent deploy timeouts', () => {
  it('gives the install at least what the back-fill gives the same RPC', () => {
    expect(
      AGENT_DEPLOY_CONTROL_TIMEOUT_MS,
      'the hot path and the back-fill call $agent.deploy — one cannot be stricter',
    ).toBeGreaterThanOrEqual(AGENT_BACKFILL_RPC_TIMEOUT_MS)
  })

  it('is minutes, not seconds — an shfs agent unpacks the pipeline bundle in minutes', () => {
    expect(AGENT_DEPLOY_CONTROL_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000)
  })

  it('is not shorter than the reload it precedes', () => {
    // Installing is the heavy half; a deploy that times out before its own
    // reload would could never reach the step that makes the bytes run.
    expect(AGENT_DEPLOY_CONTROL_TIMEOUT_MS).toBeGreaterThanOrEqual(AGENT_RELOAD_TIMEOUT_MS)
  })
})
