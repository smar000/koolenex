/**
 * Protocol-level tests for DownloadExtra.mode='partial' (knx-connection.ts's
 * downloadDevice()), added 2026-08-29 alongside a real-hardware round-trip
 * test: ETS wrote a GA change (Full Download), koolenex reverted it via a
 * NEW 'partial' mode - the first partial-download capability this project
 * has ever had (previously every downloadDevice() call always did a full
 * rewrite, unconditionally, regardless of what mode was requested). See
 * koolenex-reference memory and docs/data/captures/README.md in the
 * knx-ets-manager repo for the real capture backing this.
 *
 * This is a protocol-level "virtual device" test (subclasses KnxConnection,
 * intercepts sendCEMI, answers both reads AND writes against its own backing
 * buffer) - proves the SKIP-IF-UNCHANGED and mode-byte logic deterministically,
 * without needing real hardware for every run. The real-hardware round trip
 * (see the capture above) is what proves the same logic actually works on a
 * real device; this file is the fast, repeatable regression guard for it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseCEMI, buildCEMI, apduConnectedFull, apduGroup, APCI_EXT, TPCI } from '../server/knx-cemi.ts';
import { KnxConnection } from '../server/knx-connection.ts';
import type { DownloadStep } from '../server/knx-connection.ts';

/**
 * Answers DeviceDescriptor_Read (System B, 0x07B0 - matches 1.1.9/1.1.10,
 * the only real devices this project has tested), Authorize_Request,
 * PropertyValue_Write (LSM/load-state transitions - always accepted, no
 * real state machine simulated), Memory_Read/MemoryExtended_Read (answers
 * from its own backing buffer - this is what makes the partial-mode
 * skip-if-unchanged check exercisable), and Memory_Write/MemoryExtended_Write
 * (applies to its own backing buffer, so the buffer's state after a
 * downloadDevice() call reflects exactly what was actually written).
 */
class FakeRWMemoryDevice extends KnxConnection {
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

  private reply(respApdu: Buffer): void {
    const resp = parseCEMI(buildCEMI(this.deviceAddr, this.localAddr, respApdu, false))!;
    setImmediate(() => this._onCEMI(resp));
  }

  sendCEMI(cemi: Buffer): Promise<void> {
    this.sent.push(cemi);
    const frame = parseCEMI(cemi);
    if (!frame) return Promise.resolve();

    if (frame.apciName === 'DeviceDescriptor_Read') {
      const maskBuf = Buffer.from([0x07, 0xb0]);
      this.reply(apduGroup('DeviceDescriptor_Response', 0, maskBuf));
      return Promise.resolve();
    }

    const fullApci =
      frame.apdu.length >= 2 ? ((frame.apdu[0]! & 0x03) << 8) | frame.apdu[1]! : -1;
    if (fullApci === 0x3d1 /* Authorize_Request */) {
      this.reply(apduConnectedFull(0, APCI_EXT.Authorize_Response, Buffer.from([0x00])));
      return Promise.resolve();
    }
    // PropertyValue_Write (0x3D7): downloadDevice() waits for an 'OTHER'
    // response (see propWrite/lsmWrite) - any non-error reply unblocks it.
    // 0x3D7 low byte pattern mirrors apduPropertyValueWrite's own encoding.
    if (fullApci === 0x3d7) {
      // Echo back a minimal PropertyValue_Response-shaped OTHER frame -
      // downloadDevice() only awaits *a* response, doesn't decode this one.
      const word = (TPCI.DATA_CONNECTED << 10) | 0x3d5;
      this.reply(Buffer.from([(word >> 8) & 0xff, word & 0xff, 0, 0, 0]));
      return Promise.resolve();
    }

    if (frame.apciName === 'Memory_Read') {
      const count = frame.apdu[1]! & 0x3f;
      const address = (frame.apduData[0]! << 8) | frame.apduData[1]!;
      const data = this.memory.subarray(address, address + count);
      const word = (TPCI.DATA_CONNECTED << 10) | (9 /* Memory_Response */ << 6) | count;
      this.reply(
        Buffer.concat([
          Buffer.from([(word >> 8) & 0xff, word & 0xff, (address >> 8) & 0xff, address & 0xff]),
          data,
        ]),
      );
      return Promise.resolve();
    }
    if (frame.apciName === 'MemoryExtended_Read') {
      const count = frame.apduData[0]!;
      const address = (frame.apduData[1]! << 16) | (frame.apduData[2]! << 8) | frame.apduData[3]!;
      const data = this.memory.subarray(address, address + count);
      const word = ((TPCI.DATA_CONNECTED << 10) | APCI_EXT.MemoryExtended_Read_Response) & 0xffff;
      this.reply(
        Buffer.concat([
          Buffer.from([
            (word >> 8) & 0xff,
            word & 0xff,
            0x00,
            (address >> 16) & 0xff,
            (address >> 8) & 0xff,
            address & 0xff,
          ]),
          data,
        ]),
      );
      return Promise.resolve();
    }
    if (frame.apciName === 'Memory_Write') {
      const count = frame.apduData[0]!;
      const address = (frame.apduData[1]! << 8) | frame.apduData[2]!;
      frame.apduData.subarray(3, 3 + count).copy(this.memory, address);
    } else if (frame.apciName === 'MemoryExtended_Write') {
      const count = frame.apduData[0]!;
      const address = (frame.apduData[1]! << 16) | (frame.apduData[2]! << 8) | frame.apduData[3]!;
      frame.apduData.subarray(4, 4 + count).copy(this.memory, address);
    }
    return Promise.resolve();
  }

  disconnect(): void {
    this.connected = false;
  }

