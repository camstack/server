# Baby monitor (device 106) — did we respect the battery?

> Measurement on live data, window 2026-08-19 21:00 → 2026-08-26 21:00 UTC (7 days).
> Source: Loki (`job="camstack"`), filter `tags.deviceId == 106`, plus read-only
> tRPC reads against the hub. No stream, no snapshot, no
> probe emitted by this investigation.
> Companion: [D173](../decisions/adr-0173-a-battery-camera-is-woken-by-demand-only-and-asleep-is-not-gone.md),
> [device-model.md](../architecture/device-model.md).

## Short answer

**Yes, largely.** Nobody watched the camera streaming, no
`wakeForStream`, no recorder, no periodic poll ever reached it: all
the timers stopped in front of the gate, thousands of times, and wrote it to the
log. The only *voluntary* consumption in 7 days is **one operator snapshot**.

But the exact count of wake-ups **cannot be read from the attribution log**,
because that log is blind exactly on the population we care about. The raw
measurement says **31 logins** in 7 days against **3 attributed**. §4 explains why,
and §6 says what to instrument to make the question decidable.

A separate and more urgent note for the operator: **the 640 has not been heard from in ~24 h**
(§5).

---

## 1. The device

`deviceManager.getDevice(106)`:

| | |
| --- | --- |
| name / model | Baby monitor — Reolink **Argus 3E**, fw `v3.0.0.3623_24060675` |
| `features` | `native-snapshot`, `rebootable`, **`battery-operated`** |
| `stableId` / log scope | `mac-948cd7f85483` |
| topology | **top-level**, `parentDeviceId: null` — *not* a child of a hub |
| `probed` | **`false`** |
| children | 641 siren, 642 floodlight, 643 PIR (scope `…-acc-siren` / `-acc-floodlight` / `-acc-pir-sensor`) |

`battery-operated` is confirmed, so all the D173 gates are armed.
`probed: false` is the declared consequence of D173: a camera asleep at
boot does not seed the `feature-probe` slice, and that is fine.

The topology is what makes this camera the worst case in the fleet.
A hub child does not log in on its own (`ensureApi` short-circuits on the parent's
socket, `reolink-camera.ts:9289-9298`). The 106 is the **only** top-level
battery camera: it is the only one that can wake itself up by a login.

The other battery cameras (`deviceManager.listAll`, 45 devices with the feature, of
which 4 cameras):

| id | name | topology | battery | notes |
| --- | --- | --- | --- | --- |
| **640** | Baby monitor | top-level | **32 %**, `charging: none` | the subject of the analysis |
| 3628 | Camera laundry | child of 639 | 100 %, `charging: dc` | powered, not comparable |
| 3825 | Magicam | child of 639 | 100 %, `charging: none` | hub child, does not log in |
| 3629 | Camera porta retro | child of 639 | 0 %, `online: false` | out of service |

**No peer comparison is possible.** The other three go through the hub's
socket and two are at 100 %. The useful comparison in this document is therefore
**day against day on the 640 itself** (§3).

---

## 2. Who woke it — the count

Method. On UDP/Baichuan **the login IS the wake-up** (D173, Context). The
unambiguous marker of a login is therefore `Connecting to Reolink`
(`reolink-camera.ts:9335`), emitted *before* the connection attempt, with
`tags: { deviceId }`. The attribution marker is
`battery cam login while sleeping — this wakes the camera. caller: <stack>`
(`reolink-camera.ts:9319`).

> ⚠️ Tool trap, hit for real in this measurement. `hl loki-query`
> passes `limit=1000` and **truncates silently**. The first pass on
> `|~ "wake|sleep|login"` returned exactly 1001 lines: it is not a count,
> it is a ceiling. All the numbers below come from non-overlapping 24 h windows,
> queried one by one and summed, with the per-window ceiling at
> 5000 and a flag if it is hit. No window hit it.

### 2.1 The raw count, per day

