/**
 * Tests for computeGroupObjectByte()/buildGroupObjectTable() (server/routes/knx-tables.ts) -
 * Object 3's per-communication-object flag byte, decoded via a systematic real-hardware
 * bit-mapping session (2026-08-29, System B mask family only). See
 * docs/knx-device-write-protocol.md §10.1 for the full evidence trail.
 *
 * Every case below is a real byte captured on the wire during that investigation (device 1.1.9,
 * except where noted) - this is a golden-image validation against real hardware, not synthetic
 * data, following the same pattern as tests/relmem-real-device-fixtures.test.ts and
 * tests/ga-assoc-table-write.test.ts elsewhere in this project. One case (marked explicitly) is
 * NOT independently verified against a real capture - see its own comment.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeGroupObjectByte,
  buildGroupObjectTable,
} from '../server/routes/knx-tables.ts';
import type { GroupObjectFlags } from '../server/routes/knx-tables.ts';

// Manufacturer defaults for the real communication objects used throughout the investigation
// (M-0004_A-0025-10-1BA6-O00A6, 1.1.9's app - confirmed against the real app XML).
const DEF_OBJ67: Omit<GroupObjectFlags, 'object_number' | 'linked'> = {
  update: false,
  transmit: true,
  readOnInit: false,
  write: true,
  read: false,
  communication: true,
  priority: 'low',
};
// Object 5's real defaults differ (Read=Enabled, Write=Disabled - opposite of 6/7).
const DEF_OBJ5: Omit<GroupObjectFlags, 'object_number' | 'linked'> = {
  update: false,
  transmit: true,
  readOnInit: false,
  write: false,
  read: true,
  communication: true,
  priority: 'low',
};

describe('computeGroupObjectByte() - real captured bytes, device 1.1.9 unless noted', () => {
  // ── Object 7 (offset 14), never linked to a GA throughout the investigation ──
  it('object 7: manufacturer default -> 0x53', () => {
    assert.equal(
      computeGroupObjectByte({ object_number: 7, ...DEF_OBJ67, linked: false }),
      0x53,
    );
  });
  it('object 7: Update=on -> 0xD3', () => {
    assert.equal(
      computeGroupObjectByte({ object_number: 7, ...DEF_OBJ67, linked: false, update: true }),
      0xd3,
    );
  });
  it('object 7: Update=off, Read=on -> 0x5B', () => {
    assert.equal(
      computeGroupObjectByte({ object_number: 7, ...DEF_OBJ67, linked: false, read: true }),
      0x5b,
    );
  });
  it('object 7: +Write=off (Read still on) -> 0x4B', () => {
    assert.equal(
      computeGroupObjectByte({
        object_number: 7,
        ...DEF_OBJ67,
        linked: false,
        read: true,
        write: false,
      }),
      0x4b,
    );
  });
  it('object 7: +Transmit=off -> 0x0B', () => {
    assert.equal(
      computeGroupObjectByte({
        object_number: 7,
        ...DEF_OBJ67,
        linked: false,
        read: true,
        write: false,
        transmit: false,
      }),
      0x0b,
    );
  });
  it('object 7: Communication=off while unlinked -> no change (0x0B) - the confound that caused the original wrong "Communication has zero representation" claim', () => {
    assert.equal(
      computeGroupObjectByte({
        object_number: 7,
        ...DEF_OBJ67,
        linked: false,
        read: true,
        write: false,
        transmit: false,
        communication: false,
      }),
      0x0b,
    );
  });
  it('object 7: Priority=Alarm -> 0x0A', () => {
    assert.equal(
      computeGroupObjectByte({
        object_number: 7,
        ...DEF_OBJ67,
        linked: false,
        read: true,
        write: false,
        transmit: false,
        priority: 'alarm',
      }),
      0x0a,
    );
  });
  it('object 7: Priority=High -> 0x09', () => {
    assert.equal(
      computeGroupObjectByte({
        object_number: 7,
        ...DEF_OBJ67,
        linked: false,
        read: true,
        write: false,
        transmit: false,
        priority: 'high',
      }),
      0x09,
    );
  });

  // ── Object 6 (offset 12), never linked to a GA throughout the investigation ──
  it('object 6: manufacturer default -> 0x53', () => {
    assert.equal(
      computeGroupObjectByte({ object_number: 6, ...DEF_OBJ67, linked: false }),
      0x53,
    );
  });
  it('object 6: Read-On-Init=on -> 0x73', () => {
    assert.equal(
      computeGroupObjectByte({
        object_number: 6,
        ...DEF_OBJ67,
        linked: false,
        readOnInit: true,
      }),
      0x73,
    );
  });
  it('object 6: Update=on (Read-On-Init reverted) -> 0xD3', () => {
    assert.equal(
      computeGroupObjectByte({ object_number: 6, ...DEF_OBJ67, linked: false, update: true }),
      0xd3,
    );
  });
  it('object 6: Update=on + Read=on (additive, predicted before capture) -> 0xDB', () => {
    assert.equal(
      computeGroupObjectByte({
        object_number: 6,
        ...DEF_OBJ67,
        linked: false,
        update: true,
        read: true,
      }),
      0xdb,
    );
  });

  // ── Object 5 (offset 10), linked throughout (1 or 2 GAs) - different DPT/size (8-byte
  // DPST-19-1 date/time) than every other object tested, and the object used to isolate bit 2's
  // real Communication-AND-linked meaning. ──
  it('object 5: manufacturer default, linked -> 0x4F', () => {
    assert.equal(computeGroupObjectByte({ object_number: 5, ...DEF_OBJ5, linked: true }), 0x4f);
  });
  it('object 5: Read-On-Init=on -> 0x6F', () => {
    assert.equal(
      computeGroupObjectByte({ object_number: 5, ...DEF_OBJ5, linked: true, readOnInit: true }),
      0x6f,
    );
  });
  it('object 5: Communication=off, GA link left untouched -> 0x4B (the decisive correction test)', () => {
    assert.equal(
      computeGroupObjectByte({
        object_number: 5,
        ...DEF_OBJ5,
        linked: true,
        communication: false,
      }),
      0x4b,
    );
  });
  it('object 5: Communication back on, 2 GA links -> 0x4F, identical to the 1-link case (link count doesn\'t matter)', () => {
    assert.equal(computeGroupObjectByte({ object_number: 5, ...DEF_OBJ5, linked: true }), 0x4f);
  });
  it('object 5: swapping which of 2 links sends -> no change (0x4F) - direction lives in the Association table, not here', () => {
    assert.equal(computeGroupObjectByte({ object_number: 5, ...DEF_OBJ5, linked: true }), 0x4f);
  });

  // ── Object 8 (offset 16) ──
  it('object 8: default, linked -> 0x4F', () => {
    assert.equal(computeGroupObjectByte({ object_number: 8, ...DEF_OBJ5, linked: true }), 0x4f);
  });
  it('object 8: GA link removed -> 0x4B', () => {
    assert.equal(computeGroupObjectByte({ object_number: 8, ...DEF_OBJ5, linked: false }), 0x4b);
  });

  // ── Object 96, device 1.1.10 (M-0004_A-3030-23-F0EA-O000A) - a completely different
  // manufacturer app, the blind cross-device confirmation test. ──
  it('object 96 (1.1.10): manufacturer default, computed - NOT independently verified against a real capture (only the post-change byte below was actually observed on the wire; this one is back-computed from the same app XML the test itself used, so it is internally consistent, not an independent cross-check)', () => {
    assert.equal(
      computeGroupObjectByte({
        object_number: 96,
        update: true,
        transmit: true,
        readOnInit: false,
        write: false,
        read: true,
        communication: true,
        linked: false,
        priority: 'low',
      }),
      0xcb,
    );
  });
  it('object 96 (1.1.10): Write=on - the real blind test (computed here without knowing the answer, then checked against the capture, which showed 0xDB)', () => {
    assert.equal(
      computeGroupObjectByte({
        object_number: 96,
        update: true,
        transmit: true,
        readOnInit: false,
        write: true,
        read: true,
        communication: true,
        linked: false,
        priority: 'low',
      }),
      0xdb,
    );
  });
});

describe('buildGroupObjectTable() - full-buffer placement, real device sizes', () => {
  it('places each communication object at 2×object_number, leaves everything else zero (1.1.9\'s real 98-byte size)', () => {
    const buf = buildGroupObjectTable(98, [
      { object_number: 6, ...DEF_OBJ67, linked: false },
      { object_number: 7, ...DEF_OBJ67, linked: false },
    ]);
    assert.equal(buf.length, 98);
    assert.equal(buf[12], 0x53); // object 6
    assert.equal(buf[14], 0x53); // object 7
    // Everything else stays zero - matches every real device's own mostly-empty Object 3.
    const rest = Buffer.from(buf);
    rest[12] = 0;
    rest[14] = 0;
    assert.ok(rest.every((b) => b === 0), 'every byte outside the two placed objects should be 0');
  });

  it('reproduces the real 4-object layout observed on the wire (objects 5/6/7/8, 1.1.9)', () => {
    const buf = buildGroupObjectTable(98, [
      { object_number: 5, ...DEF_OBJ5, linked: true },
      { object_number: 6, ...DEF_OBJ67, linked: false },
      { object_number: 7, ...DEF_OBJ67, linked: false },
      { object_number: 8, ...DEF_OBJ5, linked: true },
    ]);
    assert.equal(buf[10], 0x4f); // object 5
    assert.equal(buf[12], 0x53); // object 6
    assert.equal(buf[14], 0x53); // object 7
    assert.equal(buf[16], 0x4f); // object 8
  });

  it('silently skips (leaves at zero) any object number that would fall outside the real buffer size, rather than throwing', () => {
    const buf = buildGroupObjectTable(10, [{ object_number: 96, ...DEF_OBJ5, linked: true }]);
    assert.equal(buf.length, 10);
    assert.ok(buf.every((b) => b === 0));
  });
});
