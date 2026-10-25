# Reolink in-clip seek — measured, 2026-09-23

**Question (operator):** *"ho provato sulla reolink, il seek è possibile sulla
stessa clip a quanto pare, facciamo una nuova cattura magari?"* [I tried it on the Reolink, seeking within
the same clip seems to be possible, shall we maybe make a new capture?]

**Answer: the operator is right.** A Reolink camera CAN replay one recording
from an arbitrary instant inside it. The premise behind D597/D599/D602 —
"the camera offers no replay-from-offset, so a clip is `forward-only`" — is
wrong for this vendor. It is refused today by two bugs in
`@<github-account>/nodelink-js`, not by the firmware.

Nothing was implemented. No camera configuration was written, so there is
nothing to restore; every probe only opened replay sessions and closed them.
Probes live at `<repo-parent>/reolink-baichuan-js/tools/seek-probe/`
(`raw.ts`, `lifecycle.ts`, `probe.ts`).

---

## 1. What the protocol offers

Not a field on the cmd 5 request. A **separate command: cmd 123
`<ReplaySeek>`**, already named (but never used) in the library at
`src/protocol/constants.ts:417` as `BC_CMD_ID_REPLAY_SEEK`.

```xml
<?xml version="1.0" encoding="UTF-8" ?>
<body>
<ReplaySeek version="1.1">
<channelId>0</channelId>
<seq>1790070048</seq>
<seekTime>
<year>2026</year><month>9</month><day>22</day>
<hour>5</hour><minute>14</minute><second>37</second>
</seekTime>
</ReplaySeek>
</body>
```

Sent with **no extension** (`payloadOffset = 0`), `msgNum = 0`, class `0x6414`.
The reply is `responseCode 200` with an **empty body**.

The addressing unit is a **wall-clock instant**, not a byte offset and not an
offset within a file. `<seekTime>` has second resolution — there is no
millisecond field. The camera then snaps to the nearest I-frame.

### The official app does exactly this, inside one clip

`app/data/captures/cap-muchgow3-97ecb9` (Reolink app, standalone E1 Outdoor
PoE, 2026-09-22, 7 255 frames) contains 24 cmd 123 frames. Every one is
immediately followed by a cmd 5 replay of the file that CONTAINS that instant:

```
1215 SEEK  ch=39  2026-9-22 5:14:37
1217 REPLAY ch=40  RecM03_DST20260922_051358_051559_….mp4      (+39s into the file)
…
3579 SEEK  ch=55  2026-9-22 6:13:54
3581 REPLAY ch=56  RecM03_DST20260922_061242_061442_….mp4      (+72s)
4219 SEEK  ch=60  2026-9-22 6:14:02
4221 REPLAY ch=61  RecM03_DST20260922_061242_061442_….mp4      (+80s, SAME file)
4333 SEEK  ch=64  2026-9-22 6:14:38
4335 REPLAY ch=65  RecM03_DST20260922_061242_061442_….mp4      (+116s, SAME file)
```

The same 120-second file opened three times at three increasing offsets. That
is the operator's observation, on the wire.

---

## 2. Does the camera honour it, or answer 200 and discard?

**It honours it.** Verified by reading the BcMedia I-frame wall-clock
(`additionalHeader[0..4]`, a u32) that actually arrives — never by the absence
of an error.

### Device 107 — E1 Outdoor PoE, `v3.1.0.5223_2510172100`, standalone

Clip `RecM03_DST20260922_224944_225059` (75 s). First I-frame delivered:

| asked | first I-frame `time` | delivered offset | µs delta vs baseline |
|---|---|---|---|
| baseline, no seek | 1790117384 | +0 s | 0 |
| +17 s | 1790117402 | **+18 s** | 18.180 s |
| +33 s | 1790117418 | **+34 s** | 34.296 s |
| +34 s | 1790117418 | **+34 s** | 34.296 s |
| +50 s | 1790117434 | **+50 s** | 50.492 s |

