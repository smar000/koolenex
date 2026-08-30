# KNX device write protocol — reference

**⚠️ Not an official or KNX-Association-endorsed document.** Everything below is this project's
own best-effort interpretation of observed device behavior, reverse-engineered from real network
traffic — not a reproduction of, or a substitute for, the official KNX specification. Where a
finding isn't independently confirmed against real hardware, it's tagged as such (see "How to
read this document" below); treat unconfirmed items as working hypotheses, not documented fact.

This document describes how a KNX configuration tool (ETS, the standard KNX Engineering Tool
Software) writes project data onto a physical KNX device over KNXnet/IP — the sequence of
messages sent, what each one means, and the byte layouts involved.

**Methodology**: every fact here was derived from real ETS 6.3 download sessions against
physical devices, with the actual network traffic captured and decoded byte-by-byte — not taken
from the KNX specification or ETS's own documentation directly. Where a byte's meaning is stated
without a spec citation, treat it as an empirically observed pattern (tagged accordingly, see
below), not a documented guarantee. For narrative/history behind these findings (how each one was
discovered), see the dated files under `docs/follow-ups/*.md`.

## How to read this document

Every factual claim is tagged:

- 🟢 **CONFIRMED** — directly observed on real captured traffic or real hardware (see
  [Sources](#sources)). Trust this.
- 🟡 **INFERRED** — a reasonable conclusion from confirmed evidence, not independently verified
  in isolation.
- 🔴 **SPECULATIVE** — a guess or open question. Not a fact.

**Sample size, throughout §1–§8**: all real-hardware evidence there comes from exactly two
physical devices, both from one manufacturer (Albrecht Jung), both the same KNX "mask version" (a
device classification explained in §1) — System B, `0x07B0`. Nothing in §1–§8 has been confirmed
against a different manufacturer, a different mask version, or other hardware, unless noted. §9
(device addressing) additionally uses a third, brand-new device from a different manufacturer
(HDL) — noted there specifically.

## Some KNX terms used throughout

A device's application logic exposes **communication objects** — application-level "channels"
(e.g. "switch output 1", "dimming value"). Each communication object can be linked to one or more
**group addresses (GAs)** — the "topic" addresses devices actually exchange values over on the
bus. A communication object's value has a **Datapoint Type (DPT)**, KNX's standard classification
of a value's format and size (e.g. "1 bit", "1 byte unsigned", "4 byte float").

Internally, a device organizes its own configuration data into **interface objects** — logical
sub-components addressed by a small integer, the **object index**. This document is mostly about
four of them: object 1 (the table of group addresses in use), object 2 (which communication
object is linked to which group address), object 3 (each communication object's own flags — see
§6.4), and object 4 (the device's actual application settings — every parameter a user configures
in the tool). Within an interface object, individual named attributes are called **properties**,
each addressed by a **property ID**.

Every device also reports a 2-byte **mask version** — a KNX-standardized code identifying which
"generation"/family of device management model it implements (e.g. `0x07B0` = "System B"). This
matters because it changes which lower-level services the device actually supports (§4.1).

## Test hardware

| Device | Individual address | Mask version | Role |
|---|---|---|---|
| KNX IP router (additional function) | 1.1.9 | `07B0` (System B) 🟢 | Primary test device |
| 4-gang dimmer actuator | 1.1.10 | `07B0` (System B) 🟢 | Secondary test device — real memory addresses above `0xFFFF`, and the only one of the two whose configuration declares the checksum step described in §7 |

Mask versions confirmed via a live device-descriptor read against real hardware (§2.1), and
cross-checked against the KNX standard's own published mask-version table, which classifies
`07B0` (and its variants `17B0`/`27B0`/`57B0`, for different physical media) as management model
"System B" — a real KNX-standardized device-family classification, not manufacturer-specific.

## 1. Session overview

Every real device-configuration session follows the same shape:

1. **Bootstrap**: connect, read device identity, authorize (§2).
2. **Per-object write cycle**, for each interface object that needs a change: mark it unloaded →
   start loading → declare the data that's coming → the real memory/property write(s) →
   mark it loaded again (§3–§4).
3. **Finalize**: write a version marker back, then restart the device (§5).

A **Full Download** runs this cycle for every relevant interface object, regardless of whether
its content actually changed — though the underlying memory write itself only ever writes the
bytes that actually differ (§6.1), never the whole object unconditionally. A **Partial Download**
is a stricter version of the same sequence: only the interface objects whose content genuinely
changed go through the cycle at all — everything else is skipped outright, with no "mark
unloaded" step and no write. The two are otherwise frame-for-frame identical, distinguished by
one single signal in the data (§4.2).

## 2. Session bootstrap

### 2.1 Connection and identity

A **device-descriptor read** is sent as the very first message of every real session 🟢 — the
device's response carries its mask version (§ above). 🟡 **INFERRED**: the tool almost certainly
uses this to decide device-family-specific behavior later (which memory-write service to use,
§4.1) — not confirmed from any spec text, but consistent with it being the literal first thing
done every time, and with the real mask-gated finding in §4.1.

Before the real work starts, several short-lived connections are opened and closed, doing
identity reads and a broadcast lookup of the device's serial number by address, sometimes
including a defensive restart request 🟢 — then the connection that does the actual work begins.
🟡 **INFERRED**: pre-flight identity/health checks; not everything here is necessarily required
for a correct download.

Identity/status values read early in every session (all simple property reads on object 0 unless
noted):

| Property purpose | Notes |
|---|---|
| Serial number | Readback, matches the device's real serial |
| Association-table capability descriptor (a property read on object 2) | Same single read every session, Full or Partial |
| Application version marker (object 4) | Read here, written back verbatim later — see §4.3 |
| A handful of other status fields | 🔴 Several of these values' exact meaning was never looked up against a KNX property reference — not required to understand the write path |

None of these early reads are content-dependent — none of them could reveal whether a device's
memory content had been tampered with out-of-band (relevant to §7.3).

### 2.2 Authorize

An authorize request/response exchange, using an access-level key. Sent once, early, with the
well-known default key (`0xFFFFFFFF` — used when a device has no special access restriction
configured); the response carries a 1-byte access level (`0` = full access, observed in every
capture). 🟢 Present in every real capture. 🔴 whether a device configured with a non-default
access key would behave differently is untested (this testbed's devices are presumed
factory-default).

## 3. The load state machine

Each interface object tracks its own state — **Unloaded**, **Loading**, or **Loaded** — via a
dedicated "load state control" property. Writing a specific event value to that property drives
the object through the state machine 🟢, confirmed identically across every real session
observed:

| Event written | Meaning | Resulting state |
|---|---|---|
| Unload | Mark the object as no longer valid, about to be replaced | Unloaded |
| StartLoading | Begin a new load | Loading |
| LoadData (+ 9 extra bytes, §4.2) | Declare what's about to be written — size, mode, fill value | Stays Loading |
| LoadCompleted | Commit the load | Loaded |

Objects that need writing are unloaded first, in reverse index order (e.g. 4 then 3 then 2 then
1), then loaded in a fixed order that is **not** simple ascending or descending index order
(observed order: 4, then 3, then 1, then 2) 🟡 — likely dependency ordering between objects
specific to the application, not verified against other configurations.

### 3.1 Phases are batched across objects, not run one object at a time

🟢 **Real ETS runs each load-state phase across every object that needs writing before moving to
the next phase**, rather than completing one object's entire Unload → StartLoading → LoadData →
resolve-address → write → LoadCompleted cycle before starting the next object's. Confirmed by
frame-by-frame decode of a real ETS capture: every object's Unload is sent first, then every
object's StartLoading+LoadData, then every object's memory address is resolved (the
`PID_TABLE_REFERENCE` read, §6), and only then does each object's write/LoadCompleted proceed.

This matters concretely for a genuinely blank (factory-reset) device, where an object's real
memory segment has never been allocated: `PID_TABLE_REFERENCE` reads back `0x00000000`
("unallocated") until the device itself allocates it as a side effect of processing the batch of
StartLoading/LoadData declarations across *all* objects together. An implementation that resolves
one object's address immediately after its own StartLoading/LoadData — before the other objects'
declarations have been sent — can read back an unallocated address for objects later in the
sequence, even though the exact same write would succeed once batched correctly. This was found
and fixed 2026-08-30 in `downloadDevice()` (`server/knx-connection.ts`) by collecting every
object's write into one job list and running each phase (Unload-all, StartLoading+LoadData-all,
resolve-all, write, LoadCompleted-all) across the whole batch, instead of a per-object sequential
loop. Confirmed end to end afterward: a real Full Download against a genuinely blank, factory-reset
device wrote all four objects cleanly in one run, and a subsequent Verify matched the parameter
memory byte-for-byte (0 of 8178 bytes differing).

## 4. Wire format reference

### 4.1 Memory write services

Two different lower-level services exist for writing raw memory content into a device: a
**legacy** form (16-bit address) and an **extended** form (24-bit address, needed for memory
locations above `0xFFFF`). **Real ETS used the extended form exclusively for every write
observed on this testbed** — including for addresses that fit easily in 16 bits, not just the
ones that structurally require the 24-bit form. 🟢, confirmed across every Full and Partial
Download captured, both devices.

The response to each such write carries a 1-byte status field (observed value `0x01` on every
successful write — 🔴 **SPECULATIVE**: given every one of these writes demonstrably succeeded,
this is unlikely to mean "an error occurred"; more likely a status/return code whose exact
meaning per the KNX spec isn't confirmed here) plus a 2-byte trailing value that looks like a
checksum of the written data 🔴 (pattern observed, not verified against a specific algorithm).

**Mask-version gating** (the most consequential finding here — it directly gates whether a write
silently fails):

- 🟢 Both real devices tested report mask `0x07B0` ("System B").
- 🟢 Real ETS used the extended write service exclusively for both.
- 🟢 A verbatim byte-for-byte replay of a real captured ETS write against real hardware
  persisted correctly. An identical write attempted using the legacy service instead (chosen
  because the target address happened to fit in 16 bits) failed to persist — reproducibly, with
  no error returned at any protocol layer.
- 🟡 **INFERRED, not proven**: that mask `0x07B0` ⇒ "requires the extended service" generalizes
  to every System B device, not just these two. Reasonable given the shape of KNX's own device
  classification, but the sample is two devices from one manufacturer.
- 🔴 Whether legacy (pre-System-B) mask families genuinely *require* the legacy service, or would
  also tolerate the extended one, is untested — no such device has ever been available to test.

**Gotcha**: at least one common packet-capture tool's own protocol dissector has repeatedly
mis-displayed this write's target address in its one-line summary view (observed showing one
address when the real decoded address, from the raw bytes, was a different one). Never trust a
capture tool's own summary/quick-view for a memory-write address — always manually decode the
raw bytes.

**Real per-chunk flow control, not a fixed pace** 🟢, found 2026-08-30 investigating a genuinely
blank (factory-reset) device: a large object (e.g. the parameter object, split into many
same-size memory-write chunks) sent as a fast, fire-and-forget burst — one write chunk immediately
after the previous, with no wait for each chunk's own response — measurably outruns the device's
own processing rate. Symptom observed live: after such a burst, the device kept sending write
responses for several more seconds (~9s trickle observed) after koolenex had already finished
sending, and any read issued to the device during that backlog (e.g. the next object's
`PID_TABLE_REFERENCE` resolve, §3.1) went unanswered — not because the address was genuinely
unallocated, but because the device had no processing capacity free to answer it.

**Real ETS never has this problem because it waits for each chunk's own write response before
sending the next one** — confirmed directly from a real capture: per-chunk response time varies
observably (56ms–279ms across chunks in the same session), never a fixed pace. This means the
correct fix is genuine flow control (wait for the real device response before sending the next
chunk), not a fixed or scaled delay between chunks — a scaled-delay guess was tried first and,
while it reduced the failure rate, did not fully eliminate it; real per-chunk `await` on the
matching `Memory_Response`/`MemoryExtended_Write_Response` (with a generous timeout and a
tolerant catch-and-continue, matching the existing `propWrite` pattern, since occasionally missing
one response should not abort the whole download) is what actually matched real ETS's own
behavior and resolved the issue. Implemented 2026-08-30 in `downloadDevice()`'s memory-write loop
(`server/knx-connection.ts`).

**Real per-chunk size: up to 228 bytes, not a small fixed pace** 🟢, found 2026-08-30 diagnosing a
correct-but-very-slow real download (every chunk got a real, healthy response - the flow-control
fix above was working - but writing 10KB of parameter memory still took several minutes). Decoded
every `MemoryExtended_Write` chunk size directly from a real ETS Full Download capture
(`docs/data/captures/2026-08-30_ets_full_download_serial_addressing.pcapng`): the real values seen
are 1, 2, 3, 4, 5, 6, 7, 10, 15, 30, 61, 62, 97, and 228 bytes - i.e. ETS writes as much as fits in
one chunk, capped at 228, using the smaller values only for a segment's tail remainder or
genuinely small segments, never a fixed small pace. koolenex's own `MEM_CHUNK` constant had been
`10` for as long as this per-chunk-flow-control code existed, with no real evidence behind that
specific number - it made every chunk correct, just forced roughly 23x more round trips than the
data needed. Fixed to `228`, confirmed against the real wire bytes above rather than assumed.
Confirmed live afterward on real hardware: a real Full Download to 1.1.10 (10,433 bytes of
parameter memory) that previously took 9+ minutes to reach 54% completed cleanly in ~38 seconds.

**The read side (`readMemory()`/`readMemoryMany()`, used by `/bus/verify-device`) has the same
slowness, for the same reason, and 228 turned out to be safe for reads too** 🟢 - a real
`MemoryExtended_Read` at 228 bytes against 1.1.10 came back `rc=252` (a genuine device-reported
error) on a first attempt live 2026-08-30, which looked at the time like reads and writes had
asymmetric safe chunk sizes. Root-caused the same day: that test used a stale database device id
(a project reimport had regenerated device rows), so the GA table's computed "expected" length was
wrong, and the read request over-ran the real, much smaller table actually allocated on the device
- confirmed directly, with the correct device id, that a single read at the table's real exact size
(6 bytes here) succeeds cleanly at any chunk size, including 228. Restored to 228, matching the
write side; `readRegionInSession()`'s own `Math.min(chunkSize, length - off)` already clamps
correctly down to a small region's real length regardless of chunk size, so 228 is safe for both
the large parameter-memory region (where it matters for speed) and small undeclared tables (where
it's a no-op).

**A second, genuinely separate read bug was found the same day, independent of chunk size
entirely** 🟢: a real device answered a large single read request (98 bytes, Object 3's whole
table) with a genuinely SHORT response (~34 real bytes) - the request was well-formed and the
device ACKed it (`returnCode=0`), it simply didn't return everything asked for in one response.
`readRegionInSession()`'s loop used to advance its read offset by the REQUESTED amount regardless
of how much data actually came back, permanently losing the shortfall - every later byte silently
stayed at the output buffer's zero default, indistinguishable from genuine on-device content. This
produced a symptom that looked exactly like a real device-side data-loss/hardware limitation (a
whole block of communication-object flags reading back as blank/default, consistently, across
multiple real downloads from both koolenex AND real ETS) until a deliberately smaller, separate
re-read of the same address range came back with the real, non-zero content the large read had been
silently dropping the whole time. Fixed: the read loop now advances by what was ACTUALLY received,
retrying for the genuine remainder, rather than assuming a fixed chunk size always arrives in full.
A real, general lesson from how long this one took to find: a symptom that looks identical whether
produced by "the device didn't persist this" or "our own read didn't retrieve this" cannot be told
apart by re-reading with the same buggy read path, no matter how many times or how carefully - it
took an intentionally differently-shaped read (a smaller, separate chunk) to reveal which one it
actually was.

**A third, separate read bug found the same day, once the short-response fix made larger reads
practical again** 🟢: the legacy (non-extended) `Memory_Read` service packs its requested byte
count into a 6-bit field of the APCI byte, giving a real maximum of 63, not 255 (the extended
service's limit). A request for exactly 64 bytes silently wrapped to a 0-byte count field
(`64 & 0x3f = 0`), producing a well-formed but meaningless request; the device correctly rejected
it with a genuine `Memory_Response returned zero bytes` failure. Fixed by capping the per-request
count to the real limit of whichever service is in use (63 legacy / 255 extended) before building
the request, rather than only after receiving a response.

### 4.2 The 9-byte "LoadData" declaration

Before writing the real content, the tool declares what's about to come, as 9 extra bytes on the
LoadData event (§3). Confirmed byte-for-byte identical layout across every real example
observed 🟢:

```
byte:    0     1-2      3-4         5      6      7-8
         flag  reserved size (BE)   mode   fill    reserved
```

- **flag** — always observed as one specific fixed value. 🔴 exact spec meaning not looked up;
  doesn't appear to vary.
- **size** — matches the object's real total write-segment size exactly, every time (e.g. 8178,
  98, 10, or 6 bytes, depending on the object). 🟢
- **mode** — **one value means a Full Download, a different value means a Partial Download**,
  confirmed for the parameter-memory object across one real Full and two real Partial Downloads
  on the same device. 🟢 for that object; 🔴 not independently confirmed for the other objects
  (no real Partial-Download example of this declaration exists for them, since those objects
  were only ever loaded at all during a Full Download in every real capture available).
- **fill** — the byte value the tool declares for filling any part of the segment it doesn't
  explicitly write (observed as one value for the parameter object, a different value for the
  others, both consistent with what's actually found on real device memory for genuinely
  untouched "gap" bytes). 🟢 for the value pattern; 🔴 for *why* the parameter object specifically
  differs from the others — not investigated, may be configuration-specific rather than a general
  rule.

### 4.3 Version-marker read-back-and-write-back

The tool reads a version-identifier property on the parameter object early in the session, then
writes the *identical* value back verbatim right before the final "mark loaded" step, in every
real capture (Full and Partial). 🟢 the pattern. 🔴 **SPECULATIVE** *why*: plausibly
"re-registering the freshly-loaded segment as belonging to a known application version, without
which the final commit might not durably take effect" — consistent with the fact that omitting
this step (in an early, buggy write-path implementation) correlated with writes not persisting,
but no controlled test isolates this one step's necessity on its own.

## 5. Session finalization

A restart request is sent once, at the very end, and gets a real response acknowledging it. 🟢
the pattern; 🔴 the response's trailing bytes' exact meaning (possibly a "how many seconds this
will take" field) is not spec-confirmed.

**Timing** (this testbed only, not necessarily representative elsewhere) 🟢: round-trip
acknowledgement typically 5–15ms per message; most load-state transitions ~10–60ms, except
"start loading → declare data" and the final "mark loaded" step, which can take 300–600ms — worth
knowing if a write-path implementation has a timeout waiting for the device to restart and
respond again afterward. Full Download total wall time ~6s; Partial Download ~2.7s. 🔴 whether
these scale with parameter memory size or network conditions is untested.

## 6. Per-object write mechanics

### 6.1 Object 4 — application parameter memory

The largest object, holding every user-configured setting. 🟢 **A Full Download only writes bytes
that actually differ from what's already on the device** — confirmed directly (a real "clean"
Full Download, with zero actual configuration changes, wrote a single differing byte, not the
whole multi-thousand-byte segment) and confirmed history-independent: a device carrying stale or
out-of-band content is detected and corrected (§7.3), not silently trusted just because it
happens to match.

**Sub-byte-packed parameters and padding bits**: when a parameter occupies only part of a byte
(e.g. a single-bit setting sharing a byte with other unrelated bits), the byte's other,
unrelated bits — not covered by any parameter — should be zero-filled, not left at whatever
generic "unwritten gap" fill value the rest of the segment uses. 🟢 confirmed against real
device content: a real single-bit setting's real on/off values are `0x80`/`0x00` (only the one
bit varying), not `0xFF`/`0x7F` as a naive "fill the rest with the generic gap value" approach
would produce. Bytes genuinely untouched by any parameter still use the generic fill value.

**Large "blob" parameters**: some parameters use a multi-hundred-byte raw-data type rather than a
simple scalar/text/numeric value (their declared maximum size, in bytes, is stated directly in
the project data). 🟢 confirmed against real project data and real device content: **the wire
format for one of these is a 4-byte length value (big-endian) followed by the actual payload**,
not the raw payload alone. 🔴 whether this framing (a length prefix before the payload)
generalizes to every blob-typed parameter, or is specific to the one case it was confirmed
against, is unconfirmed.

### 6.2 Object 1 — group address table

Wire format: a 2-byte count, followed by one 2-byte group address per entry, in the standard raw
16-bit main/middle/sub-group encoding, no reordering. 🟢, small sample (2 devices, one
manufacturer).

### 6.3 Object 2 — association table

Wire format: one entry per link, each a pair of 2-byte numbers — which group-address-table
position it refers to, and which communication object it's linked to — 1-based, referring to
table *position*, not a value match. 🟢, same sample caveat.

**Entry order encodes which link is the "send" link.** For a communication object with multiple
links, the first entry in table order (not necessarily the lowest position number) is the one it
actively transmits on; the rest are receive-only. 🟢 confirmed directly: swapping which of two
group addresses a communication object sends on swaps the order of the two matching entries here,
with no other change anywhere (the object-3 flags described below, and the group address table
itself, are both unaffected). Link direction is **not** represented anywhere else — this entry
order is the only encoding of it.

**A real bug, found 2026-08-30**: koolenex's own table builder sorted entries by group-address
index/communication-object number before writing them, discarding this real declared order. The
communication objects are already supplied to the builder in the project's own declared order;
the sort was unnecessary and actively wrong. Fixed by removing it. Confirmed byte-for-byte against
a real ETS capture once removed.

### 6.4 Object 3 — per-communication-object flags table

🟢 This is the standard KNX "Group Object Table" — confirmed via a live object-type property read
on a real device, cross-referenced against the KNX standard's own published interface-object-type
list. Distinct from the group address table (object 1, holds the addresses themselves) and the
association table (object 2, maps links to communication objects) — a table specifically about
each communication object's own settings (its flags, priority, and expected data size).

**Size and location**: per-device/configuration — 98 bytes at one address on one device, 942
bytes at a different address on the other (readable via a standard "give me this object's real
memory location" property, stable across sessions). The size is computable directly:
`size = 2 × (highest communication-object number the configuration statically declares) + 2` —
deliberately the configuration's total possible range, not a given device's currently-linked
subset (space is pre-allocated for every communication object the configuration could ever
expose). Confirmed exact against both real testbed devices.

**Record layout** — a 2-byte header followed by 2 bytes per communication object:

```
bytes 0-1:   header — total declared communication-object count, big-endian

byte offset within the table (for communication object number N, N ≥ 0) = 2 × N

  flag byte:
  bit:  7      6         5           4      3     2                       1  0
        Update Transmit  Read-On-Init Write  Read  Comm-flag AND has-link  Priority

  companion byte: standard KNX "Group Object Size" code (see table below)
```

The offset formula does not shift when an object is disabled or unlinked 🟢 — confirmed directly
(disabling a lower-numbered object's communication left every higher-numbered object's byte
position unmoved). Safe to use unconditionally, without needing to know which objects are
currently active.

**Flag bits**, confirmed by systematic one-flag-at-a-time real hardware testing (each change
made individually, its exact effect on this table observed, then reverted), cross-confirmed on a
second communication object on the same device, a third object with a different data type/size,
and blind on a second device entirely (the expected byte was predicted purely from the
configuration data before capturing the real device, and matched exactly):

- **Update, Transmit, Read-On-Init, Write, Read** — plain per-object on/off settings, each
  independently confirmed. (Read-On-Init means: read this object's current value from the bus
  automatically when the device starts up.)
- **Bit 2 = "Communication enabled AND has at least one real link" — both required, a combined
  state, not the Communication setting alone.** 🟢 Confirmed via three independent real tests:
  removing a linked object's only group-address link flips this bit to off even with
  Communication still enabled; disabling Communication on a linked object also flips it to off
  even with the link left fully intact; an object with two links shows the same bit as one link
  (a plain "has at least one link" boolean, not sensitive to how many). Link *direction* is not
  represented here at all (§6.3).
- **Priority** (the last 2 bits) — one of four levels a communication object can be sent/received
  at on the bus:

  | Priority | Bits |
  |---|---|
  | Low | `11` |
  | Alarm | `10` |
  | High | `01` |
  | System | `00` 🟡 inferred by pattern — this level isn't reachable from ETS's own user interface at all (per KNX's own documentation), so no real configuration can exercise this value directly to confirm it |

**A real parser bug, found 2026-08-30**: a project's XML declares each communication object twice
— once at the application level (the object's default `Read-On-Init`/`Priority`), and once per
device instance, which can override either. koolenex's parser only read the application-level
declaration; a device-instance override was silently dropped. Fixed by also reading the
instance-level attributes, when present, and preferring them. Confirmed against a real ETS
capture: the affected byte (Read-On-Init) now matches exactly once the override is applied.

**Group Object Size code** (the companion byte) — the standard KNX 4-bit code for a
communication object's expected data size, confirmed 4-for-4 against real declared sizes on two
devices/manufacturers:

| Code | Size | Code | Size |
|---|---|---|---|
| 0 | 1 Bit | 8 | 2 Byte |
| 1 | 2 Bit | 9 | 3 Byte |
| 2 | 3 Bit | 10 | 4 Byte |
| 3 | 4 Bit | 11 | 6 Byte |
| 4 | 5 Bit | 12 | 8 Byte |
| 5 | 6 Bit | 13 | 10 Byte |
| 6 | 7 Bit | 14 | 14 Byte |
| 7 | 8 Bit / 1 Byte | 15 | variable length |

🔴 Whether this record layout holds for a device outside the "System B" mask family (§ above) is
untested — only System B has ever been available.

**Write triggers** (§7.2/§7.3 describe the general mechanism this table shares with objects 1/2;
specifics for this table):

- **Partial Download**: written together with objects 1/2 exactly when any communication
  object's state genuinely changes — a group-address link, a flag, or Priority — confirmed
  across many real downloads, both directions (written when something changed, correctly skipped
  when nothing did).
- **Full Download**: on the device whose configuration declares the checksum step (§7), written
  exactly when that checksum comes back looking wrong (§7.3) — not for any kind of genuine
  configuration change on its own. On the device whose configuration never declares that step at
  all (so has no way to detect tampering), it's written on every Full Download tested,
  unconditionally. 🟡 A coherent, well-supported explanation — a device with no verification
  signal defaults to always rewriting this table just to be safe — but not a controlled test that
  isolates the cause.

## 7. The content-status ("checksum") property and the safety-net rewrite

### 7.1 What it is, precisely

**Property ID 27**, read/written on interface objects 1 (group address table), 2 (association
table), 3 (per-communication-object flags table), and 4 (parameter memory) — the same property
number, repeated across four different objects, one content-status value per object. It's
effectively a checksum the device itself computes over that specific object's own content, so
the configuration tool can ask "does what's on you still match what I last wrote?" without
reading the raw memory bytes back and comparing them directly. A real example of a valid value
read from object 4's property 27 on the test device that uses it: `000028C0003365E4000000010133DCBD`
(16 bytes) — this exact value recurs identically across every genuine session with no tampering.

Whether a device's configuration even makes use of property 27 at all comes from the
configuration data itself, not a decision the tool makes dynamically: every device's own
configuration carries a "what to do on download" recipe (a list of load-procedure steps) —
authored by the device's manufacturer as part of the product data, not computed at download time.
Only configurations whose recipe includes a property-27 step touch it at all; one of this
project's two test devices' recipes never mentions property 27, so it is completely absent from
every session with that device — no read, no write, in any form, at any stage.

The device that does declare it has, in its recipe, two separate "write this literal fixed byte
value into object 4's property 27" steps, positioned before the step that writes the real
parameter content, followed by a "read (not write) object N's property 27" step for each of
objects 1, 2, 3, and 4, positioned at the very end of the session.

Two real wire facts about this mechanism, confirmed on real hardware across multiple independent
downloads, on the one device whose configuration declares it:

- 🟢 **The end-of-session read step really is read-only, for all four objects it's used on** —
  the value read back is byte-identical to what was there before the session started. Despite
  being labeled as a "load" step in the configuration data, it never writes anything; the only
  actual write to property 27 anywhere in the whole session comes from the two "write this
  literal value" steps against object 4 specifically, near the start.
- 🟢 **The literal byte value declared in the configuration data for those two write steps is
  always exactly 2 bytes longer than what's actually sent over the wire** — the tool drops the
  last 2 declared bytes before transmitting.

🔴 Only one device configuration has ever declared property 27 at all — the *shape* of both
facts above is backed by many different manufacturers' declared configuration data (the same
two-step pattern, just with different embedded byte values, recurs across several unrelated
manufacturer IDs), but live wire confirmation is from this one real device only.

### 7.2 The group-address/association/flags tables are written by a mechanism outside any one configuration's control

🟢 Real ETS writes the group address table and association table during a Full Download via the
identical unload/start-loading/declare-data/write/mark-loaded mechanism used for parameters —
regardless of whether the device's own configuration recipe (§7.1) declares a step for them at
all. One test device's configuration declares no step whatsoever for these two tables, and ETS
writes both anyway; the other device's configuration declares the read-only checksum-verification
step instead (§7.1), and ETS still writes both via this same separate mechanism. 🟡
**INFERRED**: this table-writing procedure is apparently universal, tied to the device's mask
version rather than something each configuration must ask for — not confirmed from spec text,
only from the absence of a declaration combined with real wire evidence. Confirmed independently
on both test devices. 🔴 whether this holds for every mask family, or for configurations with
many more group-address/association entries, is untested.

### 7.3 The safety-net rewrite, and what triggers it

Does a device carrying stale content — from a different, discarded configuration, or a factory
reset — keep that content forever, if it happens to already match what the *current*
configuration's target computation predicts needs no write?

🟢 **No.** A value written directly into device memory bypassing the configuration tool entirely
is detected on the very next real Full Download — not via a minimal targeted correction, but a
**comprehensive rewrite**: nearly the entire parameter segment, the per-communication-object
flags table, and both the group-address and association tables. Reproduced on both test devices.
The rewrite's content is correct, not a blind reset to factory defaults — real, previously
in-place values are written back correctly where they should stay unchanged.

🟢 **The detection mechanism, confirmed across 5 independent real Full Downloads on the device
whose configuration declares property 27 (§7.1)**: early in every session, before any load/write
decision, the tool reads object 4's property 27. In every genuine session — two clean baselines,
a real group-address-link change, a real parameter change — this read returns the same valid
16-byte value, e.g. `000028C0003365E4000000010133DCBD`. In the one session preceded by an
out-of-band write (a value written directly into device memory, bypassing the tool entirely), the
identical read instead returns **empty — zero bytes, not a different-but-valid value** — the
device's own checksum computation broke down as a direct, observable consequence of the
tampering. This is not a raw memory read (no memory-read message of any kind appears in any of
these captures) — it's a property-level read whose *result* differs based on device state, and it
happens well before the unload/reload cycle begins for any object.

A decisive control test isolated the real variable: writing the *exact same byte* via the
configuration tool (instead of bypassing it) produces a valid checksum and no comprehensive
rewrite — the origin of the write (genuine tool-driven session vs. out-of-band) is what matters,
not the byte or parameter itself. Neither "any configuration change to a parameter" nor "any
configuration change to a group-address link" triggers the comprehensive rewrite on its own.

🔴 Whether this generalizes beyond the one device configuration checked (the only one that
declares the checksum mechanism at all) is untested, as is the precise decision rule once an
anomaly is detected (whether it's graded, or always the same universal rewrite).

## 8. Known tooling/methodology gotchas

- **At least one common packet-capture tool's own protocol dissector mis-displays memory-write
  addresses in its summary/quick-view column** (§4.1). Always manually decode the raw bytes;
  never trust a summary column for a memory-write's address.
- **This router's KNXnet/IP tunneling connection uses TCP, not UDP** — a UDP-only capture filter
  catches nothing from real sessions against it. Worth checking which transport a given device
  actually uses before assuming the KNXnet/IP default.
- **Windows path handling across tools**: a process spawned as a native Windows executable does
  not reliably translate Unix-style paths (`/tmp/...`, `/c/...`), whether passed as arguments or
  used in direct file-system calls from within a cross-platform runtime. Use explicit
  `C:/Users/...`-style forward-slash paths for direct file I/O on Windows, and prefer writing
  intermediate results to files rather than piping between processes when mixing a Unix-style
  shell with native Windows tools.

## 9. Device addressing — a separate protocol family

Everything above (§1–§8) assumes the target device already has a known individual address on the
bus. **Assigning that address in the first place is a different KNX service family — "network
management".** This section is deliberately kept separate from the rest of the document; it's
about addressing, not configuration content.

Three such services are implemented in `server/knx-connection.ts`:

- `checkProgrammingMode()` — `A_IndividualAddress_Read`, the standard button-press discovery
  broadcast real ETS uses for its normal "press the button on the device you want to commission"
  flow.
- `readSerialNumbersInProgrammingMode()` — `A_SystemNetworkParameter_Read`/`_Response` for
  `PID_SERIAL_NUMBER` (object type 0 = Device): `NM_Read_SerialNumber_By_ProgrammingMode`, reading
  the serial number of whichever device(s) are in programming mode, no address needed at all.
  Collects every reply within the timeout window rather than stopping at the first, since multiple
  simultaneous devices reply cleanly with no collision (🟢 confirmed) — the real way to
  disambiguate multiple *blank* devices, whose addresses would otherwise be identical (shared
  factory default).
- `writeIndividualAddressBySerial()`/`readIndividualAddressBySerial()` — `A_
  IndividualAddressSerialNumber_Write`/`_Read` (spec 3/5/2 §2.5/§2.4), a no-button-press
  alternative that addresses a device by its 6-byte KNX serial number instead.

### 9.1 Real wire format, confirmed byte-for-byte against a real ETS capture 🟢

Settled by capturing real ETS traffic (tshark) during a factory-reset + full-download
commissioning cycle (button press, address assignment, serial-number verify) against this
project's own testbed router:

- **All four services above are sent as GROUP-type cEMI frames to address `0/0/0`** (KNX's
  "default broadcast" address) — not an individual-type frame to `0.0.0`, and not KNX's separate
  "system broadcast" ctrl1 bit.
- **All four use ctrl1 `0xB0`** — the *ordinary* broadcast bit (bit4=1) at **System priority**
  (bits3-2=`00`) — not the plain `0xBC` (Low priority) every other frame in this codebase uses.
- `A_IndividualAddressSerialNumber_Response`'s payload is `[serial(6)][4 reserved zero bytes]` —
  no address field; the device's address is carried by *which device replies* (cEMI `src`), the
  same convention `A_IndividualAddress_Response` uses.
- `A_SystemNetworkParameter_Response`'s payload echoes the request's operand byte before the
  actual value: `[objectType(2)][pid<<4 (2)][echoedOperand(1)][...value]`.
- Response APCI `0x3DD` (`A_IndividualAddressSerialNumber_Response`) is confirmed real.

All four services are sent over the **normal Tunneling connection** — Routing/multicast is not
required for any of this. A Routing/multicast connector and TCP Tunneling support both exist in
this codebase as real, independently useful capabilities (`knx-protocol-routing.ts`,
`knx-protocol.ts`) - TCP Tunneling in particular matches what real ETS itself uses against this
router, where this codebase previously spoke UDP only - but neither is a prerequisite for the
services documented in this section.

### 9.2 Confirmed working end-to-end on real hardware 🟢

`checkProgrammingMode()` correctly returns a pressed device's real current address; the new
`readSerialNumbersInProgrammingMode()` correctly returns that same device's real serial number
(independently cross-checked against the value decoded from the ETS capture itself) with the
correct current address. `writeIndividualAddressBySerial()`'s write was independently confirmed to
take effect on real hardware (a device moved from its factory-default address to a real target
address) even before this correction; the correction fixes its own read-verify step, which had
been silently failing due to the wrong response-payload decode above.

## Sources

Real capture files backing every 🟢-tagged claim above live in this project's `docs/data/
captures/` directory, organized by date and topic — session bootstrap and the overall Full/
Partial Download walkthrough (§1–§5), memory-service/mask-version gating (§4.1), group-address
and association table formats (§6.2–§6.3), the per-communication-object flags table's full
bit-mapping (§6.4), the content-status/checksum mechanism and its safety-net rewrite trigger
(§7), and the tshark address-mis-display gotcha (§8). §9's 🟢 claims are sourced from live tests
against real hardware via this app's own routes, plus a real tshark capture of ETS's own
commissioning traffic (factory reset + full download) that settled the exact wire format. The
dated files under `docs/follow-ups/*.md` consolidate the full investigation narrative,
including dead ends and exact chronology, for anyone who wants the "how this was found" story
rather than just the current facts above.
