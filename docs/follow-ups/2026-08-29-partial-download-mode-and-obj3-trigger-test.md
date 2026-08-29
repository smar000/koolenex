# 2026-08-29: partial-download mode built, real-hardware round trip, and an Object 3 trigger test

**Status: implementation history and narrative.** Distilled protocol facts belong in
`docs/knx-device-write-protocol.md` (Part 11 for the partial-mode facts, Part 10 for the
Object 3 update) - this file is the "how did we get here" record: code changes, commit
hashes, methodology, and the honest result of a test that turned out inconclusive.

## Background

User picked up the still-outstanding "write path" work with an explicit ask: revert a GA
change (9/1/4 → 9/1/5, set via a real ETS Full Download) back using koolenex, specifically
via "a partial download mode." Checking `POST /bus/program-device` and `downloadDevice()`
directly (not assuming) showed **no partial/delta mode existed anywhere in koolenex** -
every call, regardless of intent, always performed the equivalent of a Full Download.

## Part 1: building partial-download mode

Added `DownloadExtra.mode: 'full' | 'partial'` to `knx-connection.ts`'s `downloadDevice()`.
`'full'` (the default) is byte-for-byte the pre-existing behavior - no regression risk, all
1195 pre-existing tests pass unchanged. `'partial'` is new:

- Before touching an interface object (the parameter segment via `WriteRelMem`, or the
  synthesized GA/Association table writes via `writeUndeclaredTable`), read its current
  on-device content within the SAME management session (reusing the private
  `readRegionInSession` helper, previously only used by the read-only verify path) and
  compare it to the computed image. If it already matches, skip the ENTIRE
  Unload/StartLoading/LoadData/write/LoadCompleted cycle for that object - not just the
  memory-write chunks, the whole thing, mirroring the "17 bytes only, rest skipped"
  optimization observed in an earlier real ETS Partial Download capture (see the reference
  doc's §1.2).
- When a write does happen, the LoadData mode byte is forced to the real captured Partial
  value (`0x00`) instead of following the model's own declared full/combined shape (which
  `'full'` mode still follows unchanged).

