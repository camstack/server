/**
 * Broken-addon fixture for the e2e/addon-failure suite.
 *
 * Throws at module-load time. The AddonLoader's load path MUST:
 *   1. Catch the error and emit a warn-level log entry tagged with this
 *      package's id (regression for Fix #9 — silent loader failures).
 *   2. Mark the addon's process state as 'failed' so it surfaces in
 *      addons.list (regression for Fix #7).
 *   3. NOT include this addon in `integrations.getAvailableTypes`
 *      (regression for Fix #10 — picker-vs-orphans).
 *
 * The trigger uses a runtime API mismatch (calling a method that does
 * not exist on the global object) so the failure mode mirrors the
 * real-world cases that bit us — a peer-dep version drift or a removed
 * export. Pure `throw` would also work; the call-on-undefined is more
 * representative.
 */
const camstackBroken = globalThis.__camstackBrokenFixtureBootstrap
camstackBroken.startNonExistentService('this should never run')

module.exports = {
  default: () => {
    throw new Error('broken-addon: should never be invoked')
  },
}
