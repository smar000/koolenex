# KNX device write protocol — consolidated reference

**Status: living reference document, not an investigation log.** Everything here is either
directly sourced from a real captured ETS session (cited by capture file + frame number) or
explicitly marked as a hypothesis/guess. This document supersedes nothing — the dated
`docs/follow-ups/*.md` files remain the historical investigation record — but is intended as
the one place to check before touching device-write code again, instead of reconstructing the
picture from those logs. Update this file, not a new dated follow-up, when a fact here changes.

## How to read this document

Every factual claim below is tagged:

- 🟢 **CONFIRMED** — directly observed in a real captured ETS session or on real hardware, with
  the capture file and frame number(s) cited. Trust this.
- 🟡 **INFERRED** — a reasonable conclusion from confirmed evidence, but not independently
  verified in isolation (e.g. "X is present in every capture, so it's probably required" without
  a controlled test that removes X and shows failure).
- 🔴 **SPECULATIVE** — a guess, theory, or hypothesis with no direct evidence. Treat these as
  open questions, not facts. Several speculative theories elsewhere in this project's history
  turned out to be wrong when actually tested (see "Retracted theories" below) — do not
  upgrade a 🔴 to a 🟢 without a real test.

Sample-size caveats apply throughout: **all real-hardware evidence in this document comes from
exactly two physical devices, both Albrecht Jung, both on one local testbed, both the same KNX
mask family (System B, `0x07B0`)**. Nothing here has been confirmed against a different
manufacturer, a different mask family, or hardware outside this testbed. Where this matters for
a specific claim it's called out again inline, but keep it in mind throughout.

## Devices/apps this document is grounded in

| Device | Individual addr | Mask version | App ID | Serial | Role |
|---|---|---|---|---|---|
| Jung KNX IP Router (additional function) | 1.1.9 | `07B0` (System B) 🟢 | `M-0004_A-0025-10-1BA6-O00A6` | `00A625401D94` | Primary test device — every capture in this document except where noted |
| Jung 4-gang dimmer actuator | 1.1.10 | `07B0` (System B) 🟢 | `M-0004_A-3030-23-F0EA-O000A` | (not recorded here) | Secondary test device — real base > `0xFFFF` (`0xC3000`), used for the address-truncation finding and cross-checks |

Mask versions confirmed via a live `A_DeviceDescriptor_Read` against the real testbed
(2026-08-28, this session) and cross-referenced against this project's own bundled KNX Master
Data (`data/knx_master_<projectId>.xml`), whose `<MaskVersion>` table classifies mask `07B0`
(and the PL/RF/IP medium variants `17B0`/`27B0`/`57B0`) as `ManagementModel="SystemB"` — a real
KNX-standardized device-family classification, not manufacturer-specific config. 🟢

## Part 1 — The real ETS download sequence

### 1.1 Full Download, decoded frame-by-frame

Source: `docs/data/captures/2026-08-28-ets-1-full-download-1.1.9.pcapng` (real ETS "Download
All" to 1.1.9, captured 2026-08-28, part of a 3-download session also covering both Partial
Download variants below — same device, same session, cleanest available apples-to-apples
comparison). All frame numbers below refer to this file. 🟢 throughout this subsection unless
marked otherwise.

**Stage 0 — connection churn before the real work starts** (frames 13-109): ETS opens and closes
several short-lived management connections, doing a `DevDescrRead`, an `IndAddrSerNumRead`
(serial-number broadcast lookup), and even a defensive `RestartReq` — then disconnects and
reconnects several more times before settling into the connection that does the actual work.
🟡 **INFERRED**: this looks like ETS's own pre-flight device-identity/health checks, possibly
including a defensive restart if it isn't sure of the device's prior state — not confirmed from
any ETS documentation, just observed behavior. Not everything here is necessarily required for a
correct download; don't assume every frame in this stage matters.

**Stage 1 — identity/config reads** (frames 109-166), all `A_PropertyValue_Read` unless noted:

