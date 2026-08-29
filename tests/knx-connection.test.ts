/**
 * Tests for KNX connection layer: KnxConnection base class (via test subclass),
 * KnxIpConnection message dispatcher, and KnxBusManager state management.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  KnxConnection,
  parseCEMI,
  buildCEMI,
  encodePhysical,
  encodeGroup,
  delay,
  type DownloadStep,
} from '../server/knx-connection.ts';
import type { CemiFrame } from '../server/knx-cemi.ts';
import {
  _apduGroupRead as apduGroupRead,
  _apduGroupWrite as apduGroupWrite,
  _apduGroupResponse as apduGroupResponse,
  _apduControl as apduControl,
  _TPCI as TPCI,
} from '../server/knx-cemi.ts';

// ── Test subclass ─────────────────────────────────────────────────────────────

class TestKnxConnection extends KnxConnection {
  sent: Buffer[] = [];
  disconnected = false;

  sendCEMI(cemi: Buffer): Promise<void> {
    this.sent.push(cemi);
    return Promise.resolve();
  }

  disconnect(): void {
    this.disconnected = true;
    this.connected = false;
  }

  /** Simulate receiving a group telegram from the bus */
  simulateGroupTelegram(src: string, dst: string, apdu: Buffer): void {
    const cemi = buildCEMI(src, dst, apdu, true);
    const parsed = parseCEMI(cemi)!;
    this._onCEMI(parsed);
  }

  /** Simulate receiving a device management frame */
  simulateMgmtFrame(cemi: CemiFrame): void {
    this._onCEMI(cemi);
  }
}

// ── KnxConnection._onCEMI ─────────────────────────────────────────────────────

describe('KnxConnection._onCEMI', () => {
  it('emits telegram event for group frames', async () => {
    const conn = new TestKnxConnection();
    const received: unknown[] = [];
    conn.on('telegram', (tg) => received.push(tg));

    conn.simulateGroupTelegram('1.1.1', '1/0/0', apduGroupWrite(true, '1'));

    assert.equal(received.length, 1);
    const tg = received[0] as Record<string, unknown>;
    assert.equal(tg.src, '1.1.1');
    assert.equal(tg.dst, '1/0/0');
    assert.equal(tg.type, 'GroupValue_Write');
  });

  it('emits _mgmt event for device (non-group) frames', () => {
    const conn = new TestKnxConnection();
    const received: CemiFrame[] = [];
    conn.on('_mgmt', (cemi) => received.push(cemi));

    // Build a device-addressed CEMI (isGroup=false)
    const apdu = apduGroupRead(); // DeviceDescriptor_Read uses same encoding
    const raw = buildCEMI('1.1.1', '1.1.2', apdu, false);
    const parsed = parseCEMI(raw)!;
    conn._onCEMI(parsed);

    assert.equal(received.length, 1);
    assert.equal(received[0].src, '1.1.1');
    assert.equal(received[0].isGroup, false);
  });
});

// ── KnxConnection.write ───────────────────────────────────────────────────────

describe('KnxConnection.write', () => {
  it('sends CEMI and returns result', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const result = await conn.write('1/0/0', true, '1');
    assert.deepEqual(result, { ok: true, ga: '1/0/0', value: true, dpt: '1' });
    assert.equal(conn.sent.length, 1);

    // Verify the sent CEMI is parseable and correct
    const parsed = parseCEMI(conn.sent[0]!);
    assert.ok(parsed);
    assert.equal(parsed.dst, '1/0/0');
    assert.equal(parsed.isGroup, true);
    assert.equal(parsed.apciName, 'GroupValue_Write');
  });

  it('throws when not connected', async () => {
    const conn = new TestKnxConnection();
    conn.connected = false;

    await assert.rejects(() => conn.write('1/0/0', true, '1'), {
      message: 'Not connected',
    });
  });
});

// ── KnxConnection.read ────────────────────────────────────────────────────────

describe('KnxConnection.read', () => {
  it('resolves on matching GroupValue_Response', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const readPromise = conn.read('1/0/0', 2000);

    // Simulate a response after a short delay
    setTimeout(() => {
      conn.simulateGroupTelegram(
        '1.1.2',
        '1/0/0',
        apduGroupResponse(Buffer.from([0x01])),
      );
    }, 10);

    const result = await readPromise;
    assert.equal(result.ga, '1/0/0');
    assert.ok(result.value); // decoded value
  });

  it('ignores non-matching GAs', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const readPromise = conn.read('1/0/0', 500);

    // Send a response to a different GA — should be ignored
    setTimeout(() => {
      conn.simulateGroupTelegram(
        '1.1.2',
        '2/0/0',
        apduGroupResponse(Buffer.from([0x01])),
      );
    }, 10);

    await assert.rejects(readPromise, { message: 'Read timeout' });
  });

  it('ignores GroupValue_Write (not Response)', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const readPromise = conn.read('1/0/0', 500);

    // Send a Write to the correct GA — should be ignored
    setTimeout(() => {
      conn.simulateGroupTelegram('1.1.2', '1/0/0', apduGroupWrite(true, '1'));
    }, 10);

    await assert.rejects(readPromise, { message: 'Read timeout' });
  });

  it('rejects on timeout', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    await assert.rejects(() => conn.read('1/0/0', 100), {
      message: 'Read timeout',
    });
  });

  it('throws when not connected', async () => {
    const conn = new TestKnxConnection();
    conn.connected = false;

    assert.throws(() => conn.read('1/0/0'), { message: 'Not connected' });
  });
});

// ── KnxConnection.managementSession ───────────────────────────────────────────

