# Investigation: does a real ETS Full Download depend on device history, and what's actually in the "1984-byte gap"?

**See also**: `docs/knx-device-write-protocol.md` Part 8 — the distilled protocol facts this investigation
settled. This log is the full narrative (dead ends, corrected mistakes, exact order of discovery).

**Status: RESOLVED**, two separate questions, both closed with real-hardware evidence against 1.1.10:

1. Does ETS's Full Download depend on remembered history (its own or the device's), such that a
   device carrying stale content from elsewhere could silently keep it forever? **No** - confirmed
   empirically: ETS detects an out-of-band change and falls back to a comprehensive, near-total
   segment rewrite, not a naive skip.
2. What is the "1984-byte gap" between koolenex's computed parameter image and the real device
   (flagged as unexplained in `relmem-real-device-fixtures.test.ts` and `koolenex_reference` memory)?
   **Not device-internal/opaque state** (an earlier, wrong guess from this same investigation) -
   99.2% of it is a concrete, fixable bug: 24 manufacturer-declared "curve type" parameters (4
   channels x 6 conditional alternates) whose real default is a 512-byte binary blob, mis-declared
   by koolenex's parser as 1 byte each.

## Why this came up

Closing out the property-27/`WriteRelMem` work (see `2026-08-29-property27-ga-write-wiring-and-ui.md`),
the user raised a sharp objection to the "ETS only writes what differs from the manufacturer's
static default" theory: reuse a device across two different projects (or a factory reset in
between) and a value that happens to already match the *new* project's default would never get
corrected, even if it's genuinely stale. Rather than debate this from file data alone, the user
proposed a decisive real-hardware test.

## The test (methodology)

Reused `UP-1554`/`UP-1555` at offset 172 (the same conditionally-active parameter pair from the
earlier `WriteRelMem`/property-27 investigation) - safe (no physical side effects previously
observed at that offset alone) and already well-understood.

1. Confirm baseline via direct device read (`POST /bus/read-memory`), not just the file's assumed
   default.
2. Set the project's "Indicating status temporarily" checkbox to non-default (`true`), real Full
   Download, confirm the write via capture + direct read.
3. Set it back to default (`false`), real Full Download, confirm ETS writes it back (it did - real,
   positive evidence for the file-derived-target theory, on its own).
4. **The actual test**: inject a value ETS has *never itself written* directly into device memory
   (bypassing ETS entirely, via koolenex's own `POST /bus/write-memory` debug route), leave the
   project unchanged (still at default), and do another real Full Download. If ETS detects and
   corrects it, that's real evidence against a naive "diff against own memory" mechanism. If it
   silently leaves the device stuck, that's the user's scenario confirmed as a real gap.

## Two self-caught mistakes before the real result (documented deliberately - see below)

**Mistake 1 - wrong address, twice.** The first two "confirmation reads" after each real ETS write
both came back `0x00` instead of the expected written value, which looked like a real "write
succeeds on the wire but silently doesn't persist" bug (a known failure class in this project -
six such bugs were found and fixed earlier). Chased it through several dead ends (stale
connection, wrong memory service, a suspected read-path bug for short reads, even briefly worried
the debug write had wiped the whole segment) before finding the real, embarrassing cause: a
manual hex-to-decimal conversion error, reading `0x0C38AC` (an unrelated address, coincidentally
also `0x00`) instead of the intended `0x0C30AC`. Re-verified with the correct address and both
"failures" evaporated immediately. **Lesson, explicitly requested by the user afterward**: a single
data point (one read matching a hypothesis) is not proof; the actual finding was that both
"confirmations" were internally consistent with each other by coincidence, not independently
verified against ground truth.

**Mistake 2 - narrow search missed a real write.** After the koolenex-injected value, the next real
Full Download's write pattern was searched for using an exact-address string match
(`grep "0C30AC"`), found nothing, and was reported as "ETS did not detect/correct the injected
value" - the opposite of the true result. The device readback (correctly showing the value *had*
changed) immediately contradicted that conclusion, prompting a broader search: ETS had written a
wider, multi-byte range (`MemExtWrite N=5 X=$0C30A8`) that included the target byte but wasn't
found by an exact-address search. Corrected finding: **ETS did detect and correct the out-of-band
value.**

## Finding 1: ETS falls back to a comprehensive rewrite when device state looks unexpected

Once the search was corrected, the real Full Download after the koolenex-injected byte wrote far
more than the single targeted byte: a contiguous run of writes from offset ~12 through ~1650 of
the 10433-byte parameter segment, a completely separate block covering objIdx3's region
(`0x0C2000` onward - the still-unidentified 98-byte object), the offset-10432 marker byte, and
both the GA and Association tables - essentially the whole segment, not a delta.