| UTC day (→ 21:00) | provider boots | **logins (`Connecting to Reolink`)** | **attributed** logins | incoming push (free) |
| --- | ---: | ---: | ---: | ---: |
| 08-20 | 8 | 7 | 0 | 15 |
| 08-21 | 9 | 6 | 1 | 14 |
| 08-22 | 8 | 5 | 0 | 15 |
| 08-23 | 4 | 2 | 0 | 4 |
| 08-24 | 10 | 8 | 0 | 18 |
| 08-25 | 19 | 3 | 2 | 3 |
| 08-26 | 7 | **0** | 0 | **0** |
| **total** | **65** | **31** | **3** | **69** |

- provider boot = `Reolink stream-params cap registered`
- incoming push = `Reolink simpleEvent received` — it is the proof of *passive*
  reachability, the one that costs nothing and feeds `lastContactAt`
- **zero crashes**: `crash|CrashSupervisor|respawn|exited` on `provider-reolink` = 0
  lines in 7 days. The 65 boots are deliberate restarts (deploys), not a loop.

### 2.2 The 3 wake-ups with a name

All three on the 106, none on other cameras of the fleet:

| when (UTC) | caller in the stack | verdict |
| --- | --- | --- |
| 08-21 06:15:01 | `FloodlightAccessory.refreshLightFromFirmware` | **child 642 waking the parent** |
| 08-25 18:28:01 | `ReolinkCamera.fetchSnapshotWithSingleFlight` | **legitimate** — the snapshot forced by the operator, the only autonomous touch allowed by D173 §5 |
| 08-25 20:35:13 | `SirenAccessory.onProbe` | **child 641 waking the parent** |

The two wake-ups via accessory are not a coincidence. The accessories have an
explicit branch that forces the wake-up: `… onProbe forcing wake — initial probe with no
cached state`, **53 occurrences in 7 days** across the three children 641/642/643
(`accessories/siren.ts:187`, `floodlight.ts:247`, `pir.ts:234`). Almost all
fall on an already-open socket and therefore cost nothing — `ensureApi`
returns `this.api` before reaching the login. Two do not.

The gate `if (this.isBattery && this.sleeping)` protects `ReolinkCamera.onProbe`
(`reolink-camera.ts:849`). **It does not protect `SirenAccessory.onProbe` nor
`FloodlightAccessory.refreshLightFromFirmware`**: the accessories have a rule of
their own (`… onProbe skipped — parent battery cam is sleeping (have cached state)`,
`siren.ts:176` / `floodlight.ts:236` / `pir.ts:222`, **373 times in 7 days** across
the three) that **yields when the cache is empty** — and the cache is empty at every boot in
which the accessory's slice was not restored. It is D173's `onProbe` reappearing one
level down, where the original census did not look.

### 2.3 Who did NOT wake it — the gate that holds

Everything else stopped, and wrote it. Counts over 7 days,
`tags.deviceId == 106`:

| refusal | occurrences 7 d | site |
| --- | ---: | --- |
| `cap options: battery cam sleeping — serving cache, not probing` | **2939** | `reolink-camera.ts:3649` |
| `cap status refresh skipped — battery cam is sleeping` | **514** | `reolink-camera.ts:3794` |
| `Broker registered idle — no demand, source dial deferred` (×4 brokers) | **472** | stream-broker |
| `… onProbe skipped — parent battery cam is sleeping (have cached state)` (641/642/643) | **373** | `accessories/{siren,floodlight,pir}.ts` |
| `onProbe skipped — battery cam is sleeping (no login, no wake)` | **237** | `reolink-camera.ts:850` |
| `refreshParentSettingsSnapshot skipped — battery cam is sleeping` | **64** | `reolink-camera.ts:943` |
| `battery refresh skipped — cam sleeping, reading restored slice` | **43** | `reolink-camera.ts:2240` |
| `stream catalog restored from the durable slice (no camera contact)` | **43** | `reolink-camera.ts:6053` |
| `battery-update: cam sleeping — skipping cycle without connecting` | **33** | `reolink-camera.ts:6653` |
| **total refusals recorded** | **4718** | |

Exact sums over 7 non-overlapping 24 h windows, none of which hit
the 5000-line ceiling. **4718 refusals recorded against 31 logins: 152 to 1.** And
this counts only the branches that announce themselves — the catalog sweep (§2.4) is
another 2880 occasions a day that do not even produce a line.