describe('KnxConnection.managementSession', () => {
  it('sends CONNECT, runs function, sends DISCONNECT', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';
    let fnCalled = false;

    await conn.managementSession('1.1.2', async () => {
      fnCalled = true;
    });

    assert.ok(fnCalled);
    // At minimum: CONNECT control + DISCONNECT control
    assert.ok(
      conn.sent.length >= 2,
      `sent ${conn.sent.length} frames, expected >= 2`,
    );

    // First frame should be CONNECT
    const first = parseCEMI(conn.sent[0]!);
    assert.ok(first);
    assert.equal(first.dst, '1.1.2');
    assert.equal(first.isGroup, false);

    // Last frame should be DISCONNECT
    const last = parseCEMI(conn.sent[conn.sent.length - 1]!);
    assert.ok(last);
    assert.equal(last.dst, '1.1.2');
    assert.equal(last.isGroup, false);
  });

  it('sends DISCONNECT even when function throws', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    await assert.rejects(
      () =>
        conn.managementSession('1.1.2', async () => {
          throw new Error('test error');
        }),
      { message: 'test error' },
    );

    // DISCONNECT should still be sent (last frame)
    assert.ok(conn.sent.length >= 2);
  });

  it('provides working sendData and nextSeq', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const seqs: number[] = [];
    await conn.managementSession('1.1.2', async ({ sendData, nextSeq }) => {
      seqs.push(nextSeq());
      await sendData('DeviceDescriptor_Read', null);
      seqs.push(nextSeq());
      await sendData('Memory_Read', Buffer.from([0x01, 0x00, 0x60]));
    });

    assert.deepEqual(seqs, [0, 1]);
    // CONNECT + 2 data frames + DISCONNECT = 4 frames minimum
    assert.ok(conn.sent.length >= 4, `sent ${conn.sent.length}, expected >= 4`);
  });

  it('throws when not connected', async () => {
    const conn = new TestKnxConnection();
    conn.connected = false;

    await assert.rejects(
      () => conn.managementSession('1.1.2', async () => {}),
      { message: 'Not connected' },
    );
  });
});

// ── KnxConnection.ping ────────────────────────────────────────────────────────

describe('KnxConnection.ping', () => {
  it('resolves reachable on matching telegram', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const pingPromise = conn.ping(['1/0/0'], '1.1.2', 2000);

    // Simulate a telegram from the device
    setTimeout(() => {
      conn.simulateGroupTelegram('1.1.2', '1/0/0', apduGroupWrite(true, '1'));
    }, 10);

    const result = await pingPromise;
    assert.equal(result.reachable, true);
    assert.equal(result.ga, '1/0/0');
  });

  it('resolves unreachable on timeout', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    // Use a very short timeout and disable managementSession by making sendCEMI slow
    const result = await conn.ping([], '', 100);
    assert.equal(result.reachable, false);
    assert.equal(result.ga, null);
  });

  it('rejects when not connected', async () => {
    const conn = new TestKnxConnection();
    conn.connected = false;

    await assert.rejects(() => conn.ping(['1/0/0'], '1.1.2'), {
      message: 'Not connected',
    });
  });
});

// ── KnxConnection.programIA ──────────────────────────────────────────────────

describe('KnxConnection.programIA', () => {
  it('sends physical address write and returns result', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const result = await conn.programIA('1.1.5');
    assert.deepEqual(result, { ok: true, newAddr: '1.1.5' });
    assert.equal(conn.sent.length, 1);

    // Verify the CEMI is addressed to 0.0.0 (broadcast for programming)
    const parsed = parseCEMI(conn.sent[0]!);
    assert.ok(parsed);
    assert.equal(parsed.dst, '0.0.0');
    assert.equal(parsed.isGroup, false);
  });

  it('throws when not connected', async () => {
    const conn = new TestKnxConnection();
    conn.connected = false;

    await assert.rejects(() => conn.programIA('1.1.5'), {
      message: 'Not connected',
    });
  });
});

// ── KnxConnection.scan ───────────────────────────────────────────────────────

describe('KnxConnection.scan', () => {
  it('iterates addresses and reports progress', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const progressCalls: Array<{ address: string; done: number }> = [];
    const found = await conn.scan(1, 1, 10, (p) => {
      progressCalls.push({ address: p.address, done: p.done });
    });

    // All probes should time out with 10ms timeout
    assert.equal(found.length, 0);
    // Should have reported progress for all 256 addresses
    assert.equal(progressCalls.length, 256);
    assert.equal(progressCalls[0].address, '1.1.0');
    assert.equal(progressCalls[0].done, 1);
    assert.equal(progressCalls[255].address, '1.1.255');
    assert.equal(progressCalls[255].done, 256);
  });

  it('abortScan stops early', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    let progressCount = 0;
    // Abort after 3 probes
    const scanPromise = conn.scan(1, 1, 10, () => {
      progressCount++;
      if (progressCount >= 3) conn.abortScan();
    });

    const found = await scanPromise;
    assert.equal(found.length, 0);
    assert.ok(progressCount >= 3 && progressCount <= 4);
  });

  it('rejects when not connected', async () => {
    const conn = new TestKnxConnection();
    conn.connected = false;

    await assert.rejects(() => conn.scan(1, 1, 100), {
      message: 'Not connected',
    });
  });
});

// ── KnxConnection._probeSingle ───────────────────────────────────────────────

describe('KnxConnection._probeSingle', () => {
  it('returns null on timeout', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const result = await conn._probeSingle('1.1.1', 50);
    assert.equal(result, null);
  });

  it('resolves with descriptor on DeviceDescriptor_Response', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const probePromise = conn._probeSingle('1.1.1', 2000);

    // Simulate a DeviceDescriptor_Response
    setTimeout(() => {
      const mgmtFrame: CemiFrame = {
        msgCode: 0x29,
        src: '1.1.1',
        dst: '1.0.1',
        isGroup: false,
        apciIdx: 13,
        apciName: 'DeviceDescriptor_Response',
        apduData: Buffer.from([0x07, 0xb0]),
        apdu: Buffer.alloc(4),
        tpciType: 'DATA_CONNECTED',
      };
      conn.emit('_mgmt', mgmtFrame);
    }, 10);

    const result = await probePromise;
    assert.ok(result);
    assert.equal(result.descriptor, '07b0');
  });

  it('returns null when not connected', async () => {
    const conn = new TestKnxConnection();
    conn.connected = false;

    const result = await conn._probeSingle('1.1.1', 50);
    assert.equal(result, null);
  });
});

// ── KnxConnection.downloadDevice ─────────────────────────────────────────────