| Frame | Object | Property | Purpose (as far as known) |
|---|---|---|---|
| 111 | OX=0 | P=56 | 🔴 unidentified — some device object (OX=0) property |
| 117 | — | — | `A_Authorize_Request` (key `0xFFFFFFFF`) — see §2.2 |
| 123 | OX=2 | — | `A_PropertyDescription_Read` P=23 → response `PDT=20 N=1024 R=3 W=3` — 🔴 purpose unconfirmed, likely a capability probe of the Association table object before touching it |
| 129 | OX=0 | P=11 | Serial number readback (response matches the device's real serial `00A625401D94`) |
| 135 | OX=0 | P=25 | 🔴 unidentified, 2-byte response `$0080` |
| 141 | OX=0 | P=78 | 🔴 unidentified, 6-byte response `$000000250001` (looks like a hardware-type field) |
| 147 | OX=0 | P=15 | 🔴 unidentified, 10-byte response `$048C0000000000000000` |
| 154 | OX=0 | P=12 | 🔴 unidentified, 2-byte response `$0004` (matches the manufacturer ID field seen elsewhere) |
| 160 | OX=0 | P=78 | Same property re-read a second time — 🔴 unclear why |
| 166 | OX=4 | P=13 | `PID_PROGRAM_VERSION` read — response `$0004002510`, written back verbatim later (§2.4) |

**Stage 2 — Unload every relevant object, in reverse index order** (frames 172-196):
`A_PropertyValue_Write` OX=5,4,3,2,1, P=5 (`PID_LOAD_STATE_CONTROL`), value `$04 00...` (event
`0x04` = Unload). Each gets a `PropertyValue_Response` of `$00` (state = Unloaded). Note **OX=5
is unloaded but never loaded again** in this capture — it has no data to write this session.

**Stage 3 — per-object StartLoading → LoadData → memory write(s), in this exact order**
(frames 202-315): **4, then 3, then 1, then 2** — not simple ascending or descending index
order. 🟡 **INFERRED** this load order may be app-model-specific (dependency ordering between
objects) rather than a fixed rule — not tested against a different app.

For each object: `A_PropertyValue_Write` OX=n, P=5, event `0x01` (StartLoading) → response state
`$02` (Loading); then `A_PropertyValue_Write` OX=n, P=5, event `0x03` + 9-byte extra (LoadData —
see §2.3 for the exact byte layout) → response state stays `$02`; then the real memory write(s)
for that object, via `A_PropertyValue_Read` P=7 (`PID_TABLE_REFERENCE`, resolves the object's
real relmem base) followed by one or more `A_MemoryExtended_Write` frames:

| Object | LoadData size/fill/mode | Real base (P=7 response) | Memory write(s) |
|---|---|---|---|
| OX=4 (parameters) | size=`0x1FF2`=8178, fill=`0xFF`, mode=`0x01` (Full) | `0x00005F0E` | `0x005F53` (1 byte, `$80`) + `0x005FD3` (3 bytes, `$D06001`) |
| OX=3 (unidentified, 98 bytes) | size=`0x0062`=98, fill=`0x00`, mode=`0x00` | `0x0000570C` | one single 98-byte write at `0x00570C` (frame 289) — **ETS does not always chunk writes into small pieces**; it wrote the entire object in one frame here |
| OX=1 (GA table) | size=`0x0006`=6, fill=`0x00`, mode=`0x00` | `0x00004000` | `0x004000` (6 bytes, `$000249014904` — decodes as `[count=2][GA 9/1/1][GA 9/1/4]`, confirmed by direct byte decode) |
| OX=2 (Association table) | size=`0x000A`=10, fill=`0x00`, mode=`0x00` | `0x0000470A` | `0x00470A` (10 bytes, `$00020001000500020008` — decodes as `[count=2][gaIndex=1,coNumber=5][gaIndex=2,coNumber=8]`, confirmed by direct byte decode) |

Every `A_MemoryExtended_Write` gets an `A_MemoryExtended_Write_Response` with an `Error` byte
(observed value `0x01` on every successful write in this capture — 🔴 **SPECULATIVE**: this is
almost certainly not "an error occurred" given every one of these writes demonstrably succeeded;
more likely a status/return code whose exact KNX-spec meaning isn't confirmed here — Wireshark's
own dissector just labels the field "Error", which may not match the KNX spec's own field name)
plus a 2-byte trailing value that looks like a CRC of the written data (e.g. `$E304` for the
1-byte `$80` write, `$FD7B` for the 3-byte write) — 🔴 not decoded/verified against a real CRC
algorithm, just an observed pattern.

**Stage 4 — `PID_PROGRAM_VERSION` write-back** (frame 318): `A_PropertyValue_Write` OX=4, P=13,
value `$0004002510` — the *exact same value* read back in Stage 1 (frame 166/169), written back
verbatim right before `LoadCompleted`. See §2.4 for why this matters.

**Stage 5 — LoadCompleted, objects 4, 3, 2, 1** (frames 324-350): `A_PropertyValue_Write` P=5,
event `0x02` → response state `$01` (Loaded), confirming each object durably committed.

**Stage 6 — Restart** (frame 357): `A_Restart_Request` (`$0100`), gets a real
`RestartResp` (`$000008` — 🔴 the trailing bytes' exact meaning, e.g. a process-time-in-seconds
field, is not confirmed; the user separately observed the physical device's own display say
"waiting up to 9 seconds" during a real restart, which is close to but not exactly the `8` in
this response — plausible link, not confirmed identical encoding).

### 1.2 Partial Download, decoded frame-by-frame — and the differences from Full

Source: `2026-08-28-ets-2-partial-download-ntp-off-1.1.9.pcapng` and
`2026-08-28-ets-3-partial-download-ntp-on-1.1.9.pcapng` — same device, same session,
immediately following the Full Download above; the only real project change between the two
Partial captures was flipping one boolean parameter ("Use standard NTP server", relmem offset
69, absolute address `0x5F53`) off then back on. 🟢

**Structurally, a Partial Download is a strict subset of the Full sequence** — same stages, same
frame types, in the same relative order, with two real differences:

1. **Only OX=4 (parameters) goes through Unload→StartLoad→LoadData→write→LoadCompleted.**
   Objects 1/2/3/5 are read (`PropValueRead OX=4 P=5`, `OX=5 P=5` — a quick state check, not a
   full reload) but never unloaded or reloaded — their data didn't change, so ETS skips them
   entirely. 🟢 confirmed directly (compare the frame list in both partial captures against the
   full one — no `PropValueWrite ... P=5` frames appear for OX=1/2/3/5 in either partial
   capture).
2. **The `LoadData` "mode" byte is `0x00`, not `0x01`.** Exact same LoadData otherwise
   (`030B00001FF200FF0000` vs the Full Download's `030B00001FF201FF0000` — only byte 5 differs).
   See §2.3 — this is the confirmed Full-vs-Partial signal, not a "combined declaration" flag as
   originally guessed.

**The actual memory write differs in size between the two Partial captures, unexplained:**

| Capture | Target value | Memory write |
|---|---|---|
| NTP off (`ets-2`) | `0x00` (bit 7 clear) | `A_MemoryExtended_Write N=5 X=$005F53 $0000000000` (frame 138) — **5 bytes** |
| NTP on (`ets-3`) | `0x80` (bit 7 set) | `A_MemoryExtended_Write X=$005F53 $80` (frame 138) — **1 byte** (no `N=` shown = defaults to 1) |

🔴 **SPECULATIVE, genuinely open**: why does turning the parameter off write 5 bytes but turning
it on write only 1? Two candidate explanations, neither tested: (a) ETS may be writing a wider
byte range because some other, nearby parameter also needed to change state as a side effect of
this one (e.g. a dependent/gated parameter becoming inactive), even though the project diff we
made was a single boolean; (b) some encoding-size difference tied to the specific bit pattern.
Not investigated further — flagging so a future session doesn't have to rediscover this
asymmetry from scratch.

Otherwise the two Partial captures are frame-for-frame identical (same `PropDescrRead`, same
`AuthReq`, same PID13 read-then-writeback, same `RestartReq`) — a real, controlled, isolated
confirmation that the sequence generalizes across at least a true/false toggle of the same
parameter. 🟢

### 1.3 Timing observations

🟢 Confirmed durations, this specific capture only (not necessarily representative of every
device/network):
- ACK round-trip: typically 5-15ms per frame.
- `PropertyValue_Response` for a Load State transition: usually fast (~10-60ms) except
  `StartLoading`→`LoadData` and `LoadCompleted`, which can take 300-600ms (see the confirmed
  real-hardware "Restart race" bug this caused in koolenex — §3).
- Full Download total wall time (Stage 1 through Restart confirmation): ~6 seconds.
- Partial Download total wall time: ~2.7 seconds.
- 🔴 **SPECULATIVE**: whether these timings scale with parameter memory size, network
  conditions, or are fairly fixed regardless — not tested with a larger parameter set.

## Part 2 — Wire format reference

### 2.1 `A_DeviceDescriptor_Read`/`Response`

Sent as the very first frame of every real ETS management session in every capture this project
has (🟢, seen in Full Download, both Partial Downloads, and the earlier 2026-08-27/28 captures).
Response carries a 2-byte mask version (e.g. `$07B0`). 🟡 **INFERRED**: real ETS almost
certainly uses this to decide device-family-specific behavior (which memory service to use,
which property-based model to assume) — not confirmed from ETS source, but strongly suggested by
it being the literal first thing ETS does before anything else, every time, and by the real
mask-version-gated memory-write finding in §3.

### 2.2 `A_Authorize_Request`/`Response`

APCI `0x3D1`/`0x3D2` (not registered in koolenex's `parseCEMI`'s named extended-APCI table —
decodes as `apciName: 'OTHER'`; matching frames requires recomputing the full 10-bit APCI
manually: `((apdu[0]&0x03)<<8)|apdu[1]`). Sent once, early, with the well-known/default key
`0xFFFFFFFF`; response carries a 1-byte access level (`0` = full access, observed in every
capture on this testbed). 🟢 Present in every real capture. 🔴 **SPECULATIVE**: whether a real
project with non-default access keys configured would show a different key/response — untested,
this testbed's devices are presumed factory-default.

### 2.3 Load State Machine (`PID_LOAD_STATE_CONTROL` = property 5)

Event → resulting state, confirmed across the Full Download and both Partial Downloads (🟢, 3
independent real sessions, consistent every time):

| Event (sent) | Meaning | Resulting state (in response) |
|---|---|---|
| `0x04` | Unload | `0x00` (Unloaded) |
| `0x01` | StartLoading | `0x02` (Loading) |
| `0x03` + 9-byte extra | LoadData (see below) | `0x02` (stays Loading) |
| `0x02` | LoadCompleted | `0x01` (Loaded) |

**`LoadData`'s 9-byte extra payload**, confirmed byte-for-byte identical layout across 6
independent real examples now (4 from the original Full Download investigation, plus the 2
Partial Download examples in this session) 🟢:

```
byte:    0     1-2    3-4         5      6      7-8
         SCF   rsvd   size(BE)    mode   fill   rsvd
```

- `SCF` (Segment Control Field?) — always observed as `0x0B`. 🔴 exact meaning per KNX spec not
  looked up, name is a guess.
- `size` — matches the object's real total write-segment size exactly, every time observed
  (8178, 98, 10, 6 bytes for OX=4/3/2/1 respectively). 🟢
- `mode` — **`0x01` on the one Full Download observed, `0x00` on both Partial Downloads
  observed, for the same object (OX=4) on the same device.** 🟢 Real meaning: Full vs Partial
  download type. This corrects an earlier, wrong hypothesis (see "Retracted theories" below).
  🔴 **not confirmed for objects other than OX=4** — the only real LoadData examples for OX=1/2/3
  all come from Full Downloads (mode always `0x00` there too, which happens to be consistent
  with "Partial" only by coincidence since those objects are never loaded on a Partial Download
  at all — no real Partial-Download LoadData example exists for OX=1/2/3 to check against).
- `fill` — the byte value ETS declares for filling any part of the segment it doesn't explicitly
  write (`0xFF` for OX=4, `0x00` for OX=1/2/3, consistent with what's actually observed on real
  device memory for unwritten "gap" bytes in the koolenex-reference memory's separate
  investigation). 🟢 for the value pattern; 🔴 for *why* OX=4 specifically uses `0xFF` while the
  others use `0x00` — not investigated, could be manufacturer/app-specific rather than a general
  rule.

### 2.4 `PID_PROGRAM_VERSION` (property 13, object 4) read-back-and-write-back

Confirmed in every real capture (Full and both Partials): ETS reads this early (Stage 1), then
writes the *identical* value back verbatim right before `LoadCompleted`. 🟢 the pattern itself.
🔴 **SPECULATIVE** *why*: theorized as "registering the freshly-loaded segment as belonging to a
known application, without which `LoadCompleted` might not durably commit" — this is a plausible
explanation consistent with the fact that omitting this step (before it was discovered and added
to koolenex) correlated with writes not persisting, but no controlled test isolates this single
step's necessity from the other five fixes made the same day (see §3) — treat the *mechanism* as
speculative even though the *pattern* itself is solid.

### 2.5 Memory write services: `A_Memory_Write` vs `A_MemoryExtended_Write`

Two services exist: legacy `A_Memory_Write` (16-bit address, APCI `0xA` in the 4-bit table) and
`A_MemoryExtended_Write` (24-bit address, APCI `0x1FB`). **Real ETS used `A_MemoryExtended_Write`
exclusively for every write observed on this testbed** — including for 1.1.9's address `0x5F53`,
which fits easily in 16 bits, not just 1.1.10's `0xC3000`+ addresses which structurally require
it. 🟢, confirmed across Full Download and both Partial Downloads for 1.1.9, and separately for
1.1.10.

**This correlates with, but is not proven to be caused by, the device's mask version being
System B** (both tested devices are `0x07B0`). 🟡 **INFERRED, not proven**: no device with a
different (non-System-B) mask version has ever been tested against this write path on real
hardware — see §3 for the full reasoning and the current fallback behavior for untested mask
families. Response format: `A_MemoryExtended_Write_Response` carries an `Error`-labeled byte
(see §1.1's caveat about this field's real meaning) plus what looks like a 2-byte CRC.

**`A_MemoryExtended_Write`'s frame is easy to mis-decode manually**: `tshark`'s own KNXnet/IP
dissector has repeatedly mis-displayed this frame's address in its summary column (e.g. showing
`X=$0A5F` when the real decoded address was `0x5F0E` — see
`2026-08-28-koolenex-write-attempt-1.1.9.pcapng` frame 13, and the earlier 2026-08-26
investigation). 🟢 **Never trust the summary column for a `MemWrite`/`MemExtWrite` address** —
always manually decode the raw hex bytes, following the same offset logic `parseCEMI()`/
`apduConnected` use internally.

### 2.6 GA table and Association table wire formats (objects 1 and 2)

Confirmed on real, non-degenerate group addresses (2026-08-28, prior session) — not re-derived
in this document, cited here for completeness:

- **GA table** (object 1): `[count:2][GA:2]...`, standard raw 16-bit main(5)/middle(3)/sub(8)
  encoding, no reordering. 🟢, but **small sample**: 2 devices, one manufacturer, one testbed.
  Confirmed directly in this session too — see the OX=1 decode in §1.1's Stage 3 table.
- **Association table** (object 2): `[gaIndex:2][coNumber:2]` per entry, 1-based,
  position-referencing (not value-referencing). 🟢, same sample-size caveat. Confirmed directly
  in this session too — see the OX=2 decode in §1.1's Stage 3 table.
- Full decode logic and fixtures: `tests/relmem-real-device-fixtures.test.ts`, and
  `decodeGaTable()`/`decodeAssocTable()` in the codebase.

### 2.7 Object 3 (98 bytes, unidentified)

Present in every Full Download, written as a single 98-byte block at its own PID-7-resolved
base. Content starts with a header-like `0030000000004B094B094F0C...` pattern followed by many
repeated `5B` bytes and a long zero tail. 🔴 **entirely unidentified** — not GA table, not
Association table, not the parameter object. Working theory (unconfirmed): 🔴 "possibly a
per-channel mapper/routing config table" — carried over from the earlier 2026-08-27
investigation, never actually confirmed.

## Part 3 — Which memory service a device actually needs: the mask-version finding

This is the most consequential, and most carefully qualified, finding in this document — it
directly gates whether a write silently fails.

**🟢 CONFIRMED facts:**
- Both real devices tested (1.1.9, 1.1.10) report mask version `0x07B0` via a live
  `A_DeviceDescriptor_Read`.
- This project's own bundled KNX Master Data (`data/knx_master_<projectId>.xml`) classifies mask
  `0x07B0` (and its PL/RF/IP siblings `0x17B0`/`0x27B0`/`0x57B0`) as `ManagementModel="SystemB"`
  — a real, standardized KNX classification distinct from the legacy `Bcu1`/`Bcu2`/`BimM112`/
  `PropertyBased` families that occupy other mask ranges in the same table.
- Real ETS used `A_MemoryExtended_Write` exclusively for both these devices, for every observed
  write, regardless of whether the address fit in 16 bits.
- A verbatim byte-for-byte replay of a real captured ETS Partial Download (all 49 request
  frames, unmodified) against real hardware persisted the write correctly.
- koolenex's own reconstruction of the *identical* operation (same address, same count, same
  data), using the legacy `A_Memory_Write` service instead (because the address fit in 16 bits),
  silently failed to persist — twice, reproducibly, with no error of any kind at any protocol
  layer.

**🟡 INFERRED, not proven:**
- That mask-`0x07B0` ⇒ "requires extended writes" as a general rule for *all* System B devices,
  not just these two specific ones. This is a reasonable inference (both real data points are
  consistent with it, and it matches the general shape of KNX's own device-generation
  classification), but the sample is exactly two devices from one manufacturer.
- That legacy/non-System-B devices (`Bcu1`/`Bcu2`/`BimM112`/`PropertyBased` masks) genuinely
  *require* the legacy service rather than also tolerating extended writes. No such device has
  ever been tested against this write path at all.

**Current implementation** (koolenex, `server/knx-connection.ts`'s `WriteRelMem` case, commit
`95805ff`): reads the device's real mask version via `A_DeviceDescriptor_Read` at the start of
every RelSegment-driven download session (mirroring what real ETS itself does — §2.1), then:
- Mask low byte `0xB0` (confirmed System B) → always `A_MemoryExtended_Write`, regardless of
  address size.
- Anything else (unrecognized mask, or the device never answers the descriptor read) → falls
  back to the original conservative address-size heuristic (`addr > 0xFFFF` → extended, else
  legacy).

The fallback branch is **only protocol-level tested** (fake device in
`tests/relmem-write-protocol.test.ts`), never against real legacy hardware. If a real
BCU1/BCU2/System-7-family device is ever available to test, that closes the one remaining real
gap in this finding.

### Retracted theories — do not re-propose these without new evidence

Recorded so a future session doesn't waste time re-deriving conclusions already tested and
found wrong:

- **"The LoadData mode byte means 'combined full+par declaration'."** Retracted 2026-08-28 —
  real data from two independent Partial Downloads showed mode `0x00` even though the model
  still declares both `full` and `par` `RelSegment` entries for the same object. Real meaning:
  Full(`0x01`) vs Partial(`0x00`) download type (§2.3).
- **"Always use `A_MemoryExtended_Write`, unconditionally, for every device."** Shipped briefly
  (koolenex commit `68c0394`), corrected the same day (commit `95805ff`) after the user pushed
  back on generalizing from a two-device, single-mask-family sample. See above.
- **koolenex's enum-to-byte mapping is wrong** (an earlier, unrelated 2026-08-26 theory about a
  different bug, Finding A in `koolenex_reference` memory) — retracted after checking the actual
  parser code directly; the enum parsing was faithful, the real mechanism was something else
  entirely (conditional-activation gating, itself only partially explaining the observed
  mismatch — see that memory file for the fuller, still partially open story, unrelated to
  device-write correctness itself).

