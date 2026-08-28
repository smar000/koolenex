/**
 * Protocol-level test for the WRITE side of the 16-bit address truncation
 * fix (see fix/16bit-address-truncation, knx-connection.ts's WriteRelMem
 * case). memory-read.test.ts's FakeMemoryDevice thoroughly covers the READ
 * side, including addresses above 0xFFFF - but has no write handling at
 * all, and the write side of this specific fix has never had independent
 * verification (see koolenex-reference memory, 2026-08-26/28: the earlier
 * "actual-vs-actual, byte-identical" proof predates the fix and used the
 * same then-buggy read path on both sides, so it never actually confirmed
 * the WRITE reached the right address - and nothing since has substituted
 * for that).
 *
 * This is a "virtual test device": a protocol-level fake device (subclasses
 * KnxConnection, intercepts sendCEMI, replies with real CEMI-encoded
 * responses) seeded with a REAL captured memory map from an actual ETS
 * download - tests/fixtures/relmem-real-devices/1.1.10-expected-computed.hex
 * (koolenex's own computed image, used as the "to-write" payload) cross-
 * checked against full-download-1.1.10-writes.json (the real offsets/bytes
 * ETS itself wrote during a genuine Full Download). Runs the actual,
 * unmodified downloadDevice()/WriteRelMem code path - not a re-implementation
 * of it - against this fake device, then inspects the fake device's own
 * backing buffer afterward to prove where bytes actually landed. Zero
 * hardware risk, fully deterministic, no bus/testbed/Hampden-Way needed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { parseCEMI } from '../server/knx-cemi.ts';
import { KnxConnection } from '../server/knx-connection.ts';
import type { DownloadStep } from '../server/knx-connection.ts';

const FIX = path.join(import.meta.dirname, 'fixtures', 'relmem-real-devices');

function loadHex(name: string): Buffer {
  return Buffer.from(fs.readFileSync(path.join(FIX, name), 'utf8').trim(), 'hex');
}

function loadJson(name: string): any {
  return JSON.parse(fs.readFileSync(path.join(FIX, name), 'utf8'));
}

/**
 * Like memory-read.test.ts's FakeMemoryDevice, but also answers
 * Memory_Write and MemoryExtended_Write by applying the write directly to
 * its own backing buffer - so the buffer's state after a downloadDevice()
 * call reflects exactly what koolenex's real write path actually did,
 * address selection included.
 */
class FakeWritableMemoryDevice extends KnxConnection {
  sent: Buffer[] = [];
  memory: Buffer;
  private readonly deviceAddr: string;
  constructor(deviceAddr: string, memory: Buffer) {
    super();
    this.deviceAddr = deviceAddr;
    this.memory = memory;
    this.connected = true;
    this.localAddr = '1.0.1';
  }

  sendCEMI(cemi: Buffer): Promise<void> {
    this.sent.push(cemi);
    const frame = parseCEMI(cemi);
    if (!frame) return Promise.resolve();

    if (frame.apciName === 'Memory_Write') {
      // extraBuf layout from apduConnected: [count(1)][addrHi][addrLo][data...]
      const count = frame.apduData[0]!;
      const address = (frame.apduData[1]! << 8) | frame.apduData[2]!;
      const data = frame.apduData.subarray(3, 3 + count);
      data.copy(this.memory, address);
      // downloadDevice()'s WriteRelMem loop doesn't wait for a response
      // (fire-and-forget, see the comment there) - no reply needed for the
      // write to "land", matching the real fire-and-forget behavior. Still
      // exercised via `sent` below for anyone who wants to inspect frames.
    } else if (frame.apciName === 'MemoryExtended_Write') {
      // extraBuf layout from apduMemoryExtendedWrite: [count(1)][addr(3,BE)][data...]
      const count = frame.apduData[0]!;
      const address =
        (frame.apduData[1]! << 16) |
        (frame.apduData[2]! << 8) |
        frame.apduData[3]!;
      const data = frame.apduData.subarray(4, 4 + count);
      data.copy(this.memory, address);
    }
    return Promise.resolve();
  }

  disconnect(): void {
    this.connected = false;
  }

  /** Every Memory_Write/MemoryExtended_Write frame actually sent, decoded. */
  writesSent(): Array<{ extended: boolean; address: number; count: number }> {
    return this.sent
      .map((c) => parseCEMI(c))
      .filter(
        (f): f is NonNullable<typeof f> =>
          !!f &&
          (f.apciName === 'Memory_Write' || f.apciName === 'MemoryExtended_Write'),
      )
      .map((f) => {
        if (f.apciName === 'MemoryExtended_Write') {
          return {
            extended: true,
            address:
              (f.apduData[1]! << 16) | (f.apduData[2]! << 8) | f.apduData[3]!,
            count: f.apduData[0]!,
          };
        }
        return {
          extended: false,
          address: (f.apduData[1]! << 8) | f.apduData[2]!,
          count: f.apduData[0]!,
        };
      });
  }
}