describe('KnxConnection.downloadDevice', () => {
  it('processes WriteProp steps', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const steps: DownloadStep[] = [
      { type: 'WriteProp', objIdx: 0, propId: 56, data: Buffer.from([0x01]) },
    ];
    const progress: string[] = [];

    await conn.downloadDevice('1.1.2', steps, null, null, null, (p) =>
      progress.push(p.msg),
    );

    assert.ok(progress.some((m) => m.includes('WriteProp')));
    assert.ok(progress.includes('Download complete'));
  });

  it('LoadImageProp is read-only for every objIdx, including 4 (real ETS never writes it there)', async () => {
    // Confirmed 2026-08-29 against 3 independent real downloads of 1.1.10:
    // ETS only ever reads this property for objIdx 1/2/3/4 - identical
    // value before/after, every time, including objIdx4 - it does not
    // write image/table/checksum bytes via this step for any object. An
    // earlier fix here special-cased objIdx4 to read-then-write-back a
    // "checksum recompute" - itself wrong: the real writes to objIdx4/P27
    // come from a separate WriteProp step this app's own model declares
    // explicitly (see the WriteProp test below), not from LoadImageProp.
    // gaTable/assocTable are omitted (null) here so downloadDevice()'s
    // separate "write undeclared GA/Association table" fallback (see
    // Part 6 of the reference doc) never fires and confuses this test -
    // that's a different feature, exercised by its own tests.
    const hasPropWrite = (cemi: Buffer): boolean => {
      const parsed = parseCEMI(cemi);
      return (
        !!parsed &&
        parsed.apciName === 'OTHER' &&
        parsed.apdu.length >= 2 &&
        (parsed.apdu.readUInt16BE(0) & 0x3ff) === 0x03d7
      );
    };

    for (const objIdx of [1, 2, 3, 4]) {
      const conn = new TestKnxConnection();
      conn.connected = true;
      conn.localAddr = '1.0.1';

      const steps: DownloadStep[] = [{ type: 'LoadImageProp', objIdx, propId: 27 }];
      const progress: string[] = [];

      await conn.downloadDevice('1.1.2', steps, null, null, null, (p) =>
        progress.push(p.msg),
      );

      assert.ok(
        progress.some((m) => m.includes('LoadImageProp') && m.includes('read-only')),
        `objIdx=${objIdx} should log a read-only LoadImageProp message`,
      );
      assert.equal(
        conn.sent.filter(hasPropWrite).length,
        0,
        `objIdx=${objIdx} must not write PropertyValue`,
      );
    }

    // Separately: prove LoadImageProp itself never fabricates a property-27
    // content write for a supplied gaTable - it stays genuinely read-only.
    // (Corrected 2026-08-29: a declared LoadImageProp step no longer
    // suppresses the separate undeclared-table fallback - see
    // declaredTableObjIdxs in knx-connection.ts and
    // ga-assoc-table-write.test.ts - so with a real gaTable supplied here,
    // that fallback now correctly fires and writes it via its own
    // Unload/StartLoading/LoadData/Memory_Write/LoadCompleted cycle, which
    // includes PID_LOAD_STATE_CONTROL (property 5) PropertyValue_Write
    // frames. Those are a different mechanism from what this test is
    // checking, so the matcher below is narrowed to property 27
    // specifically - the only signature a LoadImageProp-driven content
    // write could plausibly use.)
    const hasProp27Write = (cemi: Buffer): boolean =>
      hasPropWrite(cemi) && parseCEMI(cemi)!.apdu[3] === 27;
    const conn2 = new TestKnxConnection();
    conn2.connected = true;
    conn2.localAddr = '1.0.1';
    const gaTable = Buffer.from([0x02, 0x08, 0x00, 0x08, 0x01]);
    await conn2.downloadDevice(
      '1.1.2',
      [{ type: 'LoadImageProp', objIdx: 1, propId: 27 }],
      gaTable,
      null,
      null,
      () => {},
    );
    assert.equal(
      conn2.sent.filter(hasProp27Write).length,
      0,
      'LoadImageProp must not itself write the supplied gaTable via a property-27 PropertyValue_Write',
    );
  });

  it('WriteProp trims propId=27 data to its real 8-byte element size', async () => {
    // The project file's own declared InlineData for objIdx4/propId27
    // WriteProp steps is always 2 bytes longer than what real ETS actually
    // puts on the wire - confirmed 2026-08-29 by comparing a real capture
    // against the project file, then checked against every app in this
    // project's data/apps declaring this step (several different
    // manufacturers) - all consistently 10 bytes, ending in 2 trailing
    // zero-padding bytes beyond the real 8-byte element. Not observed for
    // any other property, so the trim in the WriteProp case is scoped to
    // propId 27 only.
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    // Real literal data from 1.1.10's own app model (M-0004_A-3030-23-F0EA-O000A).
    const declared = Buffer.from('000028c0003300000000', 'hex'); // 10 bytes
    const steps: DownloadStep[] = [
      { type: 'WriteProp', objIdx: 4, propId: 27, data: declared },
    ];
    const progress: string[] = [];

    await conn.downloadDevice('1.1.2', steps, null, null, null, (p) =>
      progress.push(p.msg),
    );

    const propFrames = conn.sent
      .map((cemi) => parseCEMI(cemi))
      .filter(
        (p): p is NonNullable<typeof p> =>
          !!p && p.apdu.length >= 2 && (p.apdu.readUInt16BE(0) & 0x3ff) === 0x03d7,
      );

    assert.equal(propFrames.length, 1);
    const sentData = propFrames[0]!.apduData.subarray(4);
    assert.equal(sentData.length, 8, 'must send exactly the 8-byte element, not the declared 10');
    assert.equal(sentData.toString('hex'), '000028c000330000');
  });

  it('WriteProp does NOT trim data for other properties', async () => {
    // Sanity check that the propId===27 trim is scoped correctly and
    // doesn't clip an unrelated property's legitimate multi-byte value.
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const data = Buffer.from('0007080770', 'hex'); // real PID_PROGRAM_VERSION-shaped example
    const steps: DownloadStep[] = [{ type: 'WriteProp', objIdx: 4, propId: 13, data }];
    const progress: string[] = [];

    await conn.downloadDevice('1.1.2', steps, null, null, null, (p) =>
      progress.push(p.msg),
    );

    const propFrames = conn.sent
      .map((cemi) => parseCEMI(cemi))
      .filter(
        (p): p is NonNullable<typeof p> =>
          !!p && p.apdu.length >= 2 && (p.apdu.readUInt16BE(0) & 0x3ff) === 0x03d7,
      );

    assert.equal(propFrames.length, 1);
    assert.equal(propFrames[0]!.apduData.subarray(4).toString('hex'), '0007080770');
  });

  it('processes WriteRelMem steps with chunking', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    // 25 bytes of param memory — should be split into 3 chunks (10+10+5)
    const paramMem = Buffer.alloc(25, 0xaa);
    const steps: DownloadStep[] = [
      { type: 'WriteRelMem', objIdx: 0, propId: 0, size: 25, offset: 0x100 },
    ];
    const progress: string[] = [];

    await conn.downloadDevice('1.1.2', steps, null, null, paramMem, (p) =>
      progress.push(p.msg),
    );

    // Should have progress updates for each chunk
    assert.ok(progress.some((m) => m.includes('WriteRelMem')));
    assert.ok(progress.includes('Download complete'));
  });

  it('falls back to legacy Memory_Write for a 16-bit-fitting address when the device never answers DeviceDescriptor_Read', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const paramMem = Buffer.alloc(8, 0xaa);
    const steps: DownloadStep[] = [
      { type: 'WriteRelMem', objIdx: 0, propId: 0, size: 8, offset: 0x100 },
    ];
    // No resolvedBases entry → base defaults to 0, so addr = 0x100, well
    // under 0xFFFF. WriteRelMem now reads the device's real mask version
    // (A_DeviceDescriptor_Read) and only forces A_MemoryExtended_Write
    // unconditionally for a confirmed System B device (mask 0x07B0) - a
    // real captured ETS Partial Download against 1.1.9, address 0x5F53,
    // also well within 16 bits, still used the extended service exclusively
    // there (see knx-connection.ts's WriteRelMem case and the dedicated
    // mask-gating tests in tests/relmem-write-protocol.test.ts). This
    // `TestKnxConnection` never answers the descriptor read at all, so this
    // test exercises the fallback path specifically: the original
    // conservative address-size heuristic (legacy service for an address
    // that fits in 16 bits) applies when the mask is unknown, rather than
    // assuming "always extended" generalizes to every device.
    await conn.downloadDevice('1.1.2', steps, null, null, paramMem, undefined);

    const writes = conn.sent
      .map((c) => parseCEMI(c))
      .filter((f) => f && f.apciName === 'Memory_Write');
    assert.equal(writes.length, 1);
    const extWrites = conn.sent
      .map((c) => parseCEMI(c))
      .filter((f) => f && f.apciName === 'MemoryExtended_Write');
    assert.equal(extWrites.length, 0);
  });

  it('uses MemoryExtended_Write when the resolved relmem base pushes the address above 0xFFFF (address encoded correctly, not truncated)', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const paramMem = Buffer.alloc(8, 0xaa);
    const steps: DownloadStep[] = [
      { type: 'WriteRelMem', objIdx: 0, propId: 0, size: 8, offset: 0x100 },
    ];
    // base 0x10000 + offset 0x100 = 0x10100 - doesn't fit in 16 bits.
    await conn.downloadDevice('1.1.2', steps, null, null, paramMem, undefined, {
      resolvedBases: { 0: 0x10000 },
    });

    const frames = conn.sent.map((c) => parseCEMI(c));
    const extWrites = frames.filter(
      (f) => f && f.apciName === 'MemoryExtended_Write',
    );
    assert.equal(extWrites.length, 1);
    assert.equal(
      frames.filter((f) => f && f.apciName === 'Memory_Write').length,
      0,
    );
    // Verify the address actually encoded is the resolved 0x10100, not a
    // 16-bit-truncated 0x0100 - this is the exact failure mode being fixed:
    // the legacy service would have silently written to the wrong address.
    const extApduData = extWrites[0]!.apduData;
    const encodedAddr =
      (extApduData[1]! << 16) | (extApduData[2]! << 8) | extApduData[3]!;
    assert.equal(encodedAddr, 0x10100);
  });

  it('throws on WriteRelMem without paramMem', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const steps: DownloadStep[] = [
      { type: 'WriteRelMem', objIdx: 0, propId: 0, size: 10, offset: 0 },
    ];

    await assert.rejects(
      () => conn.downloadDevice('1.1.2', steps, null, null, null),
      { message: 'Parameter memory not available' },
    );
  });

  it('skips CompareProp steps', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const steps: DownloadStep[] = [
      { type: 'CompareProp', objIdx: 0, propId: 56 },
    ];
    const progress: string[] = [];

    await conn.downloadDevice('1.1.2', steps, null, null, null, (p) =>
      progress.push(p.msg),
    );

    assert.ok(progress.some((m) => m.includes('CompareProp')));
    assert.ok(progress.includes('Download complete'));
  });

  it('throws when not connected', async () => {
    const conn = new TestKnxConnection();
    conn.connected = false;

    await assert.rejects(
      () => conn.downloadDevice('1.1.2', [], null, null, null),
      { message: 'Not connected' },
    );
  });

  // ── AbsoluteSegment (MDT-style) procedure — routes through planDownload ──

  it('routes AbsSegment-style steps through planDownload and sends the PID-5 sequence', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const steps: DownloadStep[] = [
      { type: 'Connect', objIdx: 0, propId: 0 },
      { type: 'Unload', objIdx: 0, propId: 0, lsmIdx: 1 },
      { type: 'Load', objIdx: 0, propId: 0, lsmIdx: 1 },
      {
        type: 'AbsSegment',
        objIdx: 0,
        propId: 0,
        lsmIdx: 1,
        address: 0x4000,
        size: 3,
      },
      { type: 'LoadCompleted', objIdx: 0, propId: 0, lsmIdx: 1 },
      { type: 'Restart', objIdx: 0, propId: 0 },
      { type: 'Disconnect', objIdx: 0, propId: 0 },
    ];
    const gaTable = Buffer.from([0x01, 0x08, 0x00]); // count=1, one GA entry
    const progress: string[] = [];

    await conn.downloadDevice(
      '1.1.2',
      steps,
      gaTable,
      null,
      null,
      (p) => progress.push(p.msg),
      {},
    );

    assert.ok(progress.includes('Download complete'));
    // 4 PID-5 propWrites (Unload, Load, Segment descriptor, LoadCompleted) +
    // the address-table memory writes (count byte + entries) + Restart.
    assert.ok(progress.some((m) => m.includes('PropWrite ObjIdx=1 PropId=5')));
    assert.ok(progress.some((m) => m.includes('MemWrite Addr=0x4000')));
    assert.ok(progress.some((m) => m.includes('Restart')));
    // Every frame actually went out over sendCEMI (still fully in-process —
    // TestKnxConnection.sendCEMI never touches a socket).
    assert.ok(conn.sent.length > 0);
  });

  it('skips memory writes for AbsSegments with no source buffer', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const steps: DownloadStep[] = [
      { type: 'Load', objIdx: 0, propId: 0, lsmIdx: 3 },
      {
        type: 'AbsSegment',
        objIdx: 0,
        propId: 0,
        lsmIdx: 3,
        address: 0x0700,
        size: 132,
      },
      { type: 'LoadCompleted', objIdx: 0, propId: 0, lsmIdx: 3 },
    ];
    const progress: string[] = [];

    await conn.downloadDevice('1.1.2', steps, null, null, null, (p) =>
      progress.push(p.msg),
    );

    assert.ok(progress.includes('Download complete'));
    assert.ok(!progress.some((m) => m.includes('MemWrite')));
  });
});