## Part 4 — Known gotchas (tooling and methodology)

- **`tshark`'s KNXnet/IP dissector mis-displays `Memory_Write`/`MemoryExtended_Write` addresses
  in its summary/Info column** on at least one confirmed occasion (§2.5). Always manually decode
  the raw `-x` hex for these frames; never trust the summary column for the address field.
- **KNXnet/IP tunneling for this router uses TCP, not UDP.** A `udp port 3671` capture filter
  catches nothing from real ETS sessions — use a host-only filter (`host <router-ip>`, no
  port/proto restriction). koolenex's own connection is UDP-only by contrast (confirmed via
  code review — no TCP networking code anywhere in `server/*.ts`), which is why neither tool's
  own bus monitor could ever see the other's traffic before tshark was introduced.
- **Windows/git-bash path translation**: `node` as a native Windows process does not reliably
  translate git-bash-style `/tmp/...` or even `/c/...` paths when spawning child processes via
  `cmd.exe`, or sometimes even for direct `fs` calls. Use explicit
  `C:/Users/...`-style forward-slash paths for direct Node file I/O, and run `tshark` via a
  shell directly (never have Node itself spawn it) — write to files, then have Node read the
  pre-written files.
- **A_MemoryExtended_Write_Response's leading byte, and `RestartResp`'s trailing bytes, have
  observed but not spec-confirmed meanings** — see §1.1 and §2.5. Don't assert a specific
  interpretation without checking the actual KNX Interworking spec.

