import alexaRemotePackage from 'alexa-remote2/package.json'

/**
 * The `apiUserAgentPostfix` handed to every `alexa-remote2` `init`.
 *
 * Left unset, the library computes it with
 * `require(path.join(__dirname, 'package.json'))`. Bundled into `dist/addon.js`
 * that resolves to the addon's own `dist/`, where no `package.json` exists, and
 * `init` throws "Cannot find module …/dist/package.json". Setting it here keeps
 * the library's own value (`AlexaRemote/<version>`), read at build time.
 */
export const ALEXA_API_USER_AGENT_POSTFIX = `AlexaRemote/${alexaRemotePackage.version}`
