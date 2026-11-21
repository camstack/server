/**
 * What an assistant is told about this server before it calls anything: the
 * server `instructions` (sent at initialize) and the `get-started` prompt a
 * person can pick. Both say one thing — start from `setup_wizard` — and the
 * prompt lists the steps as the docs have them, read from the same manifest
 * the wizard walks.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { manifestOf } from '../onboarding/context.js'
import type { McpContext } from './context.js'
import { WIZARD_TOOL } from './setup-wizard.js'

export const GET_STARTED_PROMPT = 'get-started'

const RULES = [
  `Call ${WIZARD_TOOL} first, and again after every step: it answers where the install stands and the one next step, from any state — nothing installed yet included.`,
  'Do what nextStep says, in order. Each action names the tool to call and the same action by hand in the admin UI; when an action has no tool, the person does it and you wait.',
  'Never ask for, accept or repeat a password, token or key. A sign-in is approved in the browser; an account token is typed into the admin UI by the person.',
  'Every write is two-step: a preview with a one-shot token, then the same call with that token once the person agreed.',
  'A step answered unknown was not read: say why, do not treat it as missing.',
].join('\n')

export const SERVER_INSTRUCTIONS = `CamStack setup and operations.\n${RULES}`

export function registerGetStartedPrompt(server: McpServer, ctx: McpContext): void {
  server.prompt(
    GET_STARTED_PROMPT,
    'Set up CamStack from wherever this install stands: check the machine, install, sign in, storage, core addons, cameras, detection, remote access, notifications, backups.',
    async () => {
      const { manifest } = await manifestOf(ctx)()
      const steps = manifest.steps.map((s, i) => `${i + 1}. ${s.title} — ${s.summary}`).join('\n')
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Help me set up CamStack.\n\n${RULES}\n\nThe steps, as the guide at ${manifest.docsBaseUrl}/docs/get-started has them:\n${steps}\n\nStart now: call ${WIZARD_TOOL}.`,
            },
          },
        ],
      }
    },
  )
}