## Part 5 — Genuinely open questions

Consolidated from throughout this document, for visibility:

1. Why does the NTP-parameter write differ in byte count (5 bytes for "off" vs 1 byte for "on")
   between the two otherwise-identical Partial Download captures? (§1.2)
2. What object 3 (98 bytes) actually represents. (§2.7)
3. Whether the mask-version gate (§3) generalizes beyond System B, or whether a real legacy
   device needs something different — untested, no legacy hardware available.
4. Whether the LoadData `mode` byte's Full/Partial meaning holds for objects other than OX=4 —
   no real Partial-Download LoadData example exists for OX=1/2/3.
5. The exact meaning of several unidentified property reads in Stage 1 (OX=0 P=15/25/56/78) —
   never looked up against a KNX property ID reference table.
6. `buildParamMem()`'s padding-bit fill bug (fills unrelated bits sharing a byte with a
   sub-byte-packed parameter as `1` instead of the real device's `0`) — root-caused, not fixed,
   unrelated to the write-path findings in this document but affects write *correctness* once
   the write-path itself works.
7. ~~Whether these findings hold for 1.1.10 specifically re-tested against the current fixed
   code~~ — **RESOLVED 2026-08-29, see Part 7**: re-tested with a fresh 3-download session;
   confirmed the universal GA/Association mechanism a second time and surfaced a real,
   previously-unverified `LoadImageProp` bug (now fixed).