// ── KnxConnection.identify ───────────────────────────────────────────────────

describe('KnxConnection.identify', () => {
  it('sends memory write on then off', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    // Patch delay to speed up the 3-second wait
    const origDelay = delay;
    const delayModule = await import('../server/knx-connection.ts');

    // identify has a 3s delay — we just verify it runs without error
    // and sends frames. The test subclass makes sendCEMI instant.
    await conn.identify('1.1.2');

    // Should have sent: CONNECT, memory_write(on), memory_write(off), DISCONNECT
    assert.ok(conn.sent.length >= 4, `sent ${conn.sent.length}, expected >= 4`);
  });

  it('throws when not connected', async () => {
    const conn = new TestKnxConnection();
    conn.connected = false;

    await assert.rejects(() => conn.identify('1.1.2'), {
      message: 'Not connected',
    });
  });
});

// ── KnxIpConnection message dispatcher ────────────────────────────────────────

import { KnxConnection as KnxIpConnection } from '../server/knx-protocol.ts';
import { _SVC as SVC } from '../server/knx-protocol.ts';

describe('KnxIpConnection._onConnectRes', () => {
  it('sets connected state and channelId on success', () => {
    const conn = new KnxIpConnection();
    const events: string[] = [];
    conn.on('_connected', () => events.push('_connected'));
    conn.on('connected', () => events.push('connected'));

    // Build a CONNECT_RES: header(6) + channelId(1) + status(1) + CRD(4) + HPAI(8)
    const buf = Buffer.alloc(20);
    // Header
    buf[0] = 0x06;
    buf[1] = 0x10;
    buf.writeUInt16BE(SVC.CONNECT_RES, 2);
    buf.writeUInt16BE(20, 4);
    // Channel ID
    buf[6] = 0x42;
    // Status OK
    buf[7] = 0x00;
    // CRD (4 bytes)
    buf[8] = 0x04;
    buf[9] = 0x04;
    // Data endpoint HPAI (8 bytes) — starts at offset 10
    buf[10] = 0x08;
    buf[11] = 0x01;
    // local address at bytes 18-19
    buf[18] = 0x11; // 1.1.x
    buf[19] = 0x02; // x.x.2

    conn._onConnectRes(buf);

    assert.equal(conn.channelId, 0x42);
    assert.equal(conn.connected, true);
    assert.equal(conn.localAddr, '1.1.2');
    assert.ok(events.includes('_connected'));
    assert.ok(events.includes('connected'));

    // Clean up heartbeat timer
    conn._clearHeartbeat();
  });

  it('emits _connectFailed on non-zero status', () => {
    const conn = new KnxIpConnection();
    let failedErr: Error | null = null;
    conn.on('_connectFailed', (err: Error) => {
      failedErr = err;
    });

    const buf = Buffer.alloc(8);
    buf[0] = 0x06;
    buf[1] = 0x10;
    buf.writeUInt16BE(SVC.CONNECT_RES, 2);
    buf.writeUInt16BE(8, 4);
    buf[6] = 0x42;
    buf[7] = 0x24; // E_NO_MORE_CONNECTIONS

    conn._onConnectRes(buf);

    assert.ok(failedErr);
    assert.ok(failedErr!.message.includes('0x24'));
    assert.equal(conn.connected, false);
  });

  it('ignores too-short message', () => {
    const conn = new KnxIpConnection();
    // Should not throw
    conn._onConnectRes(Buffer.alloc(5));
    assert.equal(conn.connected, false);
  });
});