And the demand vectors, counted explicitly over 7 days:

| vector | occurrences |
| --- | ---: |
| `wake-on-play …` (stream-broker) | **0** |
| `battery wakeForStream …` | **0** |
| `proactive action: waking sleeping battery cam` | **0** |
| `recorder: battery camera ready for recording` | **0** |
| `snapshot: wake capture landed` | 5 |
| `Sleep poll detected awake` / `Reolink camera woke up` | 7 / 1 |

**Nobody ever opened a stream on the Baby monitor in 7 days.** No
recorder, no grid, no player. The 5 `wake capture landed` are
the snapshot addon which, seeing the `sleeping: true → false` edge, grabs
a frame on a camera that is **already awake** (`snapshot.addon.ts:849-877`, protected
by a re-read of the state before every dial): they do not wake it, they take advantage.

### 2.4 `reconcileAllCatalogs` — the fleet sweep every 30 s

Checked because it is the obvious suspect. `stream-broker-manager.ts:3052-3102`,
armed in `stream-broker/addon.ts:622` at `catalogReconcileIntervalSec: 30`.
It runs over the **whole** fleet, battery cameras included
(`stream-broker-manager.ts:3095`), and does **not** read the battery slice.

It does not need to: it asks for `projection: 'slim'`
(`stream-broker-manager.ts:3065` — only `id`, `type`, `isCamera`, `disabled`) and the
refusal sits one layer below, in the provider, where `buildStreamCatalogUncached`
serves from the RAM cache (`:5639`), then from the durable ledger (`:5648`), and only as
a last resort would stop on the gate (`:5761`). The 40 lines
`stream catalog restored from the durable slice (no camera contact)` are that
sweep answering without touching the radio. **The fleet queries it 2880 times
a day and the camera does not notice.** This part of D173 works as
written.

---

## 3. Is the consumption anomalous?

### 3.1 Compared to what

There is no comparable peer (§1). The comparison is day against day, and the
metric that counts is **logins**, not log lines.

Logins per day: `7, 6, 5, 2, 8, 3, 0` — average **4.4/day**, no peak that
resembles a burst. Compared with the cost *avoided*: **4718 refusals
recorded against 31 logins, 152 to 1** (§2.3), plus 2880 reconciles a day that
do not leave even one line. In that sense the answer is: yes, the battery has
been respected.

But the 4.4 logins/day are not demand. The demand in 7 days is **1 snapshot**.
The others are a by-product of the **provider restart**: 65 boots in 7 days,
~9/day, and about half of them end with a login within the first second.

### 3.2 The boot is the variable, and it comes in two flavours

A boot of the 640 does one thing or the other, and the difference is sharp:

**Type A — clean** (real example, 08-25 21:10):
```
21:10:36  Reolink stream-params cap registered
21:10:36  battery-update: periodic refresh armed        META={"intervalMs":3600000}
21:10:37  stream catalog restored from the durable slice META={"count":4,"sleeping":true}
21:10:38  onProbe skipped — battery cam is sleeping (no login, no wake)
          … and then 21:10:55, 21:12:08, 21:17:08, 21:32:08, 22:02:08, 23:02:08
```
The slice says `sleeping: true`, the gate holds, the kernel's retry chain
(15 s → 60 s → 5 m → 15 m → 30 m → 60 m) idles for hours without a single login.
**Cost to the battery: zero.**

**Type B — with a wake-up** (real example, 08-22 08:36):
```
08:36:01  Reolink stream-params cap registered
08:36:01  Connecting to Reolink                         META={"port":9000,"transport":"udp"}   ← LOGIN
08:36:06  Reolink camera flagged as battery (from autodetect)
08:36:13  stream catalog persisted to the durable slice
08:36:20  Reolink features probed + persisted
08:36:28  Sleep poll detected sleep — closing active streams
08:36:28  battery sleep state committed                 META={"sleeping":true,"source":"sleep-poll"}
08:37:03  idle_disconnect  {"elapsedMs":30001}
08:37:03  Battery cam disconnect — deferring reconnect to next demand
```
The login is at **second zero**, before the catalog restore line. Then, 27
seconds later, the system itself establishes that the camera **was sleeping**:
`commitSleepState` writes only on change (`reolink-camera.ts:2328`,
`if (this.sleeping === next) return false`), so a commit to `true` proves that
the in-memory value was `false` a moment earlier. The camera stays up ~62 s and
goes back to sleep.