## Part 6 — GA table / Association table writes are a universal, mask-defined procedure, not something every app declares (RESOLVED 2026-08-29)

🟢 Confirmed: real ETS writes the GA table (objIdx 1) and Association table (objIdx 2) during a
Full Download via the identical RelSegment Unload/StartLoading/LoadData/write/LoadCompleted
mechanism used for parameters - but not every app's own `LoadProcedures` declares this itself.
1.1.9's app (`M-0004_A-0025-10-1BA6-O00A6`) declares no `RelSegment`/`WriteRelMem`/`LoadImageProp`
step at all for objIdx 1/2, and real ETS writes both anyway. 1.1.10's app declares `LoadImageProp`
for objIdx 1/2/3/4 explicitly instead (a different mechanism - property 27, see Part 7). 🟡
**INFERRED**: this table-loading procedure is apparently universal and mask-defined, something
some apps simply don't need to declare - not confirmed from spec text, only from this app's
absence of a declaration combined with the wire evidence that ETS writes it anyway. Confirmed a
second time, independently, against 1.1.10 (which *does* write both tables, via the same
mechanism, despite declaring its GA/Association handling differently).

**Still open**: whether this is truly universal across every mask family (only tested on two
System B devices), and whether it holds for apps with more than 2 GAs or association entries.