describe('KnxIpConnection._onDisconnectReq', () => {
  it('clears connected state and emits disconnected', () => {
    const conn = new KnxIpConnection();
    conn.connected = true;
    let disconnected = false;
    conn.on('disconnected', () => {
      disconnected = true;
    });

    const buf = Buffer.alloc(16);
    buf[6] = 0x42; // channel ID

    conn._onDisconnectReq(buf);

    assert.equal(conn.connected, false);
    assert.ok(disconnected);
  });
});

describe('KnxIpConnection._onDisconnectRes', () => {
  it('clears connected state and emits disconnected', () => {
    const conn = new KnxIpConnection();
    conn.connected = true;
    let disconnected = false;
    conn.on('disconnected', () => {
      disconnected = true;
    });

    conn._onDisconnectRes();

    assert.equal(conn.connected, false);
    assert.ok(disconnected);
  });
});

describe('KnxIpConnection._onTunnelingReq', () => {
  it('sends ACK and processes CEMI', () => {
    const conn = new KnxIpConnection();
    conn.connected = true;
    const sentRaw: Buffer[] = [];
    conn._sendRaw = (buf: Buffer) => sentRaw.push(buf);

    const telegrams: unknown[] = [];
    conn.on('telegram', (tg) => telegrams.push(tg));

    // Build a tunneling request with embedded CEMI GroupValue_Write
    const apdu = apduGroupWrite(true, '1');
    const cemi = buildCEMI('1.1.1', '1/0/0', apdu, true);
    const msg = Buffer.alloc(10 + cemi.length);
    msg[0] = 0x06;
    msg[1] = 0x10;
    msg.writeUInt16BE(SVC.TUNNELING_REQ, 2);
    msg.writeUInt16BE(10 + cemi.length, 4);
    msg[6] = 0x04; // connection header length
    msg[7] = 0x42; // channel ID
    msg[8] = 0x05; // sequence number
    msg[9] = 0x00; // reserved
    cemi.copy(msg, 10);

    conn._onTunnelingReq(msg);

    // Should have sent an ACK
    assert.equal(sentRaw.length, 1);
    const ackBuf = sentRaw[0]!;
    assert.equal(ackBuf.readUInt16BE(2), SVC.TUNNELING_ACK);
    assert.equal(ackBuf[7], 0x42); // channel ID
    assert.equal(ackBuf[8], 0x05); // sequence echoed

    // Should have emitted telegram
    assert.equal(telegrams.length, 1);
    assert.equal(conn.seqIn, 0x05);
  });

  it('deduplicates same sequence number', () => {
    const conn = new KnxIpConnection();
    conn.connected = true;
    conn._sendRaw = () => {};

    const telegrams: unknown[] = [];
    conn.on('telegram', (tg) => telegrams.push(tg));

    const apdu = apduGroupWrite(true, '1');
    const cemi = buildCEMI('1.1.1', '1/0/0', apdu, true);
    const msg = Buffer.alloc(10 + cemi.length);
    msg[0] = 0x06;
    msg[1] = 0x10;
    msg.writeUInt16BE(SVC.TUNNELING_REQ, 2);
    msg.writeUInt16BE(10 + cemi.length, 4);
    msg[6] = 0x04;
    msg[7] = 0x42;
    msg[8] = 0x03; // seq=3
    cemi.copy(msg, 10);

    conn._onTunnelingReq(msg);
    conn._onTunnelingReq(msg); // same seq — should be deduplicated

    assert.equal(telegrams.length, 1); // only one telegram emitted
  });

  it('ignores too-short messages', () => {
    const conn = new KnxIpConnection();
    // Should not throw
    conn._onTunnelingReq(Buffer.alloc(8));
  });
});

