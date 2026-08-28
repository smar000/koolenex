# Investigation: real device writes never take effect — koolenex's write path skips the entire Unload/Load/LoadCompleted sequence

**Status: root cause confirmed via real hardware AND real wire-level capture of koolenex's own traffic — not
inference. Not yet fixed.** This substantially undermines the earlier 2026-08-26 "write path proven correct"
finding (see "Retroactive implication" below) — treat that finding as unsafe to rely on until re-verified
against a real fix.

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
- Root cause of every failed/no-op write attempt this project has made: `RelSegment`/Unload/StartLoading/
  LoadCompleted are missing from both the load-procedure *model* (as extracted from real project data) and
  the *executor* (`downloadDevice()`'s step switch).
- The real wire format for `LoadData` (the `RelSegment` step's real on-the-wire shape), decoded from four
  independent real examples.
- A separate, unrelated byte-packing bug in `buildParamMem()`'s padding-bit fill.
- The 2026-08-26 "write path proven correct" finding should not be trusted until re-verified.

**Not yet done / open**:
- The fix itself - not written. Two shapes to choose between: (a) fix whatever in the importer builds
  `model.loadProcedures` from the real project XML, so it captures the full real sequence (more
  foundational, benefits every future import); or (b) reconstruct the missing sequence generically inside
  `downloadDevice()` from data it already has (`paramMem`→objIdx4, `gaTable`→objIdx1, `assocTable`→objIdx2,
  objIdx3 still unidentified - see the 2026-08-27 doc's Finding 2). Neither attempted yet.
- Whether 1.1.10 (and any other `RelSegment`-family device) has the exact same gap, confirmed empirically
  rather than by analogy - the load-procedure shape matches, but a fresh real capture of 1.1.10's own
  download (not just the byte offsets already documented) hasn't been done.
- The `buildParamMem()` padding-bit fill bug - root-caused, not fixed.
- What objIdx 3 actually is (still just "possibly per-channel mapper config", unconfirmed, per the
  2026-08-27 doc).

## Artifacts

- Capture: `2026-08-28-ga-wire-format-1.1.9-1.1.10.pcapng` (`docs/data/captures/` in the knx-ets-manager
  repo, already saved for the GA/Association table wire-format work) - the real ETS Full Download used to
  decode the `LoadData` format above.
- Capture: `2026-08-28-koolenex-write-attempt-1.1.9.pcapng` (same folder, new) - koolenex's own failed
  write attempt, showing the missing Load sequence directly on the wire (raw `MemWrite` straight after the
  PID-7 resolve, no `PropValueWrite ... P=5` anywhere).
- New endpoint: `POST /bus/write-memory` (`server/routes/bus.ts`) - writes an exact byte sequence to an
  absolute address, reusing the real `downloadDevice()`/`WriteRelMem` path (not a separate implementation).
  Unlike every other debug route in this file, this one writes to real hardware - built specifically for
  this diagnosis, not intended for routine use.
- `koolenex-reference` memory (knx-ets-manager repo's persistent memory) has the fuller methodological
  history of why the write path's status was already in question before this investigation.
