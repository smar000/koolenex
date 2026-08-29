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

## Still open, for the next session

- The Object 3 write-trigger question, still open - see the table above and the honest
  "wrong device tested" conclusion. Next test should target 1.1.10.
- Whether the partial-download GA/Association-table skip logic generalizes beyond this one
  device/app - it's a best-effort extrapolation of the parameter-object pattern, now proven
  correct for 1.1.9 specifically, not proven to generalize.
- Everything else already listed in the reference doc's Part 5.