describe('KnxIpConnection._onTunnelingAck', () => {
  it('resolves pending ACK on success', async () => {
    const conn = new KnxIpConnection();
    conn.connected = true;
    conn.channelId = 0x42;
    conn._sendRaw = () => {};

    // Start a sendCEMI which sets up a pending ACK
    const cemi = buildCEMI('1.0.1', '1/0/0', apduGroupRead(), true);
    const sendPromise = conn.sendCEMI(cemi, 2000);

    // Simulate ACK for seq 0
    const ackMsg = Buffer.alloc(10);
    ackMsg[0] = 0x06;
    ackMsg[1] = 0x10;
    ackMsg.writeUInt16BE(SVC.TUNNELING_ACK, 2);
    ackMsg.writeUInt16BE(10, 4);
    ackMsg[6] = 0x04;
    ackMsg[7] = 0x42;
    ackMsg[8] = 0x00; // seq=0
    ackMsg[9] = 0x00; // status OK

    conn._onTunnelingAck(ackMsg);

    await sendPromise; // should resolve without error
  });

  it('rejects pending ACK on error status', async () => {
    const conn = new KnxIpConnection();
    conn.connected = true;
    conn.channelId = 0x42;
    conn._sendRaw = () => {};

    const cemi = buildCEMI('1.0.1', '1/0/0', apduGroupRead(), true);
    const sendPromise = conn.sendCEMI(cemi, 2000);

    const ackMsg = Buffer.alloc(10);
    ackMsg[0] = 0x06;
    ackMsg[1] = 0x10;
    ackMsg.writeUInt16BE(SVC.TUNNELING_ACK, 2);
    ackMsg.writeUInt16BE(10, 4);
    ackMsg[6] = 0x04;
    ackMsg[7] = 0x42;
    ackMsg[8] = 0x00; // seq=0
    ackMsg[9] = 0x29; // error status

    conn._onTunnelingAck(ackMsg);

    await assert.rejects(sendPromise, /Tunneling ACK error/);
  });

  it('times out when no ACK received', async () => {
    const conn = new KnxIpConnection();
    conn.connected = true;
    conn.channelId = 0x42;
    conn._sendRaw = () => {};

    const cemi = buildCEMI('1.0.1', '1/0/0', apduGroupRead(), true);
    await assert.rejects(() => conn.sendCEMI(cemi, 100), {
      message: 'Tunneling ACK timeout',
    });
  });

  it('ignores ACK with wrong sequence', async () => {
    const conn = new KnxIpConnection();
    conn.connected = true;
    conn.channelId = 0x42;
    conn._sendRaw = () => {};

    const cemi = buildCEMI('1.0.1', '1/0/0', apduGroupRead(), true);
    const sendPromise = conn.sendCEMI(cemi, 200);

    // Send ACK with wrong seq
    const ackMsg = Buffer.alloc(10);
    ackMsg[8] = 0x05; // wrong seq (should be 0)
    ackMsg[9] = 0x00;
    conn._onTunnelingAck(ackMsg);

    // Should still time out
    await assert.rejects(sendPromise, { message: 'Tunneling ACK timeout' });
  });
});

describe('KnxIpConnection._onMsg dispatcher', () => {
  it('dispatches CONNECT_RES', () => {
    const conn = new KnxIpConnection();
    let called = false;
    conn._onConnectRes = () => {
      called = true;
    };

    const msg = Buffer.alloc(8);
    msg[0] = 0x06;
    msg[1] = 0x10;
    msg.writeUInt16BE(SVC.CONNECT_RES, 2);
    msg.writeUInt16BE(8, 4);

    conn._onMsg(msg, {} as any);
    assert.ok(called);
  });

  it('dispatches TUNNELING_REQ', () => {
    const conn = new KnxIpConnection();
    let called = false;
    conn._onTunnelingReq = () => {
      called = true;
    };

    const msg = Buffer.alloc(12);
    msg[0] = 0x06;
    msg[1] = 0x10;
    msg.writeUInt16BE(SVC.TUNNELING_REQ, 2);
    msg.writeUInt16BE(12, 4);

    conn._onMsg(msg, {} as any);
    assert.ok(called);
  });

  it('ignores too-short messages', () => {
    const conn = new KnxIpConnection();
    // Should not throw
    conn._onMsg(Buffer.alloc(4), {} as any);
  });
});

describe('KnxIpConnection.disconnect', () => {
  it('is a no-op without a socket', () => {
    const conn = new KnxIpConnection();
    // No socket — early return, should not throw
    conn.disconnect();
    assert.equal(conn.connected, false);
  });
});