Implementation history (koolenex code changes, commit hashes, two real bugs found fixing this):
`docs/follow-ups/2026-08-29-property27-ga-write-wiring-and-ui.md`, part 1.

## Part 7 — Property 27 (`LoadImageProp`/`WriteProp`): what it is, and where it comes from (RESOLVED 2026-08-29)

Re-testing 1.1.10 against the current write-path code (closing Part 5 item 7) surfaced two real
bugs in how koolenex's own `LoadImageProp`/`WriteProp` handling worked, both now fixed - but the
more durable finding is the protocol fact itself, below.

### Where property 27 comes from - it's in the project file, not decided at download time

This isn't ETS deciding something dynamically per-device. Every device's app carries its own
`LoadProcedures` list (already parsed into `data/apps/*.json`) - a per-app, manufacturer-authored
recipe of exactly what steps to run on download, in order. 1.1.9's app declares no `WriteProp`/
`LoadImageProp` step for property 27 anywhere, so it never touches this property at all - the
real app XML simply doesn't ask for it. 1.1.10's app does, and its full declaration (in order) is:

```
RelSegment (mode: full)         — allocate space, Full Download
RelSegment (mode: par)          — allocate space, Partial Download
WriteProp  objIdx=4 propId=27   data: 000028c0003300000000   (literal, fixed bytes from the file)
WriteProp  objIdx=4 propId=27   data: 00000001013300000000   (literal, fixed bytes from the file)
WriteRelMem objIdx=4            — the real parameter settings
LoadImageProp objIdx=1 propId=27
LoadImageProp objIdx=2 propId=27
LoadImageProp objIdx=3 propId=27
LoadImageProp objIdx=4 propId=27
```