  /** Every LoadData (PropertyValue_Write, PID_LOAD_STATE_CONTROL event=0x03) frame's decoded mode byte, in order. */
  loadDataModeBytes(): number[] {
    const out: number[] = [];
    for (const c of this.sent) {
      const f = parseCEMI(c);
      if (!f) continue;
      const fullApci = f.apdu.length >= 2 ? ((f.apdu[0]! & 0x03) << 8) | f.apdu[1]! : -1;
      if (fullApci !== 0x3d7) continue;
      // apduData layout: [objIdx][propId][count/startIdx:2][event][SCF][rsvd:2][size:2][mode][fill][rsvd:2]
      // - 4-byte meta header (apduPropertyValueWrite) + 10-byte LSM payload
      // (lsmWrite's [event] + loadDataExtra's 9-byte body, whose own mode
      // byte sits at its own index 5 -> overall index 4+1+5=10).
      const event = f.apduData[4];
      if (event === 0x03) out.push(f.apduData[10]!); // event=LOAD_DATA, mode byte
    }
    return out;
  }

  /** Every Memory_Write/MemoryExtended_Write frame sent (for asserting skip vs write). */
  writeCount(): number {
    return this.sent.filter((c) => {
      const f = parseCEMI(c);
      return f && (f.apciName === 'Memory_Write' || f.apciName === 'MemoryExtended_Write');
    }).length;
  }
}

describe("downloadDevice() mode='partial' (2026-08-29)", () => {
  const BASE = 0x5f0e; // within 16 bits, matches 1.1.9's real relmem base shape

  it('skips the object entirely when the device already matches (no Unload/StartLoading/LoadData/write at all)', async () => {
    const payload = Buffer.from('deadbeefcafef00d', 'hex');
    const backing = Buffer.alloc(0x10000);
    payload.copy(backing, BASE); // device already holds the target content
    const dev = new FakeRWMemoryDevice('1.1.9', backing);

    const relSeg: DownloadStep = {
      type: 'RelSegment',
      objIdx: 4,
      propId: 0,
      lsmIdx: 4,
      size: payload.length,
      fill: 0,
    };
    const write: DownloadStep = {
      type: 'WriteRelMem',
      objIdx: 4,
      propId: 0,
      size: payload.length,
      offset: 0,
    };
    await dev.downloadDevice('1.1.9', [relSeg, write], null, null, payload, undefined, {
      resolvedBases: { 4: BASE },
      mode: 'partial',
    });

    assert.equal(dev.writeCount(), 0, 'no Memory_Write/MemoryExtended_Write should have been sent');
    assert.equal(dev.loadDataModeBytes().length, 0, 'no LoadData step should have been sent either - the whole cycle was skipped');
  });

  it('writes (with the real Partial mode byte 0x00) when the device genuinely differs', async () => {
    const payload = Buffer.from('deadbeefcafef00d', 'hex');
    const backing = Buffer.alloc(0x10000); // starts all-zero - genuinely different from payload
    const dev = new FakeRWMemoryDevice('1.1.9', backing);

    const relSeg: DownloadStep = {
      type: 'RelSegment',
      objIdx: 4,
      propId: 0,
      lsmIdx: 4,
      size: payload.length,
      fill: 0,
    };
    const write: DownloadStep = {
      type: 'WriteRelMem',
      objIdx: 4,
      propId: 0,
      size: payload.length,
      offset: 0,
    };
    await dev.downloadDevice('1.1.9', [relSeg, write], null, null, payload, undefined, {
      resolvedBases: { 4: BASE },
      mode: 'partial',
    });

    assert.ok(dev.writeCount() > 0, 'expected real write chunks since the device genuinely differed');
    assert.deepEqual(dev.loadDataModeBytes(), [0x00], 'partial mode must force the LoadData mode byte to 0x00 (real captured Partial semantic), not the model-declared combined shape');
    assert.deepEqual([...dev.memory.subarray(BASE, BASE + payload.length)], [...payload]);
  });

  it("mode='full' (the default) is completely unaffected - always writes, mode byte follows the model's own declared combined shape", async () => {
    const payload = Buffer.from('deadbeefcafef00d', 'hex');
    const backing = Buffer.alloc(0x10000);
    payload.copy(backing, BASE); // device ALREADY matches - full mode must still write anyway
    const dev = new FakeRWMemoryDevice('1.1.9', backing);

    // TWO RelSegment steps for the same lsmIdx - mirrors 1.1.10's real app
    // model (the only one this project has seen declare both a "full" and a
    // "par" RelSegment for the parameter object) - makes relSegByObj compute
    // combined=true, so this test actually exercises "mode byte follows the
    // declared shape" rather than coincidentally landing on 0 either way.
    const relSegFull: DownloadStep = {
      type: 'RelSegment', objIdx: 4, propId: 0, lsmIdx: 4, size: payload.length, fill: 0,
    };
    const relSegPar: DownloadStep = {
      type: 'RelSegment', objIdx: 4, propId: 0, lsmIdx: 4, size: payload.length, fill: 0,
    };
    const write: DownloadStep = {
      type: 'WriteRelMem',
      objIdx: 4,
      propId: 0,
      size: payload.length,
      offset: 0,
    };
    // mode omitted entirely - exercises the real default, not an explicit 'full'.
    await dev.downloadDevice('1.1.9', [relSegFull, relSegPar, write], null, null, payload, undefined, {
      resolvedBases: { 4: BASE },
    });

    assert.ok(dev.writeCount() > 0, 'full mode must always write, even if the device already matches');
    assert.deepEqual(dev.loadDataModeBytes(), [0x01], 'a combined (full+par) RelSegment declaration must still produce mode=Full (0x01) unchanged in full mode');
  });
});