describe('WriteRelMem protocol-level test — 1.1.10 (real captured memory, base > 0xFFFF)', () => {
  const RESOLVED_BASE = 0xc3000; // real PID-7-resolved base for this device/app
  const writes = loadJson('full-download-1.1.10-writes.json');
  const expected = loadHex('1.1.10-expected-computed.hex'); // koolenex's own computed image - the payload under test

  // Real downloadDevice()'s WriteRelMem loop has a genuine 30ms delay per
  // 10-byte chunk (matches real bus pacing) - replaying the entire real
  // 10433-byte segment would take ~30s per test. The address-selection
  // logic under test (`addr > 0xffff`) only cares about each chunk's
  // resolved address, not segment size, so a short real-data slice proves
  // the same thing in a fraction of the time. Two windows: a near-start
  // slice (covers the real named-parameter offsets at 69/172-199) and the
  // single real byte at the very end of the segment (offset 10432) - both
  // via separate downloadDevice() calls, since a shared `paramMem` is
  // always sliced from ITS OWN offset 0 regardless of the step's target
  // `offset` (see knx-connection.ts's WriteRelMem case).
  const NEAR_START = expected.subarray(0, 200);
  const TAIL_BYTE = expected.subarray(10432, 10433);

  it('writes every chunk via MemoryExtended_Write (never legacy Memory_Write), since the base alone exceeds 0xFFFF', async () => {
    const backing = Buffer.alloc(0x100000); // room for the real base + segment
    const dev = new FakeWritableMemoryDevice('1.1.10', backing);

    const steps: DownloadStep[] = [
      { type: 'WriteRelMem', objIdx: 4, propId: 0, size: NEAR_START.length, offset: 0 },
    ];
    await dev.downloadDevice('1.1.10', steps, null, null, NEAR_START, undefined, {
      resolvedBases: { 4: RESOLVED_BASE },
    });

    const sentWrites = dev.writesSent();
    assert.ok(sentWrites.length > 0, 'expected at least one write chunk');
    assert.ok(
      sentWrites.every((w) => w.extended),
      `every chunk should use MemoryExtended_Write (base 0x${RESOLVED_BASE.toString(16)} alone exceeds 0xFFFF) - got: ${JSON.stringify(sentWrites)}`,
    );
    // None should have silently truncated to a low address - every real
    // address must actually be >= the resolved base.
    assert.ok(
      sentWrites.every((w) => w.address >= RESOLVED_BASE),
      `every write address should be >= 0x${RESOLVED_BASE.toString(16)} - a truncated write would show up as a low address here`,
    );
  });

  it('the real named-parameter bytes land at the correct absolute address in device memory', async () => {
    const backing = Buffer.alloc(0x100000);
    const dev = new FakeWritableMemoryDevice('1.1.10', backing);

    // Pass 1: the near-start real bytes (covers offset 172, one of the two
    // real captured named-parameter writes).
    await dev.downloadDevice(
      '1.1.10',
      [{ type: 'WriteRelMem', objIdx: 4, propId: 0, size: NEAR_START.length, offset: 0 }],
      null,
      null,
      NEAR_START,
      undefined,
      { resolvedBases: { 4: RESOLVED_BASE } },
    );
    // Pass 2: the single real byte at the very end of the segment (offset
    // 10432, the other real captured named-parameter write) - a fresh
    // paramMem containing just that one real byte, targeted via `offset`.
    await dev.downloadDevice(
      '1.1.10',
      [{ type: 'WriteRelMem', objIdx: 4, propId: 0, size: 1, offset: 10432 }],
      null,
      null,
      TAIL_BYTE,
      undefined,
      { resolvedBases: { 4: RESOLVED_BASE } },
    );

    // Cross-check against the REAL write-ops fixture (what ETS itself wrote,
    // captured via tshark) - not just against koolenex's own computed image,
    // so this proves koolenex's write lands the SAME real values at the SAME
    // real addresses ETS did, not just "wrote something at the right offset".
    for (const w of writes.paramWrites) {
      const absAddr = RESOLVED_BASE + w.offsetFromBase;
      const got = dev.memory
        .subarray(absAddr, absAddr + w.byteCount)
        .toString('hex');
      assert.equal(
        got.toLowerCase(),
        w.hex.toLowerCase(),
        `offset ${w.offsetFromBase} (absolute 0x${absAddr.toString(16)}): fake device has ${got}, real ETS capture said ${w.hex}`,
      );
    }
  });

  it('a chunk straddling the 0xFFFF boundary would still resolve correctly (sanity on chunk math)', async () => {
    // Not this device's real case (its base alone is already > 0xFFFF, so
    // every chunk is extended) - included for completeness, mirroring
    // memory-read.test.ts's equivalent read-side boundary test, using a
    // synthetic low base instead of real captured data (no real fixture
    // straddles the boundary since real relmem bases are either always
    // low or always high per device).
    const backing = Buffer.alloc(0x10100);
    const dev = new FakeWritableMemoryDevice('1.1.10', backing);
    const payload = Buffer.alloc(16, 0xaa);

    const steps: DownloadStep[] = [
      { type: 'WriteRelMem', objIdx: 4, propId: 0, size: payload.length, offset: 0 },
    ];
    // Base chosen so the write region straddles 0xFFFF with MEM_CHUNK=10:
    // downloadDevice()'s WriteRelMem loop chunks at 10 bytes; base 0xFFF8 +
    // off 0 = 0xFFF8 (fits), base 0xFFF8 + off 10 = 0x10002 (doesn't).
    await dev.downloadDevice('1.1.10', steps, null, null, payload, undefined, {
      resolvedBases: { 4: 0xfff8 },
    });

    const sentWrites = dev.writesSent();
    assert.equal(sentWrites.length, 2, 'expected 2 chunks for a 16-byte write at MEM_CHUNK=10');
    assert.equal(sentWrites[0]!.extended, false, 'first chunk (0xFFF8) fits in 16 bits');
    assert.equal(sentWrites[1]!.extended, true, 'second chunk (0x10002) does not');
    assert.deepEqual(
      [...dev.memory.subarray(0xfff8, 0xfff8 + 16)],
      [...payload],
    );
  });
});