describe('KnxIpConnection.sendCEMI sequence', () => {
  it('increments sequence number and wraps at 256', () => {
    const conn = new KnxIpConnection();
    conn.connected = true;
    conn.channelId = 1;
    conn._sendRaw = () => {};

    // Set seqOut near wrap point
    conn.seqOut = 254;

    // Each sendCEMI creates a pending ACK — resolve them to allow next send
    const cemi = buildCEMI('1.0.1', '1/0/0', apduGroupRead(), true);

    // Send 3 frames: seq 254, 255, 0
    conn.sendCEMI(cemi, 5000);
    assert.equal(conn.seqOut, 255);
    // Resolve pending ACK
    assert.ok(conn._pendingAck);
    clearTimeout(conn._pendingAck.timer);
    conn._pendingAck.resolve();
    conn._pendingAck = null;

    conn.sendCEMI(cemi, 5000);
    assert.equal(conn.seqOut, 0); // wrapped
    clearTimeout(conn._pendingAck!.timer);
    conn._pendingAck!.resolve();
    conn._pendingAck = null;

    conn.sendCEMI(cemi, 5000);
    assert.equal(conn.seqOut, 1);
    clearTimeout(conn._pendingAck!.timer);
    conn._pendingAck!.resolve();
    conn._pendingAck = null;
  });
});

describe('KnxIpConnection.sendCEMI queue serialization', () => {
  function ackMsg(channelId: number, seq: number, status = 0x00): Buffer {
    const b = Buffer.alloc(10);
    b[0] = 0x06;
    b[1] = 0x10;
    b.writeUInt16BE(SVC.TUNNELING_ACK, 2);
    b.writeUInt16BE(10, 4);
    b[6] = 0x04;
    b[7] = channelId;
    b[8] = seq;
    b[9] = status;
    return b;
  }

  it('holds a second send off the wire until the first is ACKed, then sends it with the next sequence number', async () => {
    const conn = new KnxIpConnection();
    conn.connected = true;
    conn.channelId = 1;
    const sent: Buffer[] = [];
    conn._sendRaw = (buf: Buffer) => sent.push(buf);

    const cemi = buildCEMI('1.0.1', '1/0/0', apduGroupRead(), true);

    const p1 = conn.sendCEMI(cemi, 5000);
    const p2 = conn.sendCEMI(cemi, 5000);

    // Only the first packet should be on the wire; the second is queued
    // behind it, and _pendingAck must belong to the first send.
    assert.equal(sent.length, 1);
    assert.ok(conn._pendingAck);
    assert.equal(conn._pendingAck.seq, 0);

    conn._onTunnelingAck(ackMsg(1, 0));
    await p1;

    // ACKing the first send must release the second synchronously.
    assert.equal(sent.length, 2);
    assert.ok(conn._pendingAck);
    assert.equal(conn._pendingAck.seq, 1);

    conn._onTunnelingAck(ackMsg(1, 1));
    await p2;
  });

  it('does not deadlock the queue when the first send times out', async () => {
    const conn = new KnxIpConnection();
    conn.connected = true;
    conn.channelId = 1;
    const sent: Buffer[] = [];
    conn._sendRaw = (buf: Buffer) => sent.push(buf);

    const cemi = buildCEMI('1.0.1', '1/0/0', apduGroupRead(), true);

    const p1 = conn.sendCEMI(cemi, 50);
    const p2 = conn.sendCEMI(cemi, 5000);

    assert.equal(sent.length, 1);

    await assert.rejects(p1, { message: 'Tunneling ACK timeout' });

    // The internal timeout settles _sendCEMIOnce's promise via the raw
    // closure reject (bypassing _pendingAck), so the queue drains on a
    // follow-up microtask rather than synchronously — give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(sent.length, 2);
    assert.ok(conn._pendingAck);
    assert.equal(conn._pendingAck.seq, 1);

    conn._onTunnelingAck(ackMsg(1, 1));
    await p2;
  });
});

describe('KnxIpConnection.status', () => {
  it('returns correct status', () => {
    const conn = new KnxIpConnection();
    conn.host = '192.168.1.1';
    conn.port = 3671;
    conn.connected = true;

    const s = conn.status();
    assert.equal(s.connected, true);
    assert.equal(s.host, '192.168.1.1');
    assert.equal(s.port, 3671);
    assert.equal(s.hasLib, true);
  });
});

// ── KnxBusManager ─────────────────────────────────────────────────────────────

const KnxBusManager = (await import('../server/knx-bus.ts')).default;

describe('KnxBusManager: not-connected guards', () => {
  it('write throws when not connected', () => {
    const bus = new KnxBusManager();
    assert.throws(() => bus.write('1/0/0', true), /Not connected/);
  });

  it('read throws when not connected', () => {
    const bus = new KnxBusManager();
    assert.throws(() => bus.read('1/0/0'), /Not connected/);
  });

  it('ping rejects when not connected', async () => {
    const bus = new KnxBusManager();
    await assert.rejects(() => bus.ping(['1/0/0']), /Not connected/);
  });

  it('identify rejects when not connected', async () => {
    const bus = new KnxBusManager();
    await assert.rejects(() => bus.identify('1.1.1'), /Not connected/);
  });

  it('scan rejects when not connected', async () => {
    const bus = new KnxBusManager();
    await assert.rejects(() => bus.scan(1, 1), /Not connected/);
  });

  it('readDeviceInfo rejects when not connected', async () => {
    const bus = new KnxBusManager();
    await assert.rejects(() => bus.readDeviceInfo('1.1.1'), /Not connected/);
  });

  it('programIA rejects when not connected', async () => {
    const bus = new KnxBusManager();
    await assert.rejects(() => bus.programIA('1.1.1'), /Not connected/);
  });

  it('downloadDevice rejects when not connected', async () => {
    const bus = new KnxBusManager();
    await assert.rejects(
      () => bus.downloadDevice('1.1.1', [], null, null, null),
      /Not connected/,
    );
  });
});

describe('KnxBusManager.disconnect', () => {
  it('clears state', () => {
    const bus = new KnxBusManager();
    bus.connected = true;
    bus.host = '192.168.1.1';
    bus.type = 'udp';

    bus.disconnect();

    assert.equal(bus.connected, false);
    assert.equal(bus.host, null);
    assert.equal(bus.type, null);
  });

  it('clears state even if connection.disconnect throws', () => {
    const bus = new KnxBusManager();
    bus.connected = true;
    bus.host = '192.168.1.1';
    bus.type = 'udp';
    bus.connection = {
      disconnect() {
        throw new Error('boom');
      },
    } as any;

    bus.disconnect();

    assert.equal(bus.connected, false);
    assert.equal(bus.connection, null);
  });

  it('disconnect before connect is a no-op', () => {
    const bus = new KnxBusManager();
    bus.disconnect(); // should not throw
    assert.equal(bus.connected, false);
  });
});

