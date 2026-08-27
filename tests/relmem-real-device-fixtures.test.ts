/**
 * Real-device relmem fixtures for 1.1.9 and 1.1.10 — full param-segment
 * memory read back from live hardware via POST /bus/verify-device
 * (2026-08-26/27), alongside koolenex's own computed "expected" image for
 * the same segment and the specific real MemExtWrite ops ETS sent during a
 * genuine Full Download (captured via tshark; addresses/bytes documented in
 * ../../knx-ets-manager/docs/2026-08-27-koolenex-relmem-write-scope-investigation.md).
 *
 * Unlike ets-capture-crosscheck.test.ts (which has a *complete* ETS
 * communication-log XML for 1.1.13 and can diff every offset), these two
 * devices only have specific named-parameter offsets confirmed via packet
 * capture, not a full write log. So this suite checks two narrower things:
 *
 *  1. Fixture self-consistency: the real on-device bytes at each captured
 *     write's offset match the captured write bytes exactly (sanity that
 *     the fixtures were saved correctly and ETS's writes actually landed).
 *  2. A regression trip-wire on the actual-vs-computed byte diff count, so
 *     a future change to the image builder gets flagged for review here
 *     even without a full capture log to diff against.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const FIX = path.join(import.meta.dirname, 'fixtures', 'relmem-real-devices');

function loadHex(name: string): Buffer {
  return Buffer.from(fs.readFileSync(path.join(FIX, name), 'utf8').trim(), 'hex');
}

function loadJson(name: string): any {
  return JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
}

function countDiffs(a: Buffer, b: Buffer): number {
  assert.equal(a.length, b.length, 'buffers must be same length to diff');
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

describe('real-device relmem fixtures — 1.1.9', () => {
  const actual = loadHex('1.1.9-actual.hex');
  const expected = loadHex('1.1.9-expected-computed.hex');
  const writes = loadJson('full-download-1.1.9-writes.json');

  it('has the documented segment size (8178 bytes)', () => {
    assert.equal(actual.length, 8178);
    assert.equal(expected.length, 8178);
  });

  it('real on-device bytes match every captured ETS write at its offset', () => {
    for (const w of writes.paramWrites) {
      const got = actual
        .subarray(w.offsetFromBase, w.offsetFromBase + w.byteCount)
        .toString('hex');
      assert.equal(
        got.toLowerCase(),
        w.hex.toLowerCase(),
        `frame ${w.frame} @ offset ${w.offsetFromBase}: device has ${got}, capture said ${w.hex}`,
      );
    }
  });

  it('actual vs computed-image diff count matches the captured verify-device result (3)', () => {
    assert.equal(countDiffs(actual, expected), 3);
  });
});

describe('real-device relmem fixtures — 1.1.10', () => {
  const actual = loadHex('1.1.10-actual.hex');
  const expected = loadHex('1.1.10-expected-computed.hex');
  const writes = loadJson('full-download-1.1.10-writes.json');

  it('has the documented segment size (10433 bytes)', () => {
    assert.equal(actual.length, 10433);
    assert.equal(expected.length, 10433);
  });

  it('real on-device bytes match every captured ETS write at its offset', () => {
    for (const w of writes.paramWrites) {
      const got = actual
        .subarray(w.offsetFromBase, w.offsetFromBase + w.byteCount)
        .toString('hex');
      assert.equal(
        got.toLowerCase(),
        w.hex.toLowerCase(),
        `frame ${w.frame} @ offset ${w.offsetFromBase}: device has ${got}, capture said ${w.hex}`,
      );
    }
  });

  it('actual vs computed-image diff count matches the captured verify-device result (1984)', () => {
    // Large diff count is expected here (unlike 1.1.9): most of it is the
    // gap region outside named parameters, where koolenex's blind 0xFF/0x00
    // fill differs from the device's real (ETS-unknown-to-us) contents.
    // This is a trip-wire, not a correctness assertion about the gap bytes.
    assert.equal(countDiffs(actual, expected), 1984);
  });
});

describe('real-device fixture — 1.1.0 (KNX IP router, system/prop device)', () => {
  it('is a prop-family device, not a relmem segment (different verify shape)', () => {
    const d = loadJson('1.1.0-prop-verify.json');
    assert.equal(d.family, 'prop');
    assert.equal(d.segments.length, 0);
    assert.ok(Array.isArray(d.props) && d.props.length > 0);
  });
});