This pattern repeats **on 20+ boots of the 31 logins**, always identical, always with
the `false → true` commit from `sleep-poll` between 27 and 60 seconds after the login.

### 3.3 The cost, honestly

31 logins × ~60 s awake ≈ **31 minutes of radio in 7 days**, against 1 snapshot
requested by a human. On an Argus 3E it is not a disaster — but it is a consumption that
**nobody asked for**, and it is the same class of defect that D173 already corrected
once ("~25 wakes a day across restarts, none of them asked for by anybody").
Today we are at ~4.4/day: a 5× improvement, not a closure.

And the cost scales with the **deploy cadence**, not with usage. A working day
on the repo costs the Baby monitor more than a week of surveillance.

---

## 4. Does the gate exist? Is it respected?

**It exists, it is dense, and it is respected by everything periodic.** Three gaps,
in order of certainty.

### 4.1 CERTAIN — the child accessories bypass the parent's gate

`reolink-camera.ts:849` protects `ReolinkCamera.onProbe`. The accessories 641/642/643
have a gate of their own, which **yields when their cache is empty**:

- `SirenAccessory.onProbe` → 08-25 20:35:13, login recorded with the stack
- `FloodlightAccessory.refreshLightFromFirmware` → 08-21 06:15:01, same

Proof lines, verbatim from the production log:
```
battery cam login while sleeping — this wakes the camera. caller:
  at get api (…/addon-provider-reolink/dist/addon.js:227323:22)
  <- at SirenAccessory.onProbe (…/addon-provider-reolink/dist/addon.js:227367:23)
```
```
battery cam login while sleeping — this wakes the camera. caller:
  at get api (…/addon-provider-reolink/dist/addon.js:227240:22)
  <- at FloodlightAccessory.refreshLightFromFirmware (…)
```

The branch that yields announces itself, 75 times in 7 days:
`siren|pir|floodlight onProbe forcing wake — initial probe with no cached state`.
The corresponding refusal,
`… onProbe skipped — parent battery cam is sleeping (have cached state)`, is the
proof that the gate exists and that the `have cached state` condition is what disarms
it. D173 §1 says «Lifecycle entry points (`onProbe`, constructor seeds) are
held to it exactly like polls»: **the accessories' `onProbe`s are not.**

The test that should prevent it,
`packages/addon-provider-reolink/src/__tests__/battery-autonomous-wake-census.spec.ts`,
covers `ReolinkCamera` and not the accessories.

### 4.2 CERTAIN — the attribution log is blind on 28 of the 31 logins

`reolink-camera.ts:9312-9324`, inside `ensureApi()`:

```ts
if (this.isBattery && this.sleeping) {
  const frames = new Error('wake-attribution').stack?…
  this.ctx.logger.info(
    `battery cam login while sleeping — this wakes the camera. caller: ${frames}`,
    { tags: { deviceId: this.id } },
  )
}
```

The guard is **the same condition as the gates**. So the tool born to
name who wakes a sleeping camera is silent exactly when
`this.sleeping` is `false` — which is the condition in which all the gates open and in
which, by construction, the unwanted wake-ups happen.

Measurement: **31 logins, 3 named, 28 anonymous.** And the 28 anonymous ones are not harmless: in
20+ cases the system itself, 27 s later, wrote `sleeping: true` — that is, it
established that the camera was asleep when we called it.

This is the most expensive defect of the three, because it is the one that prevents
solving §4.3. It is also the smallest to fix (§6.1).

### 4.3 OPEN — why `sleeping` is `false` at the start of half the boots

Not resolved, and I do not want to fill it with hypotheses. The facts:

- The `battery` slice declares `durability: 'restored'`
  (`packages/types/src/capabilities/battery.cap.ts:133`) with
  `empty: { …, sleeping: false, … }` (`:114`).
