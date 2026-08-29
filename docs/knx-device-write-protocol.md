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

### 1.1' Complete annotated timeline — 1.1.10 Full Download, every read and every write, one real clean session

Source: `docs/data/captures/2026-08-29-ets-full-download-1.1.10-systematic-1-clean.pcapng`
(knx-ets-manager repo) — a genuinely clean session (no project changes at all), chosen because
1.1.10's app is the richest available: it's the only one that exercises the property-27 checksum
mechanism (§Part 8), so this single timeline shows everything 1.1.9's sequence has *and* the
checksum read/write cycle 1.1.9's app never touches at all (§Part 8, §10.3). 🟢 throughout, every
row a real captured frame - request frames only shown (each has a matching response, omitted for
readability unless its content matters).

| Stage | Frame(s) | What happens |
|---|---|---|
| Connection churn | `Connect`→`SysNwkParamRead`→`DevDescrRead`→`Disconnect`, `IndAddrSerNumRead` (broadcast), `Connect`→`DevDescrRead`→`Disconnect`, `Connect`→`DevDescrRead` | Several short-lived connections and device-identity checks before the real session starts, including a `DevDescrRead` seen twice in immediate succession, and (only in this specific capture) a defensive `RestartReq` mid-churn — see §1.1 Stage 0 for the same pattern on 1.1.9 |
| Identity reads | `PropValueRead OX=0 P=56`, `FuncPropExtRead OT=17 OI=1 P=51` (×2), `PropValueRead OX=0 P=11` | Static identity/status fields - none of these are content-dependent, none could reveal an out-of-band tamper |
| `AuthReq`/`AuthResp` | `AuthReq $FFFFFFFF` → `AuthResp L=0` | §2.2 |
| Capability probe | `PropDescrRead OX=2 P=23` → `N=1600 R=3 W=3` | Association-table capability descriptor - same single frame in every 1.1.9/1.1.10 session, Full or Partial |
| More identity reads | `PropValueRead OX=0 P=11`, `OX=4 P=5` (state check), `OX=4 P=13` (`PID_PROGRAM_VERSION`, read here, written back verbatim later), `OX=5 P=5`, `OX=0 P=12/25/78/15` | Same shape as §1.1 Stage 1 for 1.1.9 |
| **Checksum read** | `PropValueRead OX=3 P=27` → `$000003AE0033C327`; `PropValueRead OX=4 P=27 N=2` → `$000028C0003365E4000000010133DCBD` | **The trigger signal (§Part 8)** - both come back valid/normal in this clean session. Fires here, well before any Unload/write decision. **1.1.9's app never sends this read at all**, at any stage, in any capture (§Part 8/§10.3) |
| Unload | `PropValueWrite OX=4/2/1 P=5 $04...` (reverse order) | Object 3 stays untouched in this session entirely - not unloaded, not reloaded, because the checksum read above came back clean |
| StartLoading + LoadData + write: OX=4 (parameters) | `P=5 $01...` → Loading; `P=5 $030B000028C100000000` (LoadData); `PropValueRead OX=4 P=7` → base `0x0C3000`; `MemExtWrite X=$0C58C0 $01` (**1 byte**) | Only one real byte differs from what's already on the device - even on a "Full" Download, ETS only writes what's actually different (§Part 7's established finding, reconfirmed here) |
| Property-27 recompute write (OX=4 only) | `PropValueWrite OX=4 P=27 $000028C000330000`; `PropValueWrite OX=4 P=27 X=2 $0000000101330000` | The two-step `WriteProp` sequence from §Part 7 - re-primes the checksum after the (tiny) real content write above |
| StartLoading + LoadData + write: OX=1 (GA table) | `P=5 $01...` → Loading; `P=5 $030B0000000600000000`; `PropValueRead OX=1 P=7` → base `0x0F0000`; `MemExtWrite N=6 X=$0F0000 $00020A010A02` | GA table rewritten unconditionally, as always on Full Download (§Part 6), even though no GA link changed in this clean session |
| StartLoading + LoadData + write: OX=2 (Association table) | `P=5 $01...` → Loading; `P=5 $030B0000000A00000000`; `PropValueRead OX=2 P=7` → base `0x0C0000`; `MemExtWrite N=10 X=$0C0000 $00020001001F00020020` | Same unconditional pattern as GA table |
| `PID_PROGRAM_VERSION` write-back | `PropValueWrite OX=4 P=13 $0004303023` | §2.4 - identical value read back in Stage 1, written verbatim |
| LoadCompleted | `PropValueWrite OX=4/2/1 P=5 $02...` → responses `$01` (Loaded) | Object 3 excluded - never touched this session |
| Post-load checksum reads (`LoadImageProp`, read-only) | `PropValueRead OX=1 P=27`, `OX=2 P=27`, `OX=3 P=27` (same `$...C327` as the pre-load read - unloaded, unchanged), `OX=4 P=27 N=2` (same value as the pre-load read - confirms the tiny real write didn't change the checksum's own tracked content) | §Part 7's read-only `LoadImageProp` fact, shown for every object including the untouched Object 3 |
| Restart | `RestartReq $0100` → `RestartResp $000000` | §1.1 Stage 6 |

**What this timeline demonstrates end-to-end that no single earlier capture showed on its own**:
the property-27 checksum read happens once, early, before any Unload decision - not interleaved
with the write phase, not re-checked mid-session except via the read-only `LoadImageProp` calls
at the very end (which confirm the writes didn't disturb it, not re-decide anything). Object 3 is
completely absent from Unload/StartLoading/LoadData/write/LoadCompleted in this clean session -
its checksum is read once at the very start and once at the very end, both times identical,
consistent with §10.3's finding that it's excluded from the write plan entirely when the checksum
looks clean.

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

### 2.7 Object 3 — see Part 10

Present in every 1.1.9 Full Download, written as a single 98-byte block at its own
PID-7-resolved base. Identity, decoded content, and write-trigger: Part 10.

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

### Do not re-propose these — already tested and found wrong

- LoadData mode byte = "combined full+par declaration": wrong. Real meaning is Full(`0x01`) vs
  Partial(`0x00`) download type (§2.3).
- Always use `A_MemoryExtended_Write` unconditionally for every device: wrong; gate on mask
  version (above), not a blanket rule.
- koolenex's enum-to-byte mapping was wrong (unrelated 2026-08-26 bug theory): wrong; the parser
  is faithful, the real mechanism was conditional-activation gating (see `koolenex_reference`
  memory).
- Object 3 tied to application-version management, or to "differs from manufacturer default": both
  wrong (Part 10).
- Object 3 written whenever a GA/parameter change is present in the project, tampered or not: wrong
  (Part 10.3) - only an out-of-band write (bypassing ETS) triggers it.

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
2. ~~Object 3's identity, content, and write-trigger~~ - **RESOLVED, see Part 10**: the standard
   Group Object Table; content fully decoded as `offset = 2 × com-object number` (confirmed not
   to reindex when objects are disabled/unlinked), with a per-object flag byte (Update=bit7,
   Transmit=bit6, Read-On-Init=bit5, Write=bit4, Read=bit3, bit2=Communication flag AND has a
   real GA link - both required, Priority=bits1:0), cross-confirmed on a second object, a third
   object with a different DPT/size, and a second device/app entirely (§10.1). Write trigger
   resolved for both Partial
   (§10.2, conditional on any communication-object-level change, not just GA links) and Full
   Downloads (§10.3, conditional on an anomalous `OX=4 P=27` checksum read - itself tied to
   Part 8's comprehensive-rewrite trigger). **Still open**: bit 2's exact semantics beyond the
   observed correlation; 1.1.9 writes
   Object 3 on every Full Download tested, never yet shown skipping it - not reconciled with
   1.1.10's conditional behavior, and 1.1.9's app doesn't even declare property 27.
3. Whether the mask-version gate (§3) generalizes beyond System B, or whether a real legacy
   device needs something different — untested, no legacy hardware available.
4. Whether the LoadData `mode` byte's Full/Partial meaning holds for objects other than OX=4 —
   still no real ETS-captured Partial-Download LoadData example exists for OX=1/2/3. (koolenex's
   own new `mode: 'partial'` write path, Part 11, now forces this byte for OX=1/2 too and
   confirmed it's accepted by real hardware - but that's koolenex's own write, not an observed
   real ETS Partial Download of these objects, so this item stays open as originally scoped.)
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
| 3 | Group Object Table (KNX standard type `9`) - real size is per-app (98 bytes for 1.1.9, 942 for 1.1.10); see Part 10 |
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

## Part 8 — Full Download's comprehensive-rewrite fallback, and its real detection mechanism (RESOLVED 2026-08-28; trigger mechanism identified 2026-08-29)

Part 7 established that ETS only writes named-parameter bytes that differ from a file-derivable
target. Does a device carrying stale content from elsewhere (a different, discarded project; a
factory reset) keep that content forever, if it happens to already match what the *current*
project's target computation predicts needs no write?

🟢 **No.** A value written directly into device memory bypassing ETS entirely (koolenex's own
debug write route, simulating stale/foreign content) is detected on the very next real Full
Download - not via a minimal, targeted correction, but a **comprehensive rewrite**: nearly the
entire 10433-byte parameter segment, the Group Object Table (Part 10), and both the GA and
Association tables - essentially everything, not a delta. Reproduced on both 1.1.9 and 1.1.10
(2026-08-28 and 2026-08-29 respectively), each time regardless of exactly how the injected write
was declared on the wire. **The rewrite's content is correct, not a blind reset** - real
previously-captured device values are written back correctly (e.g. `2` stays `2`), which directly
enabled Part 9's finding.

### The detection mechanism: a property-27 checksum read, confirmed 2026-08-29

🟢 **Confirmed, reproduced across 5 independent real Full Downloads on 1.1.10**: early in every
session, before any load/write decision, ETS reads `PropertyValue_Read OX=4 P=27` (the same
content-dependent checksum property established in Part 7). In every genuine session - two clean
baselines, a real GA-link change, a real parameter change - this read returns the identical, valid
2-element checksum (`$000028C0003365E4000000010133DCBD`). In the one session preceded by an
out-of-band write bypassing ETS, the identical read instead returns **empty** (`N=0`) - the
device's own checksum computation broke down as a direct, observable consequence of the tampering.
This is not a raw memory read of the parameter/GA/Object-3 content (no `Memory_Read`/
`MemoryExtended_Read` frame appears in any of these captures, confirmed directly) - it's a
property-level read whose *result* differs based on device state, and it happens well before the
Unload/StartLoading cycle begins. This is the real, evidenced trigger signal for the comprehensive
rewrite - not a guess. See Part 10.3 for the exact 5-capture comparison table.

**Still open**: whether this generalizes beyond 1.1.10's app (only device/app this has been
checked against), and the precise decision rule ETS applies once it sees an anomalous checksum
(e.g. whether *any* anomaly triggers the same universal comprehensive rewrite, or the response is
graded).

## Part 9 — The "1984-byte gap" is a parser bug (manufacturer-shipped blob parameters), not device-internal state (RESOLVED 2026-08-28)

An earlier working theory (Part 6/relmem-fixtures test comments, now corrected) held that the
~1984-byte mismatch between koolenex's computed parameter image and the real device was opaque,
device-internal operational/calibration state outside ETS's own writable scope. That theory was
never rigorously tested - it was retired once the Part 8 finding above showed ETS's comprehensive
rewrite writes *real, correct* values into this exact region, not a static default, which isn't
consistent with "ETS never touches this."

🟢 **Confirmed root cause, fully resolved (verified against the real .knxproj XML, not just
inferred)**: `paramMemLayout` (koolenex's own extracted parameter data) already declares
parameters in this region - labeled "Characteristic curve value domain" - but under-declares
their size. Each was recorded as 1 byte (`bitSize: 8`), while its real `defaultValue` is a
base64-encoded blob that decodes to **512 bytes**. These are ordinary manufacturer-declared
parameters (this device's app declares 6 conditional alternates per dimming channel - a
"curve type" selector, one alternate active per channel) - nothing ETS computes dynamically.
`buildParamMem()` had no code path to apply a multi-hundred-byte blob default (only scalar/
text/float value types), so this region silently fell through to the segment's fill/default in
koolenex's own computed image.

**The real wire format, confirmed directly against a real `.knxproj`'s raw XML** (a different,
older export of the same project - the app definitions inside a `.knxproj` are identical across
exports of the same product/app version, so this is valid evidence for the live project too):
`<ParameterType><TypeRawData MaxSize="516" /></ParameterType>` - koolenex's parser never handled
`TypeRawData` at all (every branch checks for `TypeNumber`/`TypeFloat`/`TypeTime`/`TypeText`
before falling through to a generic `TypeRestriction`-based branch that only reads
*TypeRestriction's own* `SizeInBit` - absent here, hence the `bitSize=8` fallback). `MaxSize` is
in **bytes**: 516 = 4 + 512, and the real device's own leading 4 bytes at each curve's offset
decode as a big-endian `uint32` of `512` - exactly the payload length. **The real format is a
4-byte big-endian length prefix followed by the payload**, not the raw 512-byte table alone -
what first looked like an inexplicable "offset off by 4" (and, before that, a seemingly
unrelated separate 16-byte gap after each blob) was actually the same length prefix the whole
time, on both ends: the earlier "16 remaining unexplained bytes" (4 bytes after each naively-
placed 512-byte window) was the table's own real tail, misplaced by the same 4 bytes.

**Verified at project scale, and fully closed**: swept every `paramMemLayout` entry for this
under-declared-size pattern. Found 24 such entries - 4 channels x 6 alternates - at four offsets
exactly 532 bytes apart (532 = 516 + 16, the per-channel unit including the small "curve
correction" parameter that precedes it). Fixed in two places: `ets-app.ts` now reads
`TypeRawData`'s `MaxSize` into `bitSize` (bytes, correctly), and `buildParamMem()` now emits the
real `[4-byte BE length][payload]` framing whenever a blob's declared size matches that shape
(falling back to writing the raw payload with no framing otherwise, for a stale pre-fix cache or
a genuinely different blob shape not yet seen). **Result: 0 diffs across all four 516-byte
regions** against the real device, confirmed with a fresh re-parse of the real XML - the ~1984-
byte gap is fully resolved, not just mostly.

**Still open**: whether this `TypeRawData`/length-prefix framing generalizes to other blob-typed
parameters or other manufacturers' apps - confirmed for this one app's "Characteristic curve
value domain" parameters only; `buildParamMem()`'s fallback (raw payload, no framing) is a
deliberate safety net for an unverified shape, not assumed correct.

## Part 10 — Object 3 (interface object index 3): the standard Group Object Table, one of the four objects Property 27 (Part 7-8) applies to

Object 3 is addressed here purely as a KNX interface object - "object 3" means objIdx 3, not
property 27 itself. The connection to Property 27: objIdx 3 is one of the four interface objects
(1/2/3/4, see Part 7) that each carry their own property-27 content-status/checksum value -
`PropValueRead OX=3 P=27` appears in the same `LoadImageProp` read cycle as objIdx 4's checksum
(§1.1', Part 8's trigger finding), just device/app-scoped to 1.1.10 the same way the rest of
property 27 is (1.1.9's app never touches property 27 in any form, on any object - Part 8).

🟢 **Identity and structure, confirmed directly**:
- **Object 3 is the standard KNX "Group Object Table" object** (type `9`). Read live via
  `PID_OBJECT_TYPE` (property 1) on the real device, cross-referenced against koolenex's own
  bundled real KNX Master Data (`data/knx_master_1.xml`):
  `<InterfaceObjectType Number="9" Name="OT_GROUP_OBJECT_TABLE" Text="Group Object Table Object" />`.
  Confirmed the same way for objIdx 1/2/4 too (Address Table/Association Table/Application
  Program), validating the method. Distinct from the GA table (object 1, holds the group
  addresses themselves) and the Association table (object 2, maps GA links to communication
  objects) - an easy name mix-up to avoid.
- Real size and base are per-device/app: **98 bytes at `0x00570C`** for 1.1.9; **942 bytes at
  `0x0C2000`** for 1.1.10 (`PID_TABLE_REFERENCE`, stable across sessions). Content is almost
  entirely zero-filled in both cases - a small structure repeating once per channel/object, with
  the rest padding.
- Not declared in either app's own `LoadProcedures` XML - written via the same universal,
  mask-defined mechanism as the GA/Association tables (Part 6).

### 10.1 Content: a per-communication-object flag record, fully decoded and cross-app confirmed

🟢 **CONFIRMED - full record layout for Object 3, one byte per communication object, offset
computed by a real formula, decoded via a systematic bit-by-bit mapping session (2026-08-29)**:

```
byte offset within Object 3 = 2 × communication-object number
```

```
bit:    7      6         5           4      3     2                       1  0
        Update Transmit  Read-On-Init Write  Read  Comm-flag AND has-link  Priority
```

Priority (bits 1:0), values confirmed by direct empirical mapping in decreasing order:

| Priority | Bits |
|---|---|
| Low | `11` |
| Alarm | `10` |
| High | `01` |
| System | `00` 🟡 inferred by pattern, not directly tested - per KNX's own documentation (support.knx.org, "Group Object"), System priority is not settable from ETS at all, so no real project can exercise this value; the pattern-inferred bits are the practical answer |

**Methodology**: toggled one flag at a time on communication object 7 (1.1.9), always confirming
the resulting single-bit change against the previous known state, then reverted everything to
manufacturer default and did a full-session byte comparison against the very first (pre-testing)
baseline capture - zero diffs, confirming the whole sequence was self-consistent and fully
reversible. The formula and bit layout were then independently verified on a **second
communication object on the same device** (object 6, offset 12 = 2×6, Update and Read both
matched exactly, including an additive two-flags-at-once case computed correctly in advance) and,
decisively, on **a completely different device and app** (1.1.10, object 96 "dimming channel 4",
offset `0xC0` = 2×96, matching manufacturer-declared defaults for that object exactly except one
bit) - determined blind, from the capture alone, by computing the expected default byte from the
app's own XML and diffing against the real captured value, which correctly identified the single
changed flag (Write) before being told what had changed. This cross-device, cross-app,
predicted-not-fitted match is strong evidence this is a genuine mask/device-generation-level
standard structure, not an app-specific quirk. **Read-On-Init (bit 5)** was independently
reconfirmed a second time, blind, on a third object (object 5, an 8-byte `DPST-19-1` date/time
object - a different DPT/size than every other object tested, confirming the record format is
independent of the object's own payload size).

**Bit 2 = effective communication state: `Communication flag AND has a real GA link` - both
required.**

🟢 Confirmed directly, three real hardware tests: object 5 (linked, Communication enabled)
showed bit 2 = `1`, consistently. Removing communication object 8's only GA link (Communication
still enabled) flipped its bit 2 from `1` to `0`, corroborated independently by the GA and
Association tables shrinking to remove that link in the same download. Disabling Communication on
object 5 while its GA link stayed fully intact (checked explicitly - GA and Association tables
byte-for-byte unchanged) also flipped bit 2 from `1` to `0` - two independent routes to the same
bit, only one of which touches the link tables at all. Objects 6 and 7 (never linked,
Communication toggled both ways across many tests) always showed bit 2 = `0`, consistent with the
AND relationship.

**Multiple GA links tested**: object 5 with a second GA link added (both links confirmed in the
Association table, `[gaIndex 1, gaIndex 2] → com-object 5`) and Communication re-enabled still
shows bit 2 = `1`, byte-for-byte identical to the single-link case - a plain boolean
("has at least one link"), not something that varies with link count.

**Scope**: the AND-relationship (flag enabled AND link present) correctly predicts every result
observed across all tests on three objects, one and two links. Not yet tested: mixed-direction
links (e.g. one send, one receive on the same object), or other DPT/direction combinations.

**Complete bit accounting**: `7=Update, 6=Transmit, 5=Read-On-Init, 4=Write, 3=Read,
2=Communication-AND-linked, 1:0=Priority`. Every bit has an observed, evidenced role.

**The offset formula does not reindex when an object is disabled** - 🟢 confirmed directly:
disabling Communication on a lower-numbered object (6) left every higher-numbered object's byte
(7 at offset 14, 8 at offset 16) completely unmoved - no table-compaction/reindexing occurs. The
formula `offset = 2 × communication-object number` can be used unconditionally, regardless of
which objects are linked or Communication-enabled elsewhere in the app.

**Still open**: whether the formula/layout holds for a genuinely different mask family (only
System B tested throughout this project); whether bit 2's AND-relationship holds under
mixed-direction links (e.g. one send, one receive on the same object).

### 10.2 Partial Download write-trigger: conditional on any communication-object-level change

🟢 **Confirmed, reproduced many times, both directions (1.1.9)**: on a Partial Download, GA table
/ Association table / Object 3 are written together exactly when a communication object's state
genuinely changes - a GA link, a flag, or Priority - and skipped together otherwise. This is
broader than an earlier framing of this finding ("conditional on a GA/link change") - the bit-
mapping session above ran many Partial Downloads changing only a flag or Priority, never a GA
link, and every one still wrote all three objects together; a plain, no-change download in
between correctly skipped them.

| Partial Download | What changed | OX=1/2/3 |
|---|---|---|
| NTP flag toggle (×2, 2026-08-28) | nothing (Partial, different objects) | not written |
| GA 9/1/4→9/1/5 (2026-08-29) | GA link | written |
| GA 9/1/5→9/1/4 + flag revert, same download | GA link + flag | written |
| Read/Write/Transmit/Priority flag changes (2026-08-29 mapping session, ~8 downloads) | flag or Priority only, no GA link touched | written every time |
| Reset-to-default downloads (×2) | flags reverted | written (content matched pre-testing baseline exactly) |

Object 3's content is correct every time, not a blind rewrite - every flag/Priority change and
every revert produced exactly the predicted byte. Confirmed for 1.1.9 only.

### 10.3 Full Download write-trigger: resolved via a systematic controlled redo (1.1.10, 2026-08-29)

🟢 **Confirmed, five real Full Downloads in one controlled session, 1.1.10**: Object 3 is written
exactly when the device's `OX=4 P=27` checksum read (Part 8) comes back anomalous, which happens
only after an out-of-band write - not for any kind of genuine, ETS-driven change.

| # | Change | Origin | `OX=4 P=27` checksum | Object 3 written? |
|---|---|---|---|---|
| 1 | none | — | valid | No |
| 2 | none | — | valid | No |
| 3 | parameter byte (offset 172) | out-of-band, bypassing ETS | **empty (`N=0`)** | **Yes** |
| 4 | GA link re-point | genuine, via ETS | valid | No |
| 5 | same offset-172 byte, real value | genuine, via ETS | valid | No |

Test 5 is the decisive control: the *exact same byte* as test 3, written via ETS instead of
bypassing it, produces a valid checksum and no Object 3 write - isolating the origin of the write
(ETS session vs. out-of-band) as the real variable, not the byte or parameter itself. This
directly refutes two prior hypotheses tested along the way: neither "any project change to a
parameter" nor "any project change to a GA link" (test 4) triggers Object 3 - only an anomalous
checksum does, which only an out-of-band write produces. This also supersedes the earlier 1.1.9
data (which showed Object 3 written on every Full Download, tampered or not, without a systematic
redo isolating the variable) and the historical unreproduced 1.1.10 session from 2026-08-28 - both
are now explained by this same mechanism.

**1.1.9 still writes Object 3 on every Full Download tested (5 for 5, never once skipped)** - not
yet reconciled with 1.1.10's conditional behavior, but now with a specific, well-supported
explanation rather than an open mystery: **1.1.9's app never sends the `OX=4 P=27` read, or any
property-27 request of any kind, at any stage** - confirmed by checking every read-type frame
(`PropValueRead`, `PropDescrRead`) across all 9 real 1.1.9 captures this project has (5 Full, 4
Partial). The complete list of what 1.1.9's app *does* read, every session: identity/status
fields (`OX=0 P=11/12/15/25/56/78`), an Association-table capability probe (`OX=2 P=23`),
`PID_PROGRAM_VERSION` (`OX=4 P=13`, read back and written verbatim - not compared for anomalies),
quick load-state checks (`OX=4/5 P=5`, Partial only), and each object's base address
(`OX=1/2/3/4 P=7`) - none of these are content-dependent, device-computed values the way the
checksum is; none could reveal an out-of-band write. 🟡 **INFERRED, well-supported but not a
controlled causal test**: since ETS's own `LoadProcedures` action plan is built statically from
the app's declared steps (Part 7's established fact - not decided dynamically at download time),
and 1.1.9's plan simply never includes a property-27 step, ETS has no verification signal
available for this app at all. Given that, "always write Object 3" is the sensible safe default
when no cheap trust-verification mechanism exists - a real, coherent explanation, not a guess, but
not proven by an experiment that isolates causation (e.g. no app has ever been found or
constructed with property 27 declared for some objects and not others). Whether the
checksum-trigger mechanism generalizes to other apps that *do* declare property 27 is also open.

## Part 11 — koolenex has a real Partial-Download write mode, confirmed round-trip on real hardware (NEW 2026-08-29)

Distinct from the LoadData mode-byte *observation* (Part 1/2, always sourced from real ETS
traffic) - this part is about koolenex's own write path gaining, for the first time, actual
Partial-Download behavior rather than always performing a Full-equivalent rewrite regardless of
what was asked for.

🟢 **Confirmed on real hardware, round trip, first attempt**: koolenex's `downloadDevice()` now
supports `mode: 'partial'` - before touching an interface object, it reads the object's current
content within the same management session and skips the entire Unload/StartLoading/LoadData/
write/LoadCompleted cycle if it already matches the computed image; when a write is genuinely
needed, the LoadData mode byte is set to the real captured Partial value (`0x00`, per Part 2)
rather than the model's declared full/combined shape. Tested end-to-end: ETS wrote a GA change
(Full Download); koolenex reverted it via an ordinary Full Download; koolenex then reverted it
right back via the new partial mode - verified directly against the device at every step
(`totalDiffering: 0`). The capture shows the parameter segment (8178 bytes) and Association
table (10 bytes) - both genuinely unchanged - correctly skipped entirely (no LoadData frames for
either), while only the GA table (the one real change) was written, with mode byte `0x00`.

**Scope, don't overclaim**: tested only on 1.1.9 (System B, RelSegment/ABB-style app). The
GA/Association-table skip logic is a best-effort extrapolation of the same pattern used for the
parameter object - there was no real ETS Partial Download example of a GA/Association table
write before this test (Part 5 item 4 was still open going in); this round trip is now real
evidence for that specific device/app, not proof it generalizes to others. The AbsoluteSegment
(MDT-style) download branch, used by a different manufacturer-app family entirely, is completely
untouched by this and still only ever performs a full replay - no partial mode exists there.

Full implementation narrative, commit hash, and test coverage:
`docs/follow-ups/2026-08-29-partial-download-mode-and-obj3-trigger-test.md`.

## Sources

- `docs/data/captures/2026-08-29-ets-*-obj3-map-*-1.1.9.pcapng` (12 captures: read/write/
  transmit/comm flag tests and their reverts/reproductions on com-objects 6 and 7, three Priority
  values, two full-session reset sanity checks), `2026-08-29-ets-download-obj3-map-flag-1.1.10.pcapng`
  (knx-ets-manager repo) — primary source for §10.1's full bit-mapping/offset-formula finding and
  §10.2's broadened trigger description.
- `docs/data/captures/2026-08-29-ets-partial-download-obj3-map-followup-1.1.9.pcapng` (Read-On-Init
  reconfirmed blind on a third object, object 5, a different DPT/size) and
  `2026-08-29-ets-partial-download-obj3-map-followup-2-1.1.9.pcapng` (two simultaneous changes
  decoded correctly in one download - object 5's Read-On-Init reverted, object 8's GA link
  removed, bit 2's GA-link correlation confirmed by a real link removal corroborated by the GA
  and Association tables shrinking in lockstep) (knx-ets-manager repo) — primary source for
  §10.1's bit-2/Read-On-Init follow-up findings.
- `docs/data/captures/2026-08-29-ets-partial-download-obj3-map-comm-reindex-test-1.1.9.pcapng`
  (disabling Communication on a lower-numbered object does not shift higher-numbered objects'
  offsets) and `2026-08-29-ets-partial-download-obj3-comm-flag-linked-object-1.1.9.pcapng`
  (disabling Communication on a *linked* object flips bit 2 while the GA/Association tables stay
  byte-for-byte unchanged - the decisive test that corrected the earlier wrong "Communication
  flag has zero representation" claim) (knx-ets-manager repo) — primary source for §10.1's
  corrected bit-2 finding and the offset-formula reindexing check.
- `docs/data/captures/2026-08-29-ets-partial-download-obj3-multilink-test-1.1.9.pcapng`
  (knx-ets-manager repo) — a second GA link added to a communication object already linked once;
  bit 2 stays a plain boolean, unaffected by link count. Primary source for §10.1's multi-link
  finding.
- `docs/data/captures/2026-08-28-ets-full-download-history-and-blob-params-1.1.10.pcapng`,
  cross-checked against every other saved capture (`grep -c "OX=3 P=5"` across
  `docs/data/captures/*.pcapng`), a live `PID_OBJECT_TYPE`/`PID_TABLE_REFERENCE` read via
  `POST /bus/read-property`, and koolenex's own bundled real KNX Master Data
  (`data/knx_master_1.xml`, `<InterfaceObjectType>` entries) for the standard object-type name —
  primary source for Part 10.
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
- `docs/data/captures/2026-08-29-ets-full-download-ga-9-1-4-to-9-1-5-1.1.9.pcapng`,
  `2026-08-29-koolenex-partial-download-revert-9-1-5-1.1.9.pcapng`, and
  `2026-08-29-ets-full-download-obj3-trigger-test-1.1.9.pcapng` (knx-ets-manager repo) — primary
  source for Part 11 and Part 10.3's trigger-test update.
- `docs/data/captures/2026-08-29-ets-full-download-obj3-flag-trigger-test-1.1.9.pcapng` and
  `2026-08-29-ets-full-download-obj3-flag-trigger-test-2-1.1.9.pcapng` (knx-ets-manager repo) —
  primary source for Part 10.1's decoded flag↔bit mappings.
- `docs/data/captures/2026-08-29-ets-partial-download-ga-change-9-1-4-to-9-1-5-1.1.9.pcapng` and
  `2026-08-29-ets-partial-download-ga-plus-flag-revert-1.1.9.pcapng` (knx-ets-manager repo) —
  primary source for Part 10.2's Partial-Download trigger resolution. (A third, mistakenly-
  triggered Full Download in between,
  `2026-08-29-ets-partial-download-ga-change-9-1-5-to-9-1-4-1.1.9.pcapng`, is kept for the record
  but is NOT a Partial Download despite its filename - real Full Download signature on the wire,
  confirmed by the user afterward as a misclick.)
- `docs/data/captures/2026-08-29-ets-full-download-1.1.10-systematic-{1,2}-clean.pcapng`,
  `...-3-tampered.pcapng`, `...-4-real-param-change.pcapng`, and
  `...-5-real-offset172-change.pcapng` (knx-ets-manager repo) — the 5-download controlled redo,
  primary source for Part 8's checksum-trigger finding and Part 10.3.
- `docs/follow-ups/2026-08-27-relmem-write-scope-investigation.md`,
  `docs/follow-ups/2026-08-28-write-path-missing-load-sequence.md`,
  `docs/follow-ups/2026-08-29-property27-ga-write-wiring-and-ui.md`,
  `docs/follow-ups/2026-08-28-full-download-history-and-blob-params.md`,
  `docs/follow-ups/2026-08-29-partial-download-mode-and-obj3-trigger-test.md` (koolenex repo) —
  the dated investigation logs this document consolidates. Read those for the full narrative,
  including dead ends, UI/implementation work, and the exact chronology of each fix.
- `koolenex_reference` memory (knx-ets-manager repo's persistent memory) — broader project
  narrative, including findings unrelated to the write path itself (e.g. the enum-mapping
  retraction in Part 3).