Checking `data/apps/*.json` across every app that declares a `WriteProp` for objIdx4/propId27
(not just 1.1.10's - several different manufacturer IDs: `0004`, `0048`, `00C5`, `0233`) shows the
same two-step, literal-fixed-data shape every time, just with different embedded values. **This
is exported, manufacturer-authored data ETS ships with the project - not something a
download-time algorithm computes.**

### What property 27 actually is, in plain terms

A KNX device management operation always addresses "object N, property M" - `objIdx` is a logical
object inside the device's own internal object table, not a raw memory address. Property 27
happens to exist as an attribute on several of these objects here:

| objIdx | What it is |
|---|---|
| 1 | Group Address table |
| 2 | Association table |
| 3 | Unidentified (98 bytes) - still an open question, see Part 5 item 2 |
| 4 | The application/parameter memory object - the real device settings |

So it isn't its own memory area - it's a per-object "content status/checksum" attribute that
happens to be shared property ID 27 across object types 1-4.

### The two real protocol facts, confirmed on real hardware (3 independent downloads)

- 🟢 **`LoadImageProp` is read-only for all four objects**, including objIdx4 - byte-identical
  value before and after the load cycle, every time. It's a verify/read-back step, not a write,
  despite the step name. The real functional write to objIdx4/property27 comes entirely from the
  separate `WriteProp` steps shown above.
- 🟢 **The project file's declared `WriteProp` data for property 27 is always 2 bytes longer than
  what real ETS actually transmits** - `00 00 28 c0 00 33 00 00 | 00 00` declared (10 bytes) vs.
  `00 00 28 c0 00 33 00 00` on the wire (8 bytes), confirmed byte-for-byte and consistent across
  every manufacturer's app that declares this step.

koolenex's own handling of both of these had real, previously-unverified bugs (never exercised
against real hardware before, since 1.1.10 is the only app that declares either step) - now
fixed, including a same-day self-correction where the first fix itself mis-attributed the real
objIdx4 writes to the wrong step. Full implementation narrative, commit hashes, and the
self-correction: `docs/follow-ups/2026-08-29-property27-ga-write-wiring-and-ui.md`, part 3.

**Still open**: only one app/device has ever declared either step at all (1.1.10, mask `07b0`),
so while the *shape* of both facts above is now backed by many different manufacturers' declared
data in `data/apps/*.json`, the actual live wire confirmation is still one real device. Object 3's
identity (Part 5 item 2) remains unresolved.

## Part 8 — Full Download isn't purely history-independent-and-minimal; it falls back to a comprehensive rewrite (RESOLVED 2026-08-28)

Part 7 established that ETS only writes named-parameter bytes that differ from a file-derivable
target - raising a real question: could a device carrying stale content from elsewhere (a
different, discarded project; a factory reset) keep that content forever, if it happens to already
match what the *current* project's target computation predicts needs no write? Tested directly
against real hardware rather than reasoned about from file data alone (see the follow-up log for
full methodology, including two self-caught mistakes along the way).