describe('KnxBusManager.status', () => {
  it('returns default status', () => {
    const bus = new KnxBusManager();
    const s = bus.status();
    assert.equal(s.connected, false);
    assert.equal(s.type, null);
    assert.equal(s.host, null);
    assert.equal(s.port, 3671);
    assert.equal(s.hasLib, true);
  });
});

describe('KnxBusManager event forwarding', () => {
  it('forwards telegram events with remapper and projectId', () => {
    const bus = new KnxBusManager();
    bus.projectId = 42;
    bus.setRemapper((tg) => ({ ...tg, dst: '0/0/99' }));

    const broadcasted: Array<{
      type: string;
      payload: Record<string, unknown>;
    }> = [];
    bus.broadcast = (type: string, payload: Record<string, unknown>) => {
      broadcasted.push({ type, payload });
    };

    // Create a mock connection with EventEmitter
    const conn = new TestKnxConnection();
    bus.connection = conn;
    bus._attachEvents(conn);

    // Simulate a telegram from the connection
    const fakeTelegram = {
      timestamp: new Date().toISOString(),
      src: '1.1.1',
      dst: '1/0/0',
      type: 'GroupValue_Write',
      raw_value: '01',
      decoded: '1',
      priority: 'low',
    };
    conn.emit('telegram', fakeTelegram);

    assert.equal(broadcasted.length, 1);
    assert.equal(broadcasted[0].type, 'knx:telegram');
    const tg = broadcasted[0].payload.telegram as Record<string, unknown>;
    assert.equal(tg.dst, '0/0/99'); // remapped
    assert.equal(tg.projectId, 42);
  });

  it('forwards disconnect events', () => {
    const bus = new KnxBusManager();
    const broadcasted: string[] = [];
    bus.broadcast = (type: string) => {
      broadcasted.push(type);
    };

    const conn = new TestKnxConnection();
    bus._attachEvents(conn);
    conn.emit('disconnected');

    assert.equal(bus.connected, false);
    assert.ok(broadcasted.includes('knx:disconnected'));
  });

  it('forwards error events', () => {
    const bus = new KnxBusManager();
    const broadcasted: Array<{
      type: string;
      payload: Record<string, unknown>;
    }> = [];
    bus.broadcast = (type: string, payload: Record<string, unknown>) => {
      broadcasted.push({ type, payload });
    };

    const conn = new TestKnxConnection();
    bus._attachEvents(conn);
    conn.emit('error', new Error('socket died'));

    assert.equal(bus.connected, false);
    assert.equal(broadcasted.length, 1);
    assert.equal(broadcasted[0].type, 'knx:error');
    assert.equal(broadcasted[0].payload.error, 'Error: socket died');
  });
});

// ── USB HID round-trip tests ──────────────────────────────────────────────────

import {
  _buildHidReports as buildHidReports,
  _parseHidReport as parseHidReport,
  _parseTransferHeader as parseTransferHeader,
  _PROTO_KNX_TUNNEL as PROTO_KNX_TUNNEL,
  _EMI_ID as EMI_ID,
  _PKT as PKT,
} from '../server/knx-usb.ts';

describe('USB HID: multi-report round-trip', () => {
  it('round-trips a frame that exactly fills one report (61 bytes)', () => {
    // 61 - 8 (header) = 53 bytes body
    const body = Buffer.alloc(53, 0xcc);
    const reports = buildHidReports(PROTO_KNX_TUNNEL, EMI_ID.COMMON, body);
    assert.equal(reports.length, 1);
    assert.equal(reports[0][1] & 0x0f, PKT.START_END);

    const parsed = parseHidReport(reports[0])!;
    assert.equal(parsed.dataLength, 61);
    const hdr = parseTransferHeader(parsed.data)!;
    assert.equal(hdr.bodyLength, 53);
  });

  it('round-trips a frame that needs exactly 2 reports', () => {
    // 62 bytes total frame = needs 2 reports
    // 62 - 8 (header) = 54 bytes body
    const body = Buffer.alloc(54, 0xdd);
    const reports = buildHidReports(PROTO_KNX_TUNNEL, EMI_ID.COMMON, body);
    assert.equal(reports.length, 2);
    assert.equal(reports[0][1] & 0x0f, PKT.START);
    assert.equal(reports[1][1] & 0x0f, PKT.END);

    // Reassemble: first report data + second report data = full frame
    const part1 = parseHidReport(reports[0])!;
    const part2 = parseHidReport(reports[1])!;
    const full = Buffer.concat([part1.data, part2.data]);
    const hdr = parseTransferHeader(full)!;
    assert.equal(hdr.bodyLength, 54);
    assert.equal(hdr.protocolId, PROTO_KNX_TUNNEL);
    assert.equal(hdr.emiId, EMI_ID.COMMON);

    // Verify body content
    const reassembledBody = full.slice(8, 8 + 54);
    assert.deepEqual(reassembledBody, body);
  });

  it('round-trips a large frame needing 3+ reports', () => {
    const body = Buffer.alloc(150, 0xee);
    const reports = buildHidReports(PROTO_KNX_TUNNEL, EMI_ID.COMMON, body);
    assert.ok(
      reports.length >= 3,
      `expected >= 3 reports, got ${reports.length}`,
    );

    // First is START, middle is PARTIAL, last is END
    assert.equal(reports[0][1] & 0x0f, PKT.START);
    for (let i = 1; i < reports.length - 1; i++) {
      assert.equal(reports[i][1] & 0x0f, PKT.PARTIAL);
    }
    assert.equal(reports[reports.length - 1][1] & 0x0f, PKT.END);

    // Reassemble and verify
    const parts = reports.map((r) => parseHidReport(r)!);
    const full = Buffer.concat(parts.map((p) => p.data));
    const hdr = parseTransferHeader(full)!;
    assert.equal(hdr.bodyLength, 150);

    const reassembledBody = full.slice(8, 8 + 150);
    assert.deepEqual(reassembledBody, body);
  });

  it('sequence numbers increment across reports', () => {
    const body = Buffer.alloc(150, 0x00);
    const reports = buildHidReports(PROTO_KNX_TUNNEL, EMI_ID.COMMON, body);

    const seqs = reports.map((r) => parseHidReport(r)!.seq);
    for (let i = 0; i < seqs.length; i++) {
      assert.equal(seqs[i], i + 1);
    }
  });
});