Byte-identical transfers for +33 and +34 (`4801488` both) — they resolve to the
same keyframe.

### Device 3628 — Argus 3E via Reolink Home Hub `v3.3.0.456_25122258`, child ch0

Clip `RecM04_DST20260922_202221_202326` (65 s):

| asked | first I-frame `time` | delivered offset |
|---|---|---|
| baseline | 1790108541 | +0 s |
| +20 s | 1790108560 | **+19 s** |
| +45 s | 1790108584 | **+43 s** |

**Granularity: a keyframe.** The request is a whole second; the stream starts at
the I-frame nearest that second. Measured GOP ≈ 2 s on both devices (107:
38 I-frames over 75.61 s; hub child: 33 over 65.53 s). 592 rounded **up** to the
next I-frame, the hub child rounded **down**. So the worst case is one GOP
(~2 s) in either direction — plan for a nearest-keyframe seek, never an exact
one.

### Same on a standalone camera and a Home Hub child?

Yes — same command, same XML, same honouring, same quirks (§3), same
stickiness (§4). The only difference measured is the rounding direction.

Device **108** (E1 Outdoor Pro, `v3.1.0.5714`) **could not be measured**: it
has **zero recordings in the last 24 h** (no clip to seek inside). Its behaviour
is unknown; it is a newer firmware than 592 and should be re-probed before any
fleet-wide claim.

---

## 3. Why the library refuses it today — two real bugs

A replay that FOLLOWS a `<ReplaySeek>` comes back in a different dress, and
`BaichuanClient` misreads it twice. Both are in the nodelink-js library, not
in camstack.

Header of an ordinary (unseeked) cmd 5 data frame, and of a seeked one:

```
unseeked  f0debc0a 05000000 aa9a0000 03000000 00000000 6a000000
                                              ^rc=0 ^class=0x0000   ^payloadOffset=106
seeked    f0debc0a 05000000 aa9a0000 04000000 fc7cb36a 6a000000
                                              ^rc=0x7cfc ^class=0x6ab3 ^payloadOffset=106
```

`0x6ab3_7cfc` = **1790128892** — a unix timestamp. After a seek the camera
stamps every cmd 5 frame's `[responseCode | messageClass]` u32 with a
wall-clock second (it increments by 1 per second across consecutive probe
runs: 32245 → 32249 → 32252 …, and its high half `0x6ab3` is the same high half
as the I-frame timestamps in the same stream).

Consequences:

1. **`BaichuanClient.ts:4054`** — `const isHardError = rc >= 400 && rc < 60_000`.
   `0x7cfc` = 31996 sits in that band, so the very first data frame aborts the
   transfer with
   `Baichuan FileInfoList replay rejected (… responseCode=31996)`.
   *The camera is streaming fine; the library throws the stream away.*
2. **`constants.ts:27` `bcHeaderHasPayloadOffset`** accepts only `0x6414`,
   `BC_CLASS_MODERN_24_ALT` and `BC_CLASS_FILE_DOWNLOAD`. `0x6ab3` is not in the
   set, so the frame is parsed with a **20-byte header** instead of 24. The
   extension/payload split is lost, the body arrives shifted by 4 bytes, and
   `encryptLen` is never read — so the first 1 024 bytes of each chunk stay
   AES-encrypted. Re-slicing the frame as 24-byte-header (`payloadOffset` =
   `body.readUInt32LE(0)`) recovers a clean
   `<?xml …><Extension version="1.1"><binaryData>1</binaryData><encryptLen>1024</encryptLen></Extension>`
   and a valid BcMedia stream. That is how §2 was measured.

The same misread is visible in the app capture: its cmd 5 summary reports
`lastResponseCode: 19859` — every app replay is preceded by a seek, so every
app replay carries the stamp.

---

## 4. Cost, and session lifetime

**Time to first byte.** The seek itself costs 5–39 ms (cmd 123 round trip).
TTFB of the seeked replay is the same as, or better than, an unseeked one:

| | 592 | hub child 3628 |
|---|---|---|
| baseline replay TTFB | 283–431 ms | 409–470 ms |
| seeked replay TTFB | 75–283 ms | 31–34 ms |

Seeked replays are cheaper because the camera ships less: the transfer still
runs to the END of the file, just from the seek point.

**No new TCP session is needed.** Seek and replay travel on the same socket.
The 0.10.1 fix (a minted per-transfer `channelId`) is untouched — nothing here
needs a pinned handle.

**A seek DOES move an open transfer in place.** Injected ~700 ms into a running
cmd 5, with no new cmd 5 and no new socket, the stream jumps:

```
592        I-frames: +0s → +40s,+42s,+44s      (discontinuity at index 1)
hub 3628   I-frames: +0s,+1s → +29s,+31s,+33s  (discontinuity at index 2)
```

Measured once per device, and the transfer was then cut short by bug (1) — how
it behaves through to the end of the file is **not** established.

**A seek is STICKY on the connection — this is the trap.** On one socket:

```
1a  replay, no seek                  → 29 I-frames, +0s … +56s
    seek +40s
1b  replay                           → first I-frame +40s     (honoured)
1c  replay again, NO new seek        → first I-frame +40s     (STILL seeked)
2z  replay on a FRESH connection     → 29 I-frames, +0s … +56s
```

The seek point survives until the connection is replaced. A stale seek would
silently truncate the **next unrelated download** on that socket — and camstack
shares one `general` socket per camera. This is exactly the shape of D49/D224
faults: no error, just wrong bytes. It also explains why the official app sends
a fresh `<ReplaySeek>` before **every** replay, including the first: it is not
seeking, it is *resetting the position*. Any implementation must do the same —
send `<ReplaySeek>` to the clip's start before an unseeked download, or open a
dedicated socket.

---

## 5. Recommendation, and what it costs

Reolink clips should stop declaring `seek: 'forward'`
(`packages/types/src/capabilities/videoclips.cap.ts:940`). The enum already has
`'free'` (line 570) — no schema change is needed for the seek freedom itself.
`transport: z.literal('forward-only')` (line 490) is a separate question and
should stay as it is: what changes is that the provider can now **re-open the
stream at a new position**, not that the existing stream became rewindable.

### Library — `@<github-account>/nodelink-js` (must come first)

1. Stop treating the post-seek stamp as an error. `isHardError` cannot be a
   numeric band on a field the camera uses as a timestamp. Gate on
   "did the stream header answer 200" plus the existing idle window, and treat
   a data frame's `responseCode` as opaque.
2. Teach `bcHeaderHasPayloadOffset` the post-seek class, or better: decide the
   header length from `payloadOffset` plausibility rather than a class
   allow-list, since `0x6ab3` is data (a timestamp half), not a class id.
3. Add `replaySeek(channel, at: Date)` (cmd 123) and make
   `fileInfoListReplayBinaryDownload` take an optional `seekTo`, **always**
   emitting a `<ReplaySeek>` — to the clip start when no offset is asked — so
   stickiness can never poison a transfer.
4. Verify by read-back, never by the 200: assert the first I-frame's `time` is
   within one GOP of what was asked, and say so when it is not (the D610 shape).

Cost: roughly a day, plus a release. Items 1–2 are small but sit on the hot
path of every existing download, so they need the replay tests re-run on 592,
the hub child and the NVR before publishing.

### camstack (only after the library ships)

Declare `seek: 'free'` for Reolink, re-open the clip stream at the requested
position on a backward drag, and let `clip-controls.ts` stop refusing it.
The playhead must be treated as **approximate to one GOP (~2 s)** — the UI
should re-base on the position the stream reports, not on the position it
asked for, or the bar will drift by up to two seconds per seek.

### What I would NOT do yet

Ship anything for **618** or any firmware not in the table above. 592 rounds up
and the hub child rounds down on the same request; that alone says the
rounding rule is per-firmware, and 618 could not be measured at all.