🟢 **Confirmed: no.** A value written directly into device memory bypassing ETS entirely (via
koolenex's own debug write route, simulating stale/foreign content) was detected on the very next
real Full Download - but not via a minimal, targeted correction. ETS instead performed a
**comprehensive rewrite**: nearly the entire 10433-byte parameter segment (offset ~12 through
~1650), a separate block covering objIdx3's still-unidentified region, the offset-10432 marker,
and both the GA and Association tables - essentially everything, not a delta. Reproduced twice,
with the injected write declared two different ways (an incomplete RelSegment mode, then the
complete `full,par` pair matching real ETS's own declared shape exactly) - both produced the
identical comprehensive-rewrite response, ruling out "the intervening write's own protocol
correctness" as the trigger.

🟡 **Inferred, not confirmed**: any write to the device from something other than ETS's own last
session appears to trigger this fallback. The actual detection mechanism is unknown - 🟢
confirmed there is no live memory read anywhere in any capture this project has (which would be
the obvious way to detect a mismatch), so whatever signal ETS uses is something else entirely.

**The comprehensive rewrite's content is correct, not a blind reset** - checked byte-for-byte
against real, previously-captured device values (e.g. a byte with real value `2` was written back
as `2`, not reset to the segment's static default). This directly enabled Part 9's finding below.

## Part 9 — The "1984-byte gap" is a parser bug (manufacturer-shipped blob parameters), not device-internal state (RESOLVED 2026-08-28)

An earlier working theory (Part 6/relmem-fixtures test comments, now corrected) held that the
~1984-byte mismatch between koolenex's computed parameter image and the real device was opaque,
device-internal operational/calibration state outside ETS's own writable scope. That theory was
never rigorously tested - it was retired once the Part 8 finding above showed ETS's comprehensive
rewrite writes *real, correct* values into this exact region, not a static default, which isn't
consistent with "ETS never touches this."

🟢 **Confirmed root cause**: `paramMemLayout` (koolenex's own extracted parameter data) already
declares parameters in this region - labeled "Characteristic curve value domain" - but
under-declares their size. Each is recorded as 1 byte (`bitSize: 8`), while its real
`defaultValue` is a base64-encoded blob that decodes to **512 bytes**. These are ordinary
manufacturer-declared parameters (this device's app declares 6 conditional alternates per
dimming channel - almost certainly a "curve type" selector, one alternate active per channel) -
nothing ETS computes dynamically. `buildParamMem()` has no code path to apply a multi-hundred-byte
blob default (only scalar/text/float value types), so this region silently fell through to the
segment's fill/default in koolenex's own computed image.

**Verified at project scale**: swept every `paramMemLayout` entry for this pattern (declared size
far smaller than its real base64-decoded `defaultValue` length). Found 24 such entries - 4
channels x 6 alternates - at four offsets exactly 532 bytes apart. Cross-checked against the real
1984-byte diff list: these four 512-byte ranges account for **1968 of 1984 diffs (99.2%)**.

**Remaining 16 bytes** (4 bytes at an identical relative offset right after each blob, all 4
channels): a separate, smaller, still-open gap - no `paramMemLayout` entry covers them at all, and
their real device value is a fixed constant (`0F EF 0F FF`) in every channel. Not yet traced to a
declared parameter; low-stakes (0.15% of the segment) given its determinism.

**Still open**: which of each channel's 6 curve-type alternates is genuinely active for a given
project (needs the same conditional-activation logic already used for Part 7's offset-172 case,
not yet applied here); the 16-byte fixed-constant gap; the Part 8 detection-mechanism question.

## Sources

- `docs/data/captures/2026-08-28-ets-1-full-download-1.1.9.pcapng` — primary source for Part 1.1
  and most of Part 2.
- `docs/data/captures/2026-08-28-ets-2-partial-download-ntp-off-1.1.9.pcapng` and
  `2026-08-28-ets-3-partial-download-ntp-on-1.1.9.pcapng` — primary source for Part 1.2.
- `docs/data/captures/2026-08-28-verbatim-replay-success-1.1.9.pcapng` and
  `2026-08-28-koolenex-legacy-write-fail-1.1.9.pcapng` — primary source for Part 3.
- `docs/data/captures/2026-08-28-koolenex-write-attempt-1.1.9.pcapng` — source for the tshark
  address-mis-display gotcha (Part 4) and the original missing-Load-sequence finding.
- `docs/data/captures/2026-08-27-full-download-1.1.9-1.1.10.pcapng` and
  `2026-08-28-ga-wire-format-1.1.9-1.1.10.pcapng` — source for Part 2.6 (GA/Association table
  formats), not independently re-derived in this document.
- `docs/data/captures/2026-08-29-ets-0-failed-connection-attempts-1.1.10.pcapng` and
  `2026-08-29-ets-1/2/3-...-1.1.10.pcapng` (knx-ets-manager repo) — primary source for Part 7.
- `docs/data/captures/2026-08-28-ets-full-download-history-and-blob-params-1.1.10.pcapng`
  (knx-ets-manager repo) — primary source for Parts 8 and 9.
- `docs/follow-ups/2026-08-27-relmem-write-scope-investigation.md`,
  `docs/follow-ups/2026-08-28-write-path-missing-load-sequence.md`,
  `docs/follow-ups/2026-08-29-property27-ga-write-wiring-and-ui.md`,
  `docs/follow-ups/2026-08-28-full-download-history-and-blob-params.md` (koolenex repo) — the dated
  investigation logs this document consolidates. Read those for the full narrative, including
  dead ends, UI/implementation work, and the exact chronology of each fix.
- `koolenex_reference` memory (knx-ets-manager repo's persistent memory) — broader project
  narrative, including findings unrelated to the write path itself (e.g. the enum-mapping
  retraction in Part 3).