- The restore **works**: over 43 boots the line
  `stream catalog restored … META={"sleeping":true}` reads the correct value from the
  getter — `sleeping: true` in **all 43**, without exceptions — and on those boots
  `onProbe` is refused.
- On ~31 boots the login starts at second zero and the `false → true` commit arrives
  27–60 s later: the value was `false`.
- Between the two boots of 08-22 08:36 and 08:49 there is **no** commit to `false`.
  The in-memory value was `true` at 08:36:28 and `false` at 08:49:35.
  So the `true` **did not survive the restart**, or it was not yet
  restored when the caller read it.
- `isBattery` is not the cause: it comes from `deviceCache.deviceType === 'battery-cam'`
  in the constructor (`reolink-camera.ts:1893-1897`) and the 106's `deviceCache`
  contains `"deviceType": "battery-cam"`. The line
  `Reolink camera flagged as battery (from autodetect)` at 08:36:06 is
  post-login and unconditional (`:9376-9385`), so it proves nothing about the previous
  value.
- `startBatteryUpdatePolling` is a pure `setInterval`, it does not fire at the moment of
  arming (`:6714-6722`): it is not the cause.

Two explanations remain compatible with the logs — a write not persisted before
the kill, or a race between the slice hydration and the first reader — and **the logs do not
distinguish them**, because the login's caller is not named (§4.2). It is
exactly the case where instrumentation must be added instead of deducing.

It must be said that the comment above the gate (`reolink-camera.ts:844-847`) states
the opposite: «`sleeping` reads the RESTORED `battery` slice — both are already true
before the first probe attempt». Production contradicts it ~31 times in 7
days. By the rule of this repo, a comment that describes the right design
while the code does something else **reads as verification** and is worse than nothing.

---

## 5. Off topic but urgent: the 640 has been silent for 24 hours

Emerged from the same measurement, and worth saying because it changes the reading of the 32 %.

`deviceState.getCapSlice(106, 'battery')` now:
```json
{ "percentage": 32, "charging": "none", "sleeping": true,
  "lastUpdated": 1787690134089,   // 2026-08-25 20:35:34 UTC
  "lastContactAt": 1787690100000 } // 2026-08-25 20:35:00 UTC
```

- The last contact is **the wake-up via `SirenAccessory.onProbe`** of §2.2.
- Since then: `Reolink simpleEvent received` = **0** in 24 h (against 14–18/day
  before), `Connecting to Reolink` = 0, `battery sleep state committed` = 0.
- `BATTERY_UNREACHABLE_AFTER_MS = 6 h` (`packages/types/src/device/battery-presence.ts:60`).
  With ~24 h of silence, `deriveBatteryPresence` returns **`unreachable`**,
  which by design is a fault and must be believed.

Two practical consequences:

1. **The 32 % is a 24-hour-old reading.** It is not the current level.
2. The 7 boots of the last 24 h correctly refused the login — so the
   silence is **not** the system having stopped trying: nobody tried,
   by design. The gate is doing its job and, as a side effect,
   a truly dead camera and a truly sleeping camera are indistinguishable
   until a question arrives. It is the trade-off D173 chose
   knowingly, but here it ran for 24 hours.

A human eye on the physical device is needed. From here it cannot be decided without
consuming the battery being analysed.

---

## 6. What CANNOT be known from the logs

Declared, not filled in.

### 6.1 The charge curve does not exist

**In 7 days there is not a single log line that contains the battery
percentage of the 640.** Verified:
`|~ "percentage|batteryPercent|battery level|batteryLevel"` on
`tags.deviceId == 106`, 7 windows of 24 h → **0 lines**.

The percentage lives only inside the `battery` slice, which is **a current value,
not a series**. `lastUpdated` is overwritten at every refresh. So:

- we do not know where the 640 started seven days ago;
- we do not know how much a single wake-up costs in percentage points;
- we cannot distinguish "normal consumption" from "anomalous consumption" except by counting
  the wake-ups, which is exactly what I did — a proxy, not the measurement.

The operator's question («la carica negli ultimi giorni» [the charge over the last few days]) is **not decidable
today**, and not because of the retention window: the data is never written.