Hypothesis at the time: the koolenex debug write's `relSegment` declaration was *incomplete*
(only `mode:'full'`, missing the `mode:'par'` variant real ETS always declares alongside it) -
maybe that left the device's load-state bookkeeping in a shape ETS detected as inconsistent.

**Tested directly**: repeated the same injection, this time with the debug route's `combined:true`
option (declaring both `full` and `par` RelSegment steps, matching the real app's own declared
shape exactly). The next real Full Download did the **same comprehensive rewrite again** -
identical write pattern (`N=151 X=$0C300C`, `N=5 X=$0C30A8`, etc.). This disproves the
"incomplete RelSegment" hypothesis: it isn't about protocol correctness of the intervening write.
The simpler, still-unconfirmed-in-detail explanation left standing: **any** write to the device
from something other than ETS's own last session appears to trigger the comprehensive fallback,
regardless of that write's own correctness. The exact detection mechanism remains unknown (no
live memory read occurs in any capture, ruling out the obvious explanation) - flagged as still
open, not resolved.

**Also checked, and this matters**: the comprehensive rewrite's content was verified byte-for-byte
against real, previously-captured device values at several offsets (e.g. offset 3105's real value
of `2` was written back as `2`, not reset to a static default) - it's a *correct*, informed
rewrite, not a blind wipe to factory defaults. This directly motivated Finding 2.

## Finding 2: the "1984-byte gap" is a parser bug, not device-internal state

A byte-for-byte match between the comprehensive rewrite's content and known real device values
prompted re-examining the standing (and, per user pushback, insufficiently justified) theory that
this region held device-internal operational/calibration state ETS never touches. The user
specifically pushed back on a follow-on guess ("maybe ETS computes a dimming curve dynamically")
as needlessly complex, and asked for simpler explanations to be checked first.

**Checked directly**: `paramMemLayout` (koolenex's own extracted parameter data) *does* declare
parameters at these exact offsets - labeled "Characteristic curve value domain" - but declares
each as 1 byte (`bitSize: 8`) while their real `defaultValue` is a base64-encoded blob that
decodes to **512 bytes**. These are ordinary manufacturer-declared parameters (a set of 6
conditional alternates per channel, presumably a "curve type" selector picks one), not anything
ETS computes - `buildParamMem()` simply has no code path to apply a multi-hundred-byte blob
default, only scalar/text/float values, so this whole region silently fell through to the
segment's fill/default.

**Verified at project scale, not just the one example**: swept every `paramMemLayout` entry for a
base64-looking `defaultValue` decoding to more bytes than its declared `bitSize` implies. Found
**24 such entries**, in 4 groups of 6, at offsets 532 bytes apart (3103, 3635, 4167, 4699) -
matching the device's 4 dimming channels exactly. Cross-checked against the real 1984-byte diff
list: **1968 of 1984 diffs (99.2%) fall inside these four 512-byte blob ranges.**

**The remaining 16 bytes** (4 bytes, at a consistent relative offset right after each 512-byte
blob, in all 4 channels) are a genuinely separate, smaller gap: no `paramMemLayout` entry covers
them at all. Their real device value is an identical, fixed constant in every channel (`0F EF 0F
FF`) - deterministic, not project-configurable, but not yet traced to a declared parameter
either. Left open as a minor, low-stakes follow-up (0.15% of the segment).

## What's still genuinely open

- The exact mechanism by which ETS detects "this device's state doesn't match what I expect" and
  triggers the comprehensive rewrite - confirmed to exist and to be triggered by *any* intervening
  non-ETS write (tested with both an incomplete and a complete RelSegment declaration), but the
  underlying signal is unknown. No live memory read occurs in any capture, so it isn't a
  read-then-diff mechanism at the byte level.
- The 16-byte fixed-constant gap after each curve blob - real, small, not yet traced to a
  declared parameter.
- Which of each channel's 6 curve-type alternates is genuinely "active" for a given project
  configuration - not yet determined (needs the same conditional-activation logic already used
  for the offset-172 case, applied here and verified against real capture content).
- Object 3's identity (`0x0C2000` region) - written in the comprehensive rewrite, still
  unidentified, unrelated to this investigation's scope.

## Sources

- `docs/data/captures/2026-08-28-ets-full-download-history-and-blob-params-1.1.10.pcapng`
  (knx-ets-manager repo) - the full real-hardware session: baseline reads, the two ETS-driven
  writes (flag true/false), the two koolenex-injected out-of-band writes (incomplete then complete
  RelSegment), and both subsequent real ETS Full Downloads (the first showing the comprehensive
  rewrite, the second confirming it wasn't a one-off).
- `tests/fixtures/relmem-real-devices/1.1.10-actual.hex` /
  `1.1.10-expected-computed.hex` - source for the blob-range/diff-offset cross-check.
- `data/apps/M-0004_A-3030-23-F0EA-O000A.json` - source for the 24 blob-typed `paramMemLayout`
  entries and their real decoded lengths.
