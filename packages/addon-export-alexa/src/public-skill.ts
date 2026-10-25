/**
 * The built-in "public" CamStack Alexa skill.
 *
 * Only its skill id lives here — an identifier, not a credential. Until D753
 * this file also carried the skill's Login With Amazon "Send Alexa Events"
 * client id and SECRET, on the theory that a per-account refresh token was the
 * real gate. The package is public on npm, so that secret was published with
 * every version and has to be rotated. Since D753 the secret lives only in the
 * skill's Lambda (SSM Parameter Store SecureString, D761); the hub gets short-lived Event Gateway
 * tokens from the Lambda's broker (`broker-client.ts`) with a per-link
 * credential. `scripts/check-no-client-secrets.ts` keeps it that way.
 *
 * Operators who run their OWN skill switch to `skillMode: 'custom'` and deploy
 * the same Lambda (`lambda-template/`) with their own secrets.
 */
export const PUBLIC_SKILL_ID = 'amzn1.ask.skill.aa85d6df-1600-4f13-bda9-babcfdc849e6'