### 6.2 The caller of 28 logins out of 31

See §4.2. Without that, §4.3 stays a hypothesis.

### 6.3 What the camera does when alone

The camera's PIR and onboard recording consume without going through us.
No log covers it. A 32 % can be as much one of our extra wake-ups
as a week of traffic in front of the crib.

---

## 7. Proposed instrumentation

In order of value/cost ratio. None has been implemented: this
document is a measurement, not a patch.

### 7.1 Attribute EVERY login on a battery camera — not only the "sleeping" ones

`reolink-camera.ts:9312`. Remove `&& this.sleeping` from the guard and carry the
value in the payload:

```ts
if (this.isBattery) {
  …
  this.ctx.logger.info(`battery cam login — caller: ${frames}`, {
    tags: { deviceId: this.id },
    meta: { sleepingAtLogin: this.sleeping, sliceHydrated: … },
  })
}
```

Cost: ~4 lines a day per camera and one stack capture per login (the library
builds are not minified, `vite-lib.preset.ts`, so the frames stay
readable). Benefit: §4.3 closes by itself with the next week of logs,
and the census stops being a floor.

The repo rule that justifies it: *a branch that consumes a resource without
saying so is the defect being looked for*. Here the branch does say so — but only when it already
agrees with itself.

### 7.2 A charge time series

Emit the percentage at every write of the slice (`updateBatteryCache`,
`reolink-camera.ts:2493`) as an `info` line with
`tags: { deviceId }` and `meta: { percentage, charging, sleeping, source }`.
Volume: a handful of lines a day per camera. It makes the operator's question
answerable **directly** instead of by proxy, and makes it possible to measure the
real cost of a wake-up in percentage points — which is the only way to know
whether the 31 logins really matter.

### 7.3 Extend the census to the accessories

`battery-autonomous-wake-census.spec.ts` asserts that the gate precedes
`ensureApi()` in every self-initiated path of `ReolinkCamera`. Extend it to the
classes `SirenAccessory` / `FloodlightAccessory` / `PirAccessory`, and in particular
to the `forcing wake — initial probe with no cached state` branch: an accessory that has
no cache is **not** a reason to wake the parent, it is a reason to wait for
the next natural wake-up (which D173 already uses to re-run `onProbe` for free).

To be verified by neutralisation, as the repo asks: remove the fix and
confirm that the test fails.

### 7.4 A wake counter on the slice

`BatteryStatus.wakeCount` + `wakeCountResetAt`, incremented by `markWakeIssued`
(`reolink-camera.ts:2405`). It makes the question «abbiamo rispettato la batteria» [did we respect the battery]
readable from a single tRPC call instead of seven Loki queries and a
script to work around the 1000-line truncation.

---

## Appendix — reproducibility

Non-overlapping 24 h windows are mandatory: `hl loki-query` imposes
`limit=1000` and truncates without saying so. The first pass of this investigation
returned 1001 lines and would have produced a wrong count.

```bash
# attributed wake-ups, per day, 7 days
python3 lq2.py count '{job="camstack"} |= "battery cam login while sleeping"' 7

# real logins (the unambiguous marker), device 106
python3 lq2.py count '{job="camstack"} |= "Connecting to Reolink" |~ "\"deviceId\":106[,}]"' 7

# direction of the sleep state changes (needs the META)
python3 lq2.py daysplit '{job="camstack"} |~ "\"deviceId\":106[,}]" |= "battery sleep state committed"' 7

# passive contact: the only proof of reachability that costs no battery
python3 lq2.py count '{job="camstack"} |~ "\"deviceId\":106[,}]" |= "Reolink simpleEvent received"' 7
```

`lq2.py` queries Grafana's Loki proxy with explicit bounds, `limit=5000`, and
flags `<<< HIT LIMIT` if a window touches the ceiling. No window of this
measurement hit it.

tRPC reads used, all read-only and none able to wake the camera:
`deviceManager.getDevice`, `deviceManager.listAll`,
`deviceState.getCapSlice(106|3628|3629|3825, 'battery')`,
`deviceState.getCapSlice(106, 'stream-catalog')`.
