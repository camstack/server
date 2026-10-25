/**
 * The ONE retry schedule for work that can fail simply because the node was
 * still booting.
 *
 * The measured failure (docs/design/boot-to-usable-camera.md, item E): a hub
 * boot that serialised its addon graph starved every driver dial on it. Fifteen
 * Hikvision devices logged `Initial probe did not complete — scheduling retry
 * chain {firstRetryMs=300000}` and then sat unprobed for five minutes, long
 * after the condition that caused the failure had gone. The Tailscale addon's
 * auto-rejoin carried a byte-identical schedule, armed from `initialize()`, for
 * the same reason.
 *
 * The shape that fixes it: **two cheap attempts first, then the long tail.**
 *
 *  - 15 s / 60 s — the boot window. Anything that failed because the node was
 *    busy is recovered here, before an operator can open the UI and see a
 *    camera that is wrong about itself.
 *  - 5 m → 90 m — the genuinely-offline case. A battery cam that is asleep, a
 *    VLAN that is down, a peer that has not come back. Unchanged in intent from
 *    the schedule this replaces (~3 h 30 m of coverage): here ~3 h 21 m, then
 *    the chain ends and manual re-arm (reprobe / restart) is the only path.
 *
 * Bounded on purpose — see D6. A chain that never gives up is a busy loop with
 * extra steps.
 */
export const BOOT_RECOVERY_BACKOFF_MS: readonly number[] = [
  15_000,
  60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  60 * 60_000,
  90 * 60_000,
] as const