Exposed via `POST /bus/program-device`'s new `mode` body field (`z.enum(['full',
'partial']).optional().default('full')`).

New test coverage: `tests/partial-download-mode.test.ts` (3 tests) - a self-contained
protocol-level fake device that answers both reads AND writes against its own backing
buffer (existing fixtures only handled one or the other). Locks in: (1) the object is
skipped entirely when it already matches, (2) it's written with mode byte `0x00` when it
genuinely differs, (3) `'full'` mode's behavior is completely unaffected either way. All
1198 tests pass (1195 existing + 3 new). Typechecked clean.

Commit `5ac9aef` on `test/relmem-real-device-fixtures`, pushed.

## Part 2: real-hardware round trip, first try

Against 1.1.9 (local testbed):

1. User changed GA 9/1/4→9/1/5 in ETS, ran a real Full Download - captured
   (`2026-08-29-ets-full-download-ga-9-1-4-to-9-1-5-1.1.9.pcapng`, knx-ets-manager repo).
   Verified directly against the device via `/bus/verify-device` (not inferred from ETS's
   own report): `actualValue: "9/1/5"`. Decoded the capture directly too:
   `MemExtWrite X=$004000 $000249014905` is the real GA table write; `MemExtWrite
   X=$00470A $00020001000500020008` the Association table, independently confirming the
   GA-index↔com-object mapping.
2. koolenex Full Download (existing `mode: 'full'` default, against a stale cached project
   still declaring 9/1/4) reverted the device to 9/1/4 - verified directly
   (`totalDiffering: 0`).
3. Re-imported the current, now-updated `.knxproj` (declaring 9/1/5 again, post step 1) as
   a fresh koolenex project. Ran the brand-new `mode: 'partial'` download against the same
   device - captured (`2026-08-29-koolenex-partial-download-revert-9-1-5-1.1.9.pcapng`).
   Verified directly: `actualValue: "9/1/5"`, `totalDiffering: 0` across all 13 rows.

**The capture decode is what makes step 3 a real confirmation, not just a passing test**:
the parameter segment (objIdx4, 8178 bytes, genuinely unchanged) and the Association table
(objIdx2, 10 bytes, genuinely unchanged) were both read, compared, and the entire
load-state cycle was skipped for each - no `PropValueWrite OX=4` or `OX=2` frames anywhere
in the capture. Only the GA table (objIdx1, the one real change) was written, with the
LoadData mode byte correctly `0x00` (Partial), not the `0x01` (Full) byte seen in every
earlier Full Download capture.

## Part 3: the Object 3 trigger test - result is genuinely inconclusive, not positive

Separately, reviewing today's own captures surfaced that the plain ETS Full Download in
step 1 above **also wrote Object 3** - worth a direct check against the standing open
question from the reference doc's Part 10 (why does ETS only rewrite Object 3 on *some*
Full Downloads?). The leading pattern from 1.1.10's 08-28 session was "only after an
out-of-band write" - user proposed testing that directly on 1.1.9: deliberately tamper with
the device out-of-band, leave ETS's project unchanged, and see if a real Full Download both
corrects the tampering AND writes Object 3.

**Setup**: resolved the GA table's live base via `POST /bus/read-property`
(`objIdx=1, propId=7` → `0x4000`), then used `POST /bus/write-memory` with a real
`RelSegment` load sequence (`objIdx=1, size=6, fill=0, combined=false`) to write
`000249014904` (GA 9/1/1 + 9/1/4) directly into device memory - bypassing any project
entirely. Confirmed via `POST /bus/read-memory` that this genuinely persisted
(`000249014904`), while the koolenex-imported project (and ETS's own, unchanged) still
declared 9/1/5.

**Result**: user ran a real ETS Full Download of the unchanged project - captured
(`2026-08-29-ets-full-download-obj3-trigger-test-1.1.9.pcapng`). ETS detected and corrected
the tampering (`MemExtWrite X=$004000 $000249014905`, confirmed via read-back) -
reconfirms Part 8's history-independence finding on a second device. Object 3's LoadData
(`OX=3 P=5 $030B...`) fired too.

**Why this doesn't actually confirm the hypothesis**: cross-checked against every other
1.1.9 Full Download capture this project has, including the two from earlier today with NO
tampering beforehand:

| Capture | Tampering beforehand? | Object 3 written? |
|---|---|---|
| `2026-08-28-ets-1-full-download-1.1.9.pcapng` | No | Yes |
| `2026-08-29-ets-full-download-ga-9-1-4-to-9-1-5-1.1.9.pcapng` (today, clean GA change) | No | Yes |
| `2026-08-29-ets-full-download-obj3-trigger-test-1.1.9.pcapng` (this test) | Yes | Yes |

Every single 1.1.9 Full Download ever captured writes Object 3, tampered or not. The
tampering hypothesis predicts "written when tampered" - true here - but the untampered
baseline for 1.1.9 is *also* always "written," so this test cannot distinguish "triggered
by tampering" from "1.1.9's app always rewrites Object 3 on every Full Download,
unconditionally." The only place the hypothesis has actually been observed to vary is
1.1.10's single 08-28 session (2 of 4 downloads) - a genuinely different device/app
(different manufacturer app entirely, not just a different unit of the same one).

**Honest conclusion**: not confirmed, not refuted for 1.1.10 - genuinely inconclusive for
1.1.9 specifically, because the wrong device was tested for this particular question (its
baseline behavior doesn't vary, so no test on it can show a trigger). To actually settle
this, the next test needs to be on 1.1.10 (or another device known to sometimes skip
Object 3): a clean, untampered Full Download to confirm the "no write" baseline still
reproduces, followed by a deliberately tampered one, in a controlled A/B rather than relying
on the single historical 08-28 session alone.

## Part 4: Object 3's content decoded - a real per-communication-object flag bitfield

User pushed back on the trigger test's framing twice, both corrections real and load-bearing:

1. **"Are you sure obj 3 is a GA holder?"** - a fair check given the name similarity between
   "Group Address table" (object 1) and "Group Object Table" (object 3). Clarified: they're
   different objects with different real content - object 1 holds the GAs themselves, object 3
   holds per-communication-object metadata (flags etc.), confirmed via KNX Master Data (Part 10).
2. **"Could obj 3 be related to communication flags?"** - a much better-targeted hypothesis than
   the tampering/uncertain-state theory, given what a Group Object Table actually is.

Tested directly: flipped the **Update** flag on com-object 7 (NTP sync input, off→on) via a real
ETS Full Download, nothing else changed. Object 3's own 98-byte payload differed from the
previous capture at **exactly one byte** (offset 14: `0x53`→`0xD3`), and those two values differ
by **exactly one bit** (`XOR 0x80`). A second test in the same session reverted that flag AND
flipped **Read-On-Init** on com-object 6 (Date/time input, off→on) - offset 14 correctly reverted
to `0x53` (confirming the first mapping wasn't a coincidence) while a *different* byte, offset 12,
changed instead (`0x53`→`0x73`, `XOR 0x20`) - a clean, independent second mapping. Both objects
sit 2 bytes apart, consistent with a small regular per-object record.

## Part 5: the "GA never touched on Partial Download" claim was wrong - confounded, not tested

User correctly challenged this (stated as fact in Part 4's own trigger-test framing above):
every Partial Download capture that existed at the time happened to have zero GA changes in it,
so "never touched" and "only touched when a GA changes" were indistinguishable from that data -
an overclaim, not a lie, but a real methodology gap. Also separately requested a systematic redo
of 1.1.10's 2-of-4 Full Download pattern before trusting it (single historical session, never
reproduced) - noted as still outstanding, not done this session.

Tested directly, twice, in both directions:
- Real GA change (9/1/4→9/1/5) via genuine Partial Download: `OX=1/2/3` all fired,
  `OX=4` (unrelated parameters) correctly skipped. (First attempt at this specific test was
  actually a Full Download by mistake - user caught and corrected it immediately; kept as a
  labeled record, not counted as a Partial Download result.)
- Reverting that same GA change (9/1/5→9/1/4) plus reverting the Read-On-Init flag from Part 4,
  same download: same result, `OX=1/2/3` fired, `OX=4` skipped, and Object 3's content correctly
  showed the flag reverted (offset 12 back to `0x53`).

**Clean, reproduced conclusion**: on Partial Downloads, GA table / Association table / Object 3
are written together exactly when a GA/link genuinely changes, and skipped together otherwise -
not "never touched," a real conditional trigger, symmetric in both directions. Full details and
the exact per-capture table: reference doc §10.2.

## Part 6: systematic 1.1.10 redo, and the checksum-read discovery

User explicitly pushed back on treating 1.1.10's historical 08-28 2-of-4 Object 3 pattern as
settled - it was a single, unreproduced session, and the two "not written" cases could have been
"anomalies, error on my part, error on your part or any number of things." Requested a systematic,
controlled redo before forming any strong opinion - the right call, and it paid off.

Ran five real Full Downloads to 1.1.10 in sequence, each separately captured: two genuinely clean
(no project changes at all), one with an out-of-band tamper (same offset-172 parameter used
throughout the original investigation, written via `/bus/write-memory` bypassing any project),
and - after the user specifically proposed testing "does an intended project write to a parameter
also trigger Object 3" - two genuine, ETS-driven changes: a GA link re-point, and a change to the
*exact same* offset-172 byte the tamper test used, this time via ETS itself (confirmed by decoding
the resulting real write: `MemExtWrite X=$0C30AC $1E` = 30 decimal, matching the 30-second
"Display length" value set). Result table in the reference doc's Part 10.3 - the tampered
download was the only one that wrote Object 3, and the same-byte control (test 5) is what makes
this decisive rather than just "tampering vs nothing."

**Along the way, a genuine mid-session correction**: the user asked directly "are you 100% sure
ETS does not read anything from the device before it starts the full download?" - a fair
challenge to a claim in this document taken on faith rather than freshly re-checked. Re-examining
the actual capture data (not just recalling the earlier "no live memory read" finding) surfaced
that ETS DOES read something meaningful early in every session: `PropertyValue_Read OX=4 P=27`,
the same content-dependent checksum property already known from Part 7. Every genuine session
got back the identical valid 2-element response; only the tampered session's identical request
came back empty (`N=0`). This is the real detection mechanism for Part 8's comprehensive-rewrite
fallback - not a raw memory read (there genuinely are none, that part of the original claim
holds), but a property-level checksum whose result differs based on real device state. Full
decode: reference doc's Part 8 and Part 10.3.

**Lesson worth repeating**: the "no live memory read anywhere, detection mechanism unknown"
framing had stood unchallenged in this document since 2026-08-28 - re-verifying it from the raw
capture data (rather than trusting the prior write-up) is what surfaced the actual mechanism.
Don't assume an established claim in this doc is still fully checked just because it's tagged
🟢 - re-derive from source when it matters, especially when directly asked to confirm something.

## Part 7: full bit-by-bit mapping of Object 3's record layout, cross-device confirmed

User asked directly whether koolenex could now *build* Object 3 write packets, given the identity
and two flag mappings already known. Correct answer at the time: no - two bit positions out of a
98/942-byte object, no known record layout or offset formula, no idea whether Communication or
Priority were even represented. User: "let's investigate in turn and try to break the back on
this one."

**Methodology**: toggled one communication-object flag at a time on com-object 7 (1.1.9),
comparing each capture's Object 3 payload against the immediately preceding one, confirming a
single clean bit flip each time before moving to the next flag. User's own methodological
choices along the way, all correct and load-bearing:

- Used Partial Download for most tests (faster, and - as it turned out - itself confirmed a real
  finding: Object 3 gets written on Partial Downloads for flag-only changes too, not just GA
  changes, broadening §10.2, reference doc).
- After the Communication-flag test came back with literally zero change anywhere, asked for a
  full 98-byte comparison (not just the region already being watched) against the immediately
  prior capture - confirmed byte-for-byte identical, then asked for a retry to rule out a UI/save
  mistake before accepting it as real. Reproduced identically on retry.
- Then asked for a full **whole-capture** frame-by-frame comparison (every read, every write, not
  just the three memory writes) between the two captures - found exactly one difference, an
  ACK-coalescing timing artifact with zero content difference. This is the level of rigor that
  makes the negative Communication-flag result trustworthy rather than "we didn't look hard
  enough."
- Independently caught and corrected an assumed "Priority" field before it had been confirmed to
  exist in this device's actual ETS UI (not in the flags row - a dropdown just above it, found
  after the correction).
- After mapping Priority's three available values (Low/Alarm/High showed a clean linear
  2-bit pattern; System was not available as an option on this object, so `00` is inferred by
  pattern, not confirmed), asked for a full reset-and-compare sanity check: reverted every flag
  and Priority back to manufacturer default, then diffed the resulting capture against the very
  first pre-testing baseline - byte-for-byte identical, full whole-stream comparison, confirming
  the whole test sequence was self-consistent and left nothing lingering.
- Requested verification on a **second communication object** (6) before trusting the layout
  generalizes - Update and Read both landed exactly where the offset formula (`2 × 12` and
  `2 × 14`... i.e. `2 × object number`) predicted, including a two-flags-simultaneously case
  computed correctly (`0xD3 | 0x08 = 0xDB`) before the capture was even decoded.
- Requested one final test on **1.1.10** (a different device, different manufacturer app
  entirely) specifically to test whether the structure is app-specific or a real mask/device-
  generation-level standard - and, rather than saying what had changed, asked me to determine it
  from the capture alone. Computed the expected default byte from the app's own XML
  (`M-0004_A-3030-23-F0EA-O000A.xml`, object 96 "Dimming channel 4") and diffed against the real
  captured value (`0xDB` at offset `0xC0` = `2×96`) - correctly identified the Write flag as the
  single change, blind, before being told the answer. Confirmed correct.

**Result**: a complete, computable record structure -
`offset = 2 × communication-object-number`, `bit7=Update, bit6=Transmit, bit4=Write, bit3=Read,
bits1:0=Priority (Low=11/Alarm=10/High=01/System=00 inferred)`, `Communication=no representation
anywhere`. Cross-confirmed on two objects on 1.1.9 and one object on a completely different
device/app (1.1.10) - the blind prediction against 1.1.10 is the strongest evidence yet that this
is a mask-level standard structure, not an app-specific quirk. Full details, tables, and evidence
tags: reference doc's §10.1 (rewritten) and §10.2 (broadened).

**Still genuinely open**: bits 2 and 5 (always observed as `0` - reserved/unused, not confirmed);
Priority's `System` value (inferred by pattern, no object available to test it directly); whether
the structure holds on a non-System-B mask family (untested, as with everything else in this
project).

## Part 8: closing out the byte - bit 2 (GA-link correlation) and a blind multi-change test

Immediately after Part 7's cross-app confirmation, user asked the practical follow-on question:
"what is left with Object 3 that prevents us writing it?" Answer at the time included two real
unmapped bits (2 and 5 - though 5 was already Read-On-Init from day one, just not re-verified
with the newer blind-prediction rigor) and the untested question of whether disabling
Communication on an object shifts other objects' offsets.

**A useful accident**: sanity-checking the offset formula against object 5 (a real, already-
linked communication object, picked by the user specifically to test a different DPT/size - 8
bytes, `DPST-19-1`) before running any new capture turned up a live discrepancy: the predicted
manufacturer-default byte (`0x4B`) didn't match the real captured value (`0x4F`) - a difference of
exactly bit 2, one of the two bits previously marked unmapped. Checking the live project data
showed object 5 has a real GA link, while every other object tested until then (6, 7, 96) did not
- a real, testable hypothesis that bit 2 tracks link presence, not a coincidence.

**Test 1** (user requested, blind): toggled Read-On-Init on object 5, asked me to determine what
changed from the capture alone. Offset 10 (`2×5`) went `0x4F`→`0x6F`, XOR `0x20` = bit 5 - Read-
On-Init, independently reconfirmed on a third object with a different DPT/size, exactly as
predicted before being told the answer.

**Test 2** (user requested, blind, explicitly to test whether the methodology handles multiple
simultaneous changes): user reverted object 5's Read-On-Init AND removed communication object 8's
only GA link, in the same download, without saying so in advance. Correctly decoded both from the
capture alone: offset 10 reverted to `0x4F` (Read-On-Init back off); offset 16 (`2×8`) went
`0x4F`→`0x4B` (bit 2 cleared) - and, decisively, the GA table shrank from 6 to 4 bytes and the
Association table from 10 to 6 bytes, both losing exactly the entry for object 8's link, in the
same download. Two unrelated changes on two different objects, both correctly isolated with zero
cross-contamination.

**Scope, per explicit user instruction**: bit 2 is documented as a real, reproduced *correlation*
with GA-link presence - confirmed both directions (present→absent via a real removal, and
consistently present/absent across three other objects) - but explicitly NOT asserted to be
*only* that. Every test so far varied exactly one thing (link existing or not); a distinguishing
factor that happens to ride along with link presence in every case tested (link count, which
specific GA, object direction/DPT, or an ETS-internal derived value) has not been ruled out. See
reference doc §10.1 for the exact wording used there, worth keeping consistent if this is cited
elsewhere.

**Result**: every bit in the byte now has an observed role - `7=Update, 6=Transmit,
5=Read-On-Init, 4=Write, 3=Read, 2=GA-link (correlational), 1:0=Priority`. Combined with the
Communication-flag negative result (Part 7), this is now a complete, evidenced picture of the
byte, with one item (bit 2's exact mechanism) explicitly flagged as narrower than it might look.

## Still open, after Part 6's redo

- ~~1.1.10's Full Download 2-of-4 Object 3 pattern needs a systematic, controlled redo~~ -
  **RESOLVED, see Part 6 above and reference doc §10.3**: reproduced and explained by a
  property-27 checksum read that comes back anomalous only after an out-of-band write.
- **Why Object 3 is written on *every* 1.1.9 Full Download tested, unconditionally, remains
  genuinely unreconciled** with 1.1.10's now-resolved conditional behavior - 1.1.9's app doesn't
  even declare property 27 (reference doc's Part 7), so the exact same checksum mechanism can't
  directly apply. Real next step: an out-of-band tamper test on 1.1.9 checking for a different
  anomalous-read signal, and hunting for any genuinely untampered 1.1.9 session that skips
  Object 3 (none found yet, in 5 real captures).
- ~~The general Object 3 record layout~~ - **RESOLVED, see Parts 7-8 above**: a complete,
  computable formula (`offset = 2 × com-object number`) and a full bit map, cross-confirmed on
  three objects and two devices/apps. Still open within this: bit 2's exact mechanism (confirmed
  correlation with GA-link presence, not proven to be *only* that - Part 8); Priority's `System`
  value (inferred by pattern only); whether disabling Communication on one object shifts other
  objects' offsets (untested - every test so far only checked the changed object's own bytes).
- Whether the checksum-trigger mechanism (Part 6, reference doc Part 8) generalizes beyond
  1.1.10's app.
- Whether the partial-download GA/Association-table skip logic (Part 11) generalizes beyond this
  one device/app - it's a best-effort extrapolation of the parameter-object pattern, now proven
  correct for 1.1.9 specifically, not proven to generalize.
- Everything else already listed in the reference doc's Part 5.
