# Investigation: real device writes never take effect — koolenex's write path skips the entire Unload/Load/LoadCompleted sequence

**Status: RESOLVED.** Six independent, sequential root causes were found and fixed, each confirmed on real
hardware: (1) the entire missing Unload/StartLoading/LoadData/LoadCompleted sequence (this doc's original
finding, below), (2) a Restart-before-LoadCompleted-confirmed race, (3) a missing `A_Authorize_Request`,
(4) a missing `PID_PROGRAM_VERSION` read-back-and-write-back, (5) the `LoadData` "mode" byte meaning
Full(`0x01`)/Partial(`0x00`) download, not "combined full+par declaration" as first guessed, and (6) — the
final blocker, found via a verbatim real-frame replay that succeeded where koolenex's own reconstruction
kept failing — `WriteRelMem` unconditionally must use `A_MemoryExtended_Write`, never legacy
`A_Memory_Write`, regardless of whether the address fits in 16 bits. See "Fixes 2-6" and "Final resolution"
below for the full story; the original Fix-1 writeup follows unchanged as the section that started it.
This also un-retracts nothing about the 2026-08-26 "write path proven correct" finding for 1.1.10 — that
finding is still unverified against these fixes and should not be cited until it is (see "Retroactive
implication" below, still open).

## Why this came up

Wanted to close the last real gap in the write-path story: no koolenex-driven write had ever been
independently confirmed to actually change a real device (see `koolenex-reference` memory, 2026-08-28
entry, for the full methodological history — the earlier "actual-vs-actual, byte-identical" test never
ruled out a no-op write matching itself). Picked the smallest real test available: flip one boolean
parameter ("Use standard NTP server (pool.ntp.org)", `M-0004_A-0025-10-1BA6-O00A6_P-2_R-2`, relmem offset
69) on 1.1.9, the smaller of the two testbed devices, and write it for real.

## What happened

1. Set the project's configured value for that parameter to "off" via `PATCH
   /projects/6/devices/191/param-values`. Confirmed `verify-device` correctly decoded the resulting mismatch
   (`expectedValue: "off"`, `actualValue: "on"`).
2. Ran `POST /bus/program-device` for 1.1.9. Returned `{"ok":true}`. **The device's byte was unchanged
   afterward** (`0x80` before and after — bit 7 set = "on").
3. A second attempt (with tshark running) failed outright: `"Device programming failed"`. A subsequent
   read-only `verify-device` call then also failed: `"Tunneling ACK timeout"` — the known stale-session
   failure mode from 2026-08-26. Reconnecting the bus (`/bus/disconnect` then `/bus/connect`) restored read
   health; a third program attempt (no capture running, to rule out capture overhead) failed the same way.
4. To isolate the question cleanly, added a minimal `POST /bus/write-memory` debug endpoint (real write,
   unlike every other debug route in `bus.ts` — reuses the actual `downloadDevice()`/`WriteRelMem` code by
   passing the target address as objIdx `0`'s own "resolved base" with offset `0`) and manually wrote a
   single, precisely-targeted byte: read the device's real current byte (`0x80`), cleared just bit 7 to get
   `0x00`, wrote that one byte to the real absolute address (`0x5F53` = base `0x5F0E` + offset 69). **No
   error, but the readback was still `0x80` — completely unchanged.** This ruled out addressing as the
   cause (the address was independently confirmed correct via the same segment's earlier `expected`/`actual`
   chunk data) and ruled out the byte-packing bug below as the cause (a single, hand-picked correct byte
   still didn't take).

At this point the server needed restarting to pick up the new endpoint — it wasn't running under a
supervised/tracked process this session (a leftover from an earlier session's background task), so it was
killed and restarted under session tracking, giving visibility into its own logs for the first time this
session.

## Root cause: the entire Unload → Load → LoadCompleted sequence is missing

Captured yesterday's real ETS Full Download to 1.1.9 in full (not just the `MemExtWrite`/PID-7 frames
already documented in `2026-08-27-relmem-write-scope-investigation.md` — every frame, including the
`PropValueWrite`/`PropValueResp` traffic around them) and compared it directly against koolenex's own
`model.loadProcedures` for this app (`data/apps/M-0004_A-0025-10-1BA6-O00A6.json`).

**Real ETS sequence** (`PID_LOAD_STATE_CONTROL` = property 5 on each interface object):

1. **Unload** every relevant object, in reverse index order: `PropValueWrite OX=5,4,3,2,1 P=5 event=$04`
   (Unload) → each replies state `$00` (Unloaded).
2. For **each** object that has data to write — `4` (parameters), `3` (unidentified, 98 bytes), `2`
   (association table), `1` (GA table), in that order:
   - `StartLoading`: `OX=<n> P=5 event=$01` → state `$02` (Loading)
   - `LoadData` — **this *is* the `RelSegment` step**: `OX=<n> P=5 event=$03 data=...` (exact byte layout
     below) → state stays `$02`
   - Real memory write(s) (`MemExtWrite`/`Memory_Write`) to that object's PID-7-resolved base
3. **LoadCompleted**: `PropValueWrite OX=4,3,2,1 P=5 event=$02` → state `$01` (Loaded)
4. `RestartReq`

**`LoadData` wire format**, decoded from all four real examples (event `0x03` + 9 more bytes):

```
byte:   0    1    2-3    4-5        6      7      8-9
        evt  SCF  rsvd   size(BE)   mode?  fill   rsvd
objIdx4: 03   0B   0000   1FF2(8178) 01     FF     0000   (matches model's declared size=8178,fill=255)
objIdx3: 03   0B   0000   0062(98)   00     00     0000
objIdx2: 03   0B   0000   000A(10)   00     00     0000
objIdx1: 03   0B   0000   0006(6)    00     00     0000
```

`size` matches each object's real write size exactly across all four independent real examples - high
confidence. `mode`/`fill` bytes only confirmed non-zero for objIdx4 (the one object with an explicit
`RelSegment` entry - `fill: 255` - in the model); the other three objects have no model entry to
cross-check against, so `mode=0x01` (possibly a "combined full+par" flag, since only objIdx4 has separate
`full`/`par` `RelSegment` declarations in the model) is a working guess, not confirmed.

**koolenex's `model.loadProcedures` for this app** has only: 2× `CompareProp`, 1× `CompareProp`, 2×
`RelSegment` (objIdx 4 only, `full`/`par`), 1× `WriteRelMem` (objIdx 4 only). **No `Unload`, no
`StartLoading`, nothing at all for objIdx 1/2/3, no `LoadCompleted`, no `Restart`.** And even the two
`RelSegment` steps the model *does* have are silently dropped - `downloadDevice()`'s step executor
(`server/knx-connection.ts`, the legacy inline-loop switch) has cases for `WriteProp`/`CompareProp`/
`WriteRelMem`/`LoadImageProp` only; `'RelSegment'` isn't one of them, so it hits no case and does nothing.

**This is not two separate gaps to weigh differently - they compound into one outcome**: koolenex's model
of what a download *is*, as extracted from the real project data, doesn't include the load-state machinery
or the objIdx 1/2/3 steps at all; and the one piece of load-state machinery the model does encode isn't
even executed. Every `WriteRelMem` koolenex has ever sent goes out completely raw, with the target
interface object never put into "Loading" state - which real device firmware is expected to (and, per
every test above, does) simply ignore.

## Direct confirmation from koolenex's own real wire traffic (not just code reading)

Captured koolenex's own second `program-device` attempt (the one that later errored) via tshark. Its real
UDP traffic to the router shows, immediately after resolving `objIdx 4`'s PID-7 base:

```
Connect → PropValueRead OX=4 P=7 → PropValueResp $00005F0E → Disconnect → Connect →
MemWrite N=10 X=$5F0E $FFFFFFFFFFFFFFFFFFFF  (raw legacy Memory_Write, no Unload/StartLoading/LoadData at all)
MemWrite N=10 X=$5F18 $FF...
... (repeats ~818 times, 10 bytes/chunk, the entire 8178-byte segment blind-filled with 0xFF) ...
```

(Note: Wireshark's own KNXnet/IP dissector mis-displays this frame's address in its summary column as
`X=$0A5F` - manually decoding the raw APDU bytes the same way `parseCEMI()` does confirms the real address
field is `0x5F0E`, correct. Don't trust the summary column for this frame shape; decode the hex directly.)

Zero `PropValueWrite ... P=5` frames appear anywhere in this capture. This is direct, wire-level proof of
the code-reading conclusion above, not an inference from it.

**Also observed, likely consequential**: this blind full-segment write takes ~25 seconds (818 chunks ×
30ms delay) and ends in a `Disconnect`/failed `Connect` reconnect storm - plausibly the device's own
protection against a sustained flood of writes it can't act on (every chunk outside Loading state), though
this specific causal link isn't confirmed.

## A separate, smaller bug found along the way: wrong padding-bit fill

Before any of the above, `buildParamMem()`'s computed byte for offset 69 didn't match reality even in
principle: real device (and real ETS) value is `0x80` (bit 7 set for "on", all other bits **clear**) -
`P-2_R-2` is a 1-bit boolean (`bitOffset:0, bitSize:1`) packed into that byte alongside other, unnamed
bits. koolenex computes `0xFF` for "on" and `0x7F` for "off" - correctly toggling bit 7, but filling the
*other* 7 bits with `1`s as "unknown padding" default, when the real device has them as `0`. Confirmed via
direct code test (`buildParamMem()` called standalone with `{}` vs the changed param value). This is a
genuine, separate write-correctness bug (independent of the missing Load sequence above) that would still
need fixing even once writes actually reach the device.

## Fixes 2-6: what it took to get from "Fix 1 shipped" to an actual persisting write

Fix 1 (the sequence above) shipped as koolenex commit `1620fa5`. Real-hardware retesting after each
subsequent fix kept finding the byte still didn't persist, prompting the next fix. This section is the log
of that chain, compressed — full detail lives in `koolenex-reference` memory (knx-ets-manager repo) and the
git history of `test/relmem-real-device-fixtures`.

- **Fix 2 (`b09dc1e`) — Restart-before-confirmation race.** `propWrite()` originally used a fixed `delay(50)`
  after each Load State write instead of waiting for the device's actual `PropertyValue_Response`. Rewrote
  it (and added `propRead()`) to use the pre-existing `waitResponse()` pattern properly.
- **Fix 3 (`731c36b`) — missing `A_Authorize_Request`.** Real ETS sends this (well-known key `0xFFFFFFFF`)
  before any RelSegment-driven write; koolenex never did. Neither `Authorize_Request/Response` nor
  `PropertyValue_Write/Read` are in `parseCEMI`'s `APCI_EXT_NAMES` table, so matching frames requires
  recomputing the full 10-bit APCI manually (`((apdu[0]&0x03)<<8)|apdu[1]`) rather than trusting
  `apciName`.
- **Fix 4 (`f5588c7`) — missing `PID_PROGRAM_VERSION` write-back.** Real ETS reads `PID_PROGRAM_VERSION`
  (objIdx 4, property 13) early, then writes the identical value straight back right before
  `LoadCompleted` — found only after the user explicitly pushed back on the methodology ("I am wondering if
  there is more in the total captured data that we are missing/inadvertently ignoring") when two prior
  narrow, hypothesis-driven greps of the same full capture had both missed it. A genuinely complete,
  systematic frame-type-sequence extraction of every frame (not a targeted grep) is what actually found
  this gap.
- **Fix 5 (no code change, a corrected understanding) — the `LoadData` "mode" byte.** Originally guessed as
  a "combined full+par declaration" flag (see the original Fix-1 section above, `mode=0x01` "possibly...").
  A dedicated real-hardware experiment — three consecutive user-triggered ETS downloads (Full, Partial
  NTP-off, Partial NTP-on), captured and split into
  `2026-08-28-ets-{1,2,3}-*-1.1.9.pcapng` (`docs/data/captures/`, knx-ets-manager repo) — showed the mode
  byte is `0x00` on **both** independent Partial Downloads despite the model still declaring `full`+`par`
  RelSegment entries for objIdx 4, while the Full Download showed `0x01`. Real meaning: Full(`0x01`) vs
  Partial(`0x00`) download type. This on its own stopped the erasure-to-`0xFF` behavior seen before, but
  still didn't make a targeted new value persist — a real, necessary, but not sufficient fix.
- **The decisive experiment — verbatim frame replay.** Rather than keep guessing, built
  `POST /bus/replay-frames` (`server/routes/bus.ts` + `KnxBusManager.replayFrames()`,
  `server/knx-bus.ts`, commit `541c134`) to fire the real captured Partial-Download-NTP-off frame sequence
  (all 49 ETS→device request frames from `2026-08-28-ets-2-partial-download-ntp-off-1.1.9.pcapng`, extracted
  and byte-verified) at real hardware **verbatim** — no koolenex APDU reconstruction at all, just the raw
  bytes replayed through the existing tunnel. **This persisted correctly**
  (`2026-08-28-verbatim-replay-success-1.1.9.pcapng`): `0x5F53` read back `0x00` after reconnect, matching
  ETS's own real written value exactly. This proved the wire-level content itself is sufficient — the
  remaining bug was entirely in koolenex's own reconstruction, not anything fundamental about the device,
  the network path, or KNX Secure/tunneling behavior.
- **Fix 6 (`68c0394`) — the actual final bug: legacy vs extended memory write.** Diffed koolenex's own
  `/bus/write-memory` reconstruction of the identical operation (same address `0x5F53`, same count, same
  data, mode-byte fix from Fix 5 already applied) frame-by-frame against the successful verbatim replay.
  Captured as `2026-08-28-koolenex-legacy-write-fail-1.1.9.pcapng` — confirmed to silently fail to persist,
  twice reproducibly. The diff found exactly one byte-level difference: koolenex's `WriteRelMem` loop
  (`server/knx-connection.ts`) picked legacy `A_Memory_Write` for this chunk because `addr <= 0xFFFF`
  (`0x5F53` fits easily), while real ETS used `A_MemoryExtended_Write` unconditionally — confirmed via raw
  hex decode, not tshark's own (known-unreliable, see the note in the original Fix-1 section) summary
  column. This device's application program apparently only honors the extended service on the
  RelSegment-gated download path; the legacy write is a **silent** no-op — no error, no rejected-write
  signal, nothing — which is exactly why every earlier fix (1 through 5) succeeded at the protocol level
  (correct Load State transitions, correct `PropValueResp ... $01` confirming "Loaded", correct `Restart`)
  while the underlying byte write itself was quietly ignored the whole time. Removed the `addr > 0xFFFF`
  conditional entirely — `WriteRelMem` now always uses `A_MemoryExtended_Write`.

## Final resolution: confirmed on real hardware

After Fix 6, the NTP-server-source parameter at 1.1.9 (`0x5F53`) was flipped `0x80`→`0x00`→`0x80`→`0x00`
across four separate real downloads/reconnects via koolenex's own (fixed) write path, each value
independently confirmed via a fresh `read-memory` call after a full disconnect/reconnect cycle. The write
path genuinely works now, for this device/app at least (1.1.10, and the still-unidentified objIdx 3, and
the GA/Association table format for objIdx 1/2, remain open — see below).

## Retroactive implication: the 2026-08-26 "write path proven correct" finding is now unsafe to rely on

That finding (koolenex-driven download vs fresh ETS-native download, `actualHex` diffed directly,
0/10433 bytes differ) used **1.1.10**, an app with the same `RelSegment`-based load-procedure shape as
1.1.9 (confirmed - see `docs/data/apps/M-0004_A-3030-23-F0EA-O000A.json`'s `loadProcedures`, which also
opens with two `RelSegment` steps). If the same gap applies there (not yet independently re-tested, but
there is no reason to expect otherwise - same step type, same missing switch case), the most likely
explanation for that "success" is a false positive: koolenex's download was a no-op, so "device state
after koolenex's no-op" trivially equals "device state ETS had just written moments before" - identical
readbacks that look like proof of a working write, produced by a write that never happened.

**Don't cite that 2026-08-26 result as evidence the write path works** until it's re-run against a real
fix for this gap.

## What this does and doesn't settle

**Settled**:
- Root cause of every failed/no-op write attempt this project has made against 1.1.9: six compounding gaps
  (Fixes 1-6 above), the last and most stubborn being a silent legacy-vs-extended memory write mismatch
  with no error signal of any kind.
- The real wire format for `LoadData` (the `RelSegment` step's real on-the-wire shape, mode byte meaning
  finally settled as Full/Partial), decoded from real examples across both a Full and two independent
  Partial Downloads.
- `A_Authorize_Request` and `PID_PROGRAM_VERSION` write-back are both required parts of the real sequence,
  not optional.
- `WriteRelMem` must always use `A_MemoryExtended_Write`, never the legacy service, regardless of address
  size, at least for this device/app.
- **The write path works**: confirmed reproducibly on real hardware (1.1.9), four separate real
  downloads/reconnects, byte flipped both directions correctly each time.
- A separate, unrelated byte-packing bug in `buildParamMem()`'s padding-bit fill (still not fixed - see
  below).

**Not yet done / open**:
- The `buildParamMem()` padding-bit fill bug - root-caused, not fixed. Real device value is `0x80` (bit 7
  set, others clear); koolenex fills the other 7 "padding" bits with `1`s instead of `0`s.
- Whether 1.1.10 (and any other `RelSegment`-family device) needed all six fixes too, confirmed empirically
  rather than by analogy - not yet re-tested since these fixes landed. The 2026-08-26 "write path proven
  correct" finding for 1.1.10 specifically should still not be cited until it is (see "Retroactive
  implication" below).
- The GA/Association table (objIdx 1/2) wire format - still uses a guessed format, unfixed (per the
  2026-08-27/28 GA-wire-format work).
- What objIdx 3 actually is (still just "possibly per-channel mapper config", unconfirmed, per the
  2026-08-27 doc).
- Whether the fix generalizes: this was confirmed for exactly one app (`M-0004_A-0025-10-1BA6-O00A6`, the
  IP router's additional-function app) on exactly one device. Whether *every* device always requires
  extended writes, or whether some genuinely do use legacy writes for low addresses (making Fix 6's
  "always extended" the wrong generalization rather than just the right fix for this device), is untested.
  If a future device is confirmed to need real legacy writes, this will need revisiting into a per-device or
  per-app flag rather than a blanket "always extended".
- **Longer-term**: none of these fixes came from fixing the *model extraction* (how `model.loadProcedures`
  is built from real project XML during import) - they're all in the hand-written `downloadDevice()`
  executor. The original Fix-1 writeup's "two shapes to choose between" framing (fix the importer vs.
  reconstruct generically in the executor) was effectively resolved in favor of the executor approach by
  default, not by a deliberate decision - worth revisiting once more apps/devices are tested, since a
  model-extraction fix would generalize automatically where the executor approach needs each new
  requirement (Auth, PID13, mode byte, extended-vs-legacy) hand-added.

## Artifacts

- Capture: `2026-08-28-ga-wire-format-1.1.9-1.1.10.pcapng` (`docs/data/captures/` in the knx-ets-manager
  repo, already saved for the GA/Association table wire-format work) - the real ETS Full Download used to
  decode the `LoadData` format above.
- Capture: `2026-08-28-koolenex-write-attempt-1.1.9.pcapng` (same folder) - koolenex's own failed write
  attempt from Fix 1's investigation, showing the missing Load sequence directly on the wire (raw `MemWrite`
  straight after the PID-7 resolve, no `PropValueWrite ... P=5` anywhere).
- Captures: `2026-08-28-ets-{1,2,3}-{full,partial-ntp-off,partial-ntp-on}-download-1.1.9.pcapng` (same
  folder) - the three consecutive real ETS downloads used to settle the LoadData mode-byte meaning (Fix 5)
  and as the source frames for the verbatim replay (below).
- Capture: `2026-08-28-verbatim-replay-success-1.1.9.pcapng` (same folder) - koolenex replaying the real
  Partial-Download frames verbatim; succeeded, pinning the remaining bug to koolenex's own reconstruction.
- Capture: `2026-08-28-koolenex-legacy-write-fail-1.1.9.pcapng` (same folder) - koolenex's own
  reconstruction of the identical operation, captured specifically to diff against the verbatim replay;
  this diff found Fix 6.
- Endpoint: `POST /bus/write-memory` (`server/routes/bus.ts`) - writes an exact byte sequence to an
  absolute address, reusing the real `downloadDevice()`/`WriteRelMem` path (not a separate implementation).
  Optionally opts into the real Load State sequence via a `relSegment` param. Real-hardware debug tool, not
  intended for routine use.
- Endpoint: `POST /bus/replay-frames` (`server/routes/bus.ts` + `KnxBusManager.replayFrames()` in
  `server/knx-bus.ts`) - replays a literal sequence of real captured CEMI frames verbatim, no
  reconstruction at all. Built for, and instrumental in, the decisive experiment above. Real-hardware debug
  tool, not intended for routine use.
- `koolenex-reference` memory (knx-ets-manager repo's persistent memory) has the fuller methodological
  history, including the 2026-08-28 update documenting all six fixes and the final resolution.
