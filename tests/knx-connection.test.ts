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
  apduGroup,
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
  // Separate from `sent` - real KNXnet/IP Routing (multicast) is a genuinely
  // different channel from Tunneling, used specifically by the KNX "System
  // Broadcast" services (checkProgrammingMode, serial-number addressing) -
  // see docs/knx-device-write-protocol.md §9. `_routingAvailable` lets a test
  // opt into the base class's default-throw behavior instead (simulating a
  // connection with no Routing capability) by setting it false.
  sentViaRouting: Buffer[] = [];
  _routingAvailable = true;
  disconnected = false;

  sendCEMI(cemi: Buffer): Promise<void> {
    this.sent.push(cemi);
    return Promise.resolve();
  }

  sendCEMIViaRouting(cemi: Buffer): Promise<void> {
    if (!this._routingAvailable) return super.sendCEMIViaRouting(cemi);
    this.sentViaRouting.push(cemi);
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

// ── KnxConnection.sendCEMIViaRouting (default) ────────────────────────────────
// The base class has no Routing capability (only KnxIpConnection in
// knx-protocol.ts overrides this) - see docs/knx-device-write-protocol.md §9.

describe('KnxConnection.sendCEMIViaRouting (base class default)', () => {
  it('throws - no Routing capability without an IP transport override', () => {
    // Synchronous throw, same shape as sendCEMI()'s own base-class default
    // - not a rejected promise.
    const conn = new TestKnxConnection();
    conn._routingAvailable = false; // fall through to the real base-class default
    assert.throws(
      () => conn.sendCEMIViaRouting(Buffer.from([0x29])),
      /Routing/,
    );
  });
});

describe('KnxConnection.programIA', () => {
  it('sends physical address write and returns result', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const result = await conn.programIA('1.1.5');
    assert.deepEqual(result, { ok: true, newAddr: '1.1.5' });
    assert.equal(conn.sent.length, 1);

    // Same confirmed-correct wire format as every other network-management
    // broadcast service in this family (see checkProgrammingMode() etc.):
    // GROUP-type frame to 0/0/0 at System priority (ctrl1=0xb0) - not an
    // individual-type frame to 0.0.0 at ordinary priority, which a real
    // device silently never accepted (found live, 2026-08-30).
    const parsed = parseCEMI(conn.sent[0]!);
    assert.ok(parsed);
    assert.equal(parsed.dst, '0/0/0');
    assert.equal(parsed.isGroup, true);
    assert.equal(conn.sent[0]![2], 0xb0);
  });

  it('throws when not connected', async () => {
    const conn = new TestKnxConnection();
    conn.connected = false;

    await assert.rejects(() => conn.programIA('1.1.5'), {
      message: 'Not connected',
    });
  });
});

// ── KnxConnection.checkProgrammingMode ────────────────────────────────────────
// A_IndividualAddress_Read broadcast discovery - see
// docs/knx-device-write-protocol.md §9. These tests cover the
// application-layer behavior only (frame shape, response matching,
// timeout) - the same protocol-shape-only coverage every other broadcast
// service in this file gets.

describe('KnxConnection.checkProgrammingMode', () => {
  it('sends a GROUP-type A_IndividualAddress_Read to 0/0/0 at System priority', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const p = conn.checkProgrammingMode(50);
    await delay(10);
    // Sent via the normal Tunneling connection, GROUP-type to 0/0/0 -
    // confirmed byte-for-byte against real ETS traffic (see
    // docs/knx-device-write-protocol.md §9).
    assert.equal(conn.sent.length, 1);
    const parsed = parseCEMI(conn.sent[0]!);
    assert.ok(parsed);
    assert.equal(parsed.dst, '0/0/0');
    assert.equal(parsed.isGroup, true);
    assert.equal(parsed.apciName, 'PhysicalAddress_Read');
    assert.equal(conn.sent[0]![2], 0xb0); // ordinary broadcast, System priority
    await p; // let the timeout settle so the test doesn't leave a dangling timer
  });

  it('resolves with the responding device address on a real reply', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const p = conn.checkProgrammingMode(500);
    const raw = buildCEMI('1.1.20', '0.0.0', apduGroup('PhysicalAddress_Response'), false);
    conn.simulateMgmtFrame(parseCEMI(raw)!);

    const result = await p;
    assert.deepEqual(result, { address: '1.1.20' });
  });

  it('resolves with null address on timeout when nothing answers', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const result = await conn.checkProgrammingMode(50);
    assert.deepEqual(result, { address: null });
  });

  it('ignores unrelated _mgmt frames and keeps waiting', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const p = conn.checkProgrammingMode(200);
    const unrelated = buildCEMI('1.1.5', '1.0.1', apduGroupRead(), false);
    conn.simulateMgmtFrame(parseCEMI(unrelated)!);

    const result = await p;
    assert.deepEqual(result, { address: null });
  });

  it('throws when not connected', () => {
    const conn = new TestKnxConnection();
    conn.connected = false;
    assert.throws(() => conn.checkProgrammingMode(), /Not connected/);
  });
});

// ── KnxConnection.readSerialNumbersInProgrammingMode ──────────────────────────
// NM_Read_SerialNumber_By_ProgrammingMode - confirmed byte-for-byte against
// real ETS traffic (tshark capture, 2026-08-30, see
// docs/knx-device-write-protocol.md §9): A_SystemNetworkParameter_
// Read/Response for PID_SERIAL_NUMBER (11) on object type 0 (Device),
// GROUP-type frame to 0/0/0 at System priority, response payload
// [objectType(2)][pidField(2)][echoedOperand(1)][serial(6)].

describe('KnxConnection.readSerialNumbersInProgrammingMode', () => {
  it('sends a GROUP-type A_SystemNetworkParameter_Read to 0/0/0 at System priority', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const p = conn.readSerialNumbersInProgrammingMode(50);
    await delay(10);
    assert.equal(conn.sent.length, 1);
    const parsed = parseCEMI(conn.sent[0]!);
    assert.ok(parsed);
    assert.equal(parsed.dst, '0/0/0');
    assert.equal(parsed.isGroup, true);
    assert.equal(conn.sent[0]![2], 0xb0); // ordinary broadcast, System priority
    // fullApci 0x1C8 (SystemNetworkParam_Read), objType=0, pid=11<<4=0xB0, operand=1
    assert.deepEqual(
      [...parsed.apdu.slice(0, 7)],
      [0x01, 0xc8, 0x00, 0x00, 0x00, 0xb0, 0x01],
    );
    await p;
  });

  it('collects a real device reply, using the byte after the echoed operand as the serial', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const p = conn.readSerialNumbersInProgrammingMode(50);
    // Real captured shape: [objType(2)=0000][pidField(2)=00b0][echoedOperand=01][serial(6)]
    const apduData = Buffer.from([
      0x00, 0x00, 0x00, 0xb0, 0x01, 0x00, 0x0a, 0x57, 0x82, 0x04, 0x19,
    ]);
    const apdu = Buffer.concat([Buffer.from([0x01, 0xc9]), apduData]);
    conn.simulateMgmtFrame({
      msgCode: 0x29,
      src: '15.15.255',
      dst: '0/0/0',
      isGroup: true,
      apciIdx: null,
      apciName: 'OTHER',
      apduData,
      apdu,
      tpciType: 'DATA_GROUP',
    });

    const result = await p;
    assert.deepEqual(result, [{ serial: '000a57820419', src: '15.15.255' }]);
  });

  it('collects multiple distinct devices within the window (no collision, per real testing)', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const p = conn.readSerialNumbersInProgrammingMode(50);
    const makeApdu = (serial: number[]): { apdu: Buffer; apduData: Buffer } => {
      const apduData = Buffer.from([0x00, 0x00, 0x00, 0xb0, 0x01, ...serial]);
      return { apduData, apdu: Buffer.concat([Buffer.from([0x01, 0xc9]), apduData]) };
    };
    const a = makeApdu([0x00, 0x0a, 0x57, 0x82, 0x04, 0x19]);
    const b = makeApdu([0x00, 0x73, 0x3c, 0x00, 0x5b, 0x42]);
    conn.simulateMgmtFrame({
      msgCode: 0x29,
      src: '15.15.255',
      dst: '0/0/0',
      isGroup: true,
      apciIdx: null,
      apciName: 'OTHER',
      apduData: a.apduData,
      apdu: a.apdu,
      tpciType: 'DATA_GROUP',
    });
    conn.simulateMgmtFrame({
      msgCode: 0x29,
      src: '15.15.255',
      dst: '0/0/0',
      isGroup: true,
      apciIdx: null,
      apciName: 'OTHER',
      apduData: b.apduData,
      apdu: b.apdu,
      tpciType: 'DATA_GROUP',
    });

    const result = await p;
    const serials = result.map((r) => r.serial).sort();
    assert.deepEqual(serials, ['000a57820419', '00733c005b42'].sort());
  });

  it('de-duplicates repeated replies from the same device (normal KNX frame repetition)', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';

    const p = conn.readSerialNumbersInProgrammingMode(50);
    const apduData = Buffer.from([
      0x00, 0x00, 0x00, 0xb0, 0x01, 0x00, 0x0a, 0x57, 0x82, 0x04, 0x19,
    ]);
    const apdu = Buffer.concat([Buffer.from([0x01, 0xc9]), apduData]);
    for (let i = 0; i < 2; i++) {
      conn.simulateMgmtFrame({
        msgCode: 0x29,
        src: '15.15.255',
        dst: '0/0/0',
        isGroup: true,
        apciIdx: null,
        apciName: 'OTHER',
        apduData,
        apdu,
        tpciType: 'DATA_GROUP',
      });
    }

    const result = await p;
    assert.equal(result.length, 1);
  });

  it('resolves with an empty array on timeout when nothing answers', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';
    const result = await conn.readSerialNumbersInProgrammingMode(50);
    assert.deepEqual(result, []);
  });

  it('throws when not connected', () => {
    const conn = new TestKnxConnection();
    conn.connected = false;
    assert.throws(
      () => conn.readSerialNumbersInProgrammingMode(),
      /Not connected/,
    );
  });
});

// ── KnxConnection: individual address by serial number ───────────────────────
// NM_IndividualAddress_SerialNumber_Write/_Read (spec 3/5/2 §2.5/§2.4) - see
// docs/knx-device-write-protocol.md §9. No real-hardware capture
// backs this yet - these tests only cover the protocol-level shape (frame
// addressing, system-broadcast priority bit, response matching by serial,
// not by source address).

describe('KnxConnection.writeIndividualAddressBySerial', () => {
  it('sends a GROUP-type frame to 0/0/0 at System priority', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';
    const serial = Buffer.from([0x00, 0xa6, 0x25, 0x40, 0x1d, 0x94]);

    const result = await conn.writeIndividualAddressBySerial(serial, '1.1.20');
    assert.deepEqual(result, { ok: true });
    // Sent via the normal Tunneling connection, GROUP-type to 0/0/0 -
    // confirmed byte-for-byte against real ETS traffic, 2026-08-30 (see
    // docs/knx-device-write-protocol.md §9).
    assert.equal(conn.sent.length, 1);

    const parsed = parseCEMI(conn.sent[0]!);
    assert.ok(parsed);
    assert.equal(parsed.dst, '0/0/0');
    assert.equal(parsed.isGroup, true);
    // ctrl1 (byte 2): ordinary broadcast + System priority (0xB0), not
    // the plain 0xBC every other frame this codebase builds uses.
    assert.equal(conn.sent[0]![2], 0xb0);
  });

  it('throws when not connected', async () => {
    const conn = new TestKnxConnection();
    conn.connected = false;
    await assert.rejects(
      () =>
        conn.writeIndividualAddressBySerial(Buffer.alloc(6), '1.1.20'),
      { message: 'Not connected' },
    );
  });
});

describe('KnxConnection.readIndividualAddressBySerial', () => {
  it('resolves with the address from a matching broadcast reply', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';
    const serial = Buffer.from([0x00, 0xa6, 0x25, 0x40, 0x1d, 0x94]);

    const p = conn.readIndividualAddressBySerial(serial, 500);
    // Simulate the device's real broadcast reply: [serial(6)][4 reserved
    // zero bytes] - confirmed real payload shape (no address field at
    // all), src carries the device's address instead. Matched by serial
    // rather than by a known source address (unknown ahead of time) -
    // see docs/knx-device-write-protocol.md §9.
    const apduData = Buffer.concat([serial, Buffer.alloc(4)]);
    const apdu = Buffer.concat([
      Buffer.from([0x03, 0xdd & 0xff]), // TPCI=DATA_GROUP + full APCI 0x3DD
      apduData,
    ]);
    conn.simulateMgmtFrame({
      msgCode: 0x29,
      src: '1.1.20',
      dst: '0/0/0',
      isGroup: true,
      apciIdx: null,
      apciName: 'OTHER',
      apduData,
      apdu,
      tpciType: 'DATA_GROUP',
    });

    const result = await p;
    assert.deepEqual(result, { address: '1.1.20' });
  });

  it('ignores a reply for a different serial number and eventually times out', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';
    const serial = Buffer.from([0x00, 0xa6, 0x25, 0x40, 0x1d, 0x94]);
    const otherSerial = Buffer.from([0x00, 0xa6, 0x25, 0x40, 0x1d, 0x95]);

    const p = conn.readIndividualAddressBySerial(serial, 50);
    const apduData = Buffer.concat([otherSerial, Buffer.alloc(4)]);
    const apdu = Buffer.concat([Buffer.from([0x03, 0xdd]), apduData]);
    conn.simulateMgmtFrame({
      msgCode: 0x29,
      src: '1.1.21',
      dst: '0/0/0',
      isGroup: true,
      apciIdx: null,
      apciName: 'OTHER',
      apduData,
      apdu,
      tpciType: 'DATA_GROUP',
    });

    const result = await p;
    assert.equal(result, null);
  });

  it('throws when not connected', () => {
    // Synchronous throw, same shape as read()/write() above - the
    // connected-check runs before the `new Promise(...)` is even
    // constructed, so it's a plain thrown error, not a rejected promise.
    const conn = new TestKnxConnection();
    conn.connected = false;
    assert.throws(
      () => conn.readIndividualAddressBySerial(Buffer.alloc(6)),
      /Not connected/,
    );
  });
});

describe('KnxConnection.assignIndividualAddressBySerial', () => {
  it('writes then reads back to verify', async () => {
    const conn = new TestKnxConnection();
    conn.connected = true;
    conn.localAddr = '1.0.1';
    const serial = Buffer.from([0x00, 0xa6, 0x25, 0x40, 0x1d, 0x94]);

    const assignP = conn.assignIndividualAddressBySerial(serial, '1.1.20', 500);
    // Let the Write's sendCEMI (a resolved promise) settle before the Read
    // is issued, then answer the Read.
    await delay(10);
    // [serial(6)][4 reserved zero bytes] - confirmed real payload shape,
    // src carries the device's (newly-assigned) address instead - see
    // docs/knx-device-write-protocol.md §9.
    const apduData = Buffer.concat([serial, Buffer.alloc(4)]);
    const apdu = Buffer.concat([Buffer.from([0x03, 0xdd]), apduData]);
    conn.simulateMgmtFrame({
      msgCode: 0x29,
      src: '1.1.20',
      dst: '0/0/0',
      isGroup: true,
      apciIdx: null,
      apciName: 'OTHER',
      apduData,
      apdu,
      tpciType: 'DATA_GROUP',
    });

    const result = await assignP;
    assert.deepEqual(result, { ok: true, verified: true, address: '1.1.20' });
    // Both via the normal Tunneling connection, GROUP-type to 0/0/0 -
    // confirmed byte-for-byte against real ETS traffic, 2026-08-30.
    assert.equal(conn.sent.length, 2); // Write, then Read
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

    // 25 bytes of param memory - well under MEM_CHUNK (228, see
    // knx-connection.ts's own comment), so this exercises the single-chunk
    // path; the dedicated boundary-straddle test in
    // relmem-write-protocol.test.ts covers the real multi-chunk case.
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
  it('write rejects when not connected', async () => {
    const bus = new KnxBusManager();
    await assert.rejects(() => bus.write('1/0/0', true), /Not connected/);
  });

  it('read rejects when not connected', async () => {
    const bus = new KnxBusManager();
    await assert.rejects(() => bus.read('1/0/0'), /Not connected/);
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

describe('KnxBusManager._ensureConnected', () => {
  it('reconnects using the last known host/port/type when idle-dropped', async () => {
    const bus = new KnxBusManager();
    bus.host = '10.0.0.5';
    bus.port = 3671;
    bus.type = 'tcp';
    bus.connected = false;
    bus.connection = null;

    let connectCalls = 0;
    bus.connect = (async (
      host: string,
      port: number,
      _projectId?: number | string | null,
      protocol?: string,
    ) => {
      connectCalls++;
      assert.equal(host, '10.0.0.5');
      assert.equal(port, 3671);
      assert.equal(protocol, 'tcp');
      bus.connected = true;
      bus.connection = {} as any;
      return { host, port, type: 'tcp' as const };
    }) as any;

    await bus._ensureConnected();
    assert.equal(connectCalls, 1);
    assert.equal(bus.connected, true);
  });

  it('does not reconnect if already connected', async () => {
    const bus = new KnxBusManager();
    bus.connected = true;
    bus.connection = {} as any;
    let connectCalls = 0;
    bus.connect = (async () => {
      connectCalls++;
      return { host: '', port: 0, type: 'tcp' as const };
    }) as any;

    await bus._ensureConnected();
    assert.equal(connectCalls, 0);
  });

  it('rejects without attempting reconnect when no host is known', async () => {
    const bus = new KnxBusManager();
    bus.connected = false;
    bus.host = null;
    let connectCalls = 0;
    bus.connect = (async () => {
      connectCalls++;
      return { host: '', port: 0, type: 'tcp' as const };
    }) as any;

    await assert.rejects(() => bus._ensureConnected(), /Not connected/);
    assert.equal(connectCalls, 0);
  });

  it('rejects without attempting reconnect for USB connections', async () => {
    const bus = new KnxBusManager();
    bus.connected = false;
    bus.host = null;
    bus.type = 'usb';
    let connectCalls = 0;
    bus.connect = (async () => {
      connectCalls++;
      return { host: '', port: 0, type: 'tcp' as const };
    }) as any;

    await assert.rejects(() => bus._ensureConnected(), /Not connected/);
    assert.equal(connectCalls, 0);
  });

  it('coalesces concurrent reconnect attempts into a single connect() call', async () => {
    const bus = new KnxBusManager();
    bus.host = '10.0.0.5';
    bus.port = 3671;
    bus.type = 'tcp';
    bus.connected = false;

    let connectCalls = 0;
    bus.connect = (async (host: string, port: number) => {
      connectCalls++;
      await new Promise((r) => setTimeout(r, 10));
      bus.connected = true;
      bus.connection = {} as any;
      return { host, port, type: 'tcp' as const };
    }) as any;

    await Promise.all([
      bus._ensureConnected(),
      bus._ensureConnected(),
      bus._ensureConnected(),
    ]);
    assert.equal(connectCalls, 1);
  });

  it('broadcasts knx:reconnect-failed on a real failure by default', async () => {
    // Real request 2026-08-31: lets the connection badge distinguish a
    // calm "not connected" idle state from a genuine "needs manual
    // attention" one. Every real bus route calls _ensureConnected() with
    // no arguments, so the default must broadcast.
    const bus = new KnxBusManager();
    bus.host = '10.0.0.5';
    bus.port = 3671;
    bus.type = 'tcp';
    bus.connected = false;
    bus.connect = (async () => {
      throw new Error('ECONNREFUSED');
    }) as any;

    const broadcasts: Array<{ type: string; payload: unknown }> = [];
    bus.broadcast = (type: string, payload: Record<string, unknown>) => {
      broadcasts.push({ type, payload });
    };

    await assert.rejects(() => bus._ensureConnected(), /ECONNREFUSED/);
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0]!.type, 'knx:reconnect-failed');
  });

  it('does not broadcast when called with broadcastFailure=false', async () => {
    // _autoReconnect() passes false for its own intermediate retries - a
    // single attempt failing mid-backoff isn't yet "exhausted" and
    // shouldn't flip the badge to "needs attention" prematurely.
    const bus = new KnxBusManager();
    bus.host = '10.0.0.5';
    bus.port = 3671;
    bus.type = 'tcp';
    bus.connected = false;
    bus.connect = (async () => {
      throw new Error('ECONNREFUSED');
    }) as any;

    const broadcasts: Array<{ type: string; payload: unknown }> = [];
    bus.broadcast = (type: string, payload: Record<string, unknown>) => {
      broadcasts.push({ type, payload });
    };

    await assert.rejects(() => bus._ensureConnected(false), /ECONNREFUSED/);
    assert.equal(broadcasts.length, 0);
  });
});

describe('KnxBusManager.forceReconnect', () => {
  it('reconnects using the last known host/port/type even while already connected', async () => {
    // Real request 2026-08-31, after a real live failure (a Verify that
    // started right after an idle-drop-and-reconnect still failed - the
    // request had already gone out on the dying connection). Unlike
    // _ensureConnected(), this must reconnect even when `connected` is
    // already true - that's the whole point.
    const bus = new KnxBusManager();
    bus.host = '10.0.0.5';
    bus.port = 3671;
    bus.type = 'tcp';
    bus.connected = true;
    bus.connection = {} as any;

    let connectCalls = 0;
    bus.connect = (async (
      host: string,
      port: number,
      _projectId?: number | string | null,
      protocol?: string,
    ) => {
      connectCalls++;
      assert.equal(host, '10.0.0.5');
      assert.equal(port, 3671);
      assert.equal(protocol, 'tcp');
      bus.connected = true;
      bus.connection = {} as any;
      return { host, port, type: 'tcp' as const };
    }) as any;

    await bus.forceReconnect();
    assert.equal(connectCalls, 1, 'connect() is called even though already connected');
  });

  it('is a no-op when never connected at all (no known host)', async () => {
    const bus = new KnxBusManager();
    bus.connected = false;
    bus.host = null;
    let connectCalls = 0;
    bus.connect = (async () => {
      connectCalls++;
      return { host: '', port: 0, type: 'tcp' as const };
    }) as any;

    await bus.forceReconnect();
    assert.equal(connectCalls, 0);
  });

  it('is a no-op for USB connections', async () => {
    const bus = new KnxBusManager();
    bus.connected = true;
    bus.host = null;
    bus.type = 'usb';
    let connectCalls = 0;
    bus.connect = (async () => {
      connectCalls++;
      return { host: '', port: 0, type: 'tcp' as const };
    }) as any;

    await bus.forceReconnect();
    assert.equal(connectCalls, 0);
  });

  it('propagates a real connection failure to the caller', async () => {
    const bus = new KnxBusManager();
    bus.host = '10.0.0.5';
    bus.port = 3671;
    bus.type = 'tcp';
    bus.connected = true;
    bus.connection = {} as any;
    bus.connect = (async () => {
      throw new Error('ECONNREFUSED');
    }) as any;

    await assert.rejects(() => bus.forceReconnect(), /ECONNREFUSED/);
  });

  it('broadcasts knx:reconnect-failed on a real failure', async () => {
    // forceReconnect() bypasses _ensureConnected() entirely (calls
    // connect() directly), so it needs its own broadcast on failure -
    // otherwise a Program/Verify's own forced reconnect failing would
    // never surface on the connection badge at all.
    const bus = new KnxBusManager();
    bus.host = '10.0.0.5';
    bus.port = 3671;
    bus.type = 'tcp';
    bus.connected = true;
    bus.connection = {} as any;
    bus.connect = (async () => {
      throw new Error('ECONNREFUSED');
    }) as any;

    const broadcasts: Array<{ type: string; payload: unknown }> = [];
    bus.broadcast = (type: string, payload: Record<string, unknown>) => {
      broadcasts.push({ type, payload });
    };

    await assert.rejects(() => bus.forceReconnect(), /ECONNREFUSED/);
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0]!.type, 'knx:reconnect-failed');
  });
});

describe('KnxBusManager._autoReconnect', () => {
  it('reconnects immediately on first attempt while a keep-alive ref is held', async () => {
    const bus = new KnxBusManager();
    bus.host = '10.0.0.5';
    bus.port = 3671;
    bus.type = 'tcp';
    bus.connected = false;
    bus.addKeepAliveRef();

    let connectCalls = 0;
    bus.connect = (async (host: string, port: number) => {
      connectCalls++;
      bus.connected = true;
      bus.connection = {} as any;
      return { host, port, type: 'tcp' as const };
    }) as any;

    bus._autoReconnect();
    // _autoReconnect is fire-and-forget; let its promise chain settle.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(connectCalls, 1);
    assert.equal(bus.connected, true);
  });

  it('does nothing when no keep-alive ref is held, even with a known host', async () => {
    const bus = new KnxBusManager();
    bus.host = '10.0.0.5';
    bus.port = 3671;
    bus.type = 'tcp';
    bus.connected = false;
    // No addKeepAliveRef() call - nothing has registered interest in a
    // proactive reconnect (e.g. no Monitor view open, no download running).

    let connectCalls = 0;
    bus.connect = (async () => {
      connectCalls++;
      return { host: '', port: 0, type: 'tcp' as const };
    }) as any;

    bus._autoReconnect();
    await new Promise((r) => setImmediate(r));

    assert.equal(connectCalls, 0);
  });

  it('stops retrying once the last keep-alive ref is released mid-backoff', async () => {
    const bus = new KnxBusManager();
    bus.host = '10.0.0.5';
    bus.port = 3671;
    bus.type = 'tcp';
    bus.connected = false;
    const release = bus.addKeepAliveRef();

    let connectCalls = 0;
    bus.connect = (async () => {
      connectCalls++;
      throw new Error('gateway unreachable');
    }) as any;

    const realSetTimeout = globalThis.setTimeout;
    const scheduled: Array<() => void> = [];
    (globalThis as any).setTimeout = ((fn: () => void, _ms: number) => {
      scheduled.push(fn);
      return 0 as any;
    }) as any;
    try {
      bus._autoReconnect();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      assert.equal(connectCalls, 1);
      assert.equal(scheduled.length, 1);

      // e.g. the Monitor view unmounted before the scheduled retry fires.
      release();
      const next = scheduled.shift()!;
      next();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    assert.equal(connectCalls, 1);
    assert.equal(scheduled.length, 0);
  });

  it('does nothing for USB connections', async () => {
    const bus = new KnxBusManager();
    bus.host = null;
    bus.type = 'usb';
    bus.connected = false;
    bus.addKeepAliveRef();

    let connectCalls = 0;
    bus.connect = (async () => {
      connectCalls++;
      return { host: '', port: 0, type: 'tcp' as const };
    }) as any;

    bus._autoReconnect();
    await new Promise((r) => setImmediate(r));

    assert.equal(connectCalls, 0);
  });

  it('retries with backoff on failure, up to a bounded number of attempts', async () => {
    const bus = new KnxBusManager();
    bus.host = '10.0.0.5';
    bus.port = 3671;
    bus.type = 'tcp';
    bus.connected = false;
    bus.addKeepAliveRef();

    let connectCalls = 0;
    bus.connect = (async () => {
      connectCalls++;
      throw new Error('gateway unreachable');
    }) as any;

    // Intercept setTimeout so the retry schedule advances instantly
    // instead of waiting through real backoff delays.
    const realSetTimeout = globalThis.setTimeout;
    const scheduled: Array<() => void> = [];
    (globalThis as any).setTimeout = ((fn: () => void, _ms: number) => {
      scheduled.push(fn);
      return 0 as any;
    }) as any;
    try {
      bus._autoReconnect();
      // Drain the retry chain: each failed attempt schedules exactly one
      // more retry via the stubbed setTimeout, up to maxAttempts (5).
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        const next = scheduled.shift();
        if (next) next();
      }
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    assert.equal(connectCalls, 5);
    assert.equal(scheduled.length, 0);
  });

  it('stops retrying once an explicit disconnect clears the host', async () => {
    const bus = new KnxBusManager();
    bus.host = '10.0.0.5';
    bus.port = 3671;
    bus.type = 'tcp';
    bus.connected = false;
    bus.addKeepAliveRef();

    let connectCalls = 0;
    bus.connect = (async () => {
      connectCalls++;
      throw new Error('gateway unreachable');
    }) as any;

    const realSetTimeout = globalThis.setTimeout;
    const scheduled: Array<() => void> = [];
    (globalThis as any).setTimeout = ((fn: () => void, _ms: number) => {
      scheduled.push(fn);
      return 0 as any;
    }) as any;
    try {
      bus._autoReconnect();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      assert.equal(connectCalls, 1);
      assert.equal(scheduled.length, 1);

      // Simulate the user disconnecting before the scheduled retry fires.
      bus.host = null;
      const next = scheduled.shift()!;
      next();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    // The retry re-checks host/type before calling connect() again.
    assert.equal(connectCalls, 1);
    assert.equal(scheduled.length, 0);
  });

  it('broadcasts knx:reconnect-failed only once retries are genuinely exhausted', async () => {
    // Real request 2026-08-31: a single attempt failing mid-backoff isn't
    // "exhausted" - the badge should stay calm/idle through the retry
    // sequence, only escalating to "needs attention" once every attempt
    // has failed. Drives all 5 real attempts (maxAttempts in
    // _autoReconnect) by manually firing each scheduled retry.
    const bus = new KnxBusManager();
    bus.host = '10.0.0.5';
    bus.port = 3671;
    bus.type = 'tcp';
    bus.connected = false;
    bus.addKeepAliveRef();

    bus.connect = (async () => {
      throw new Error('gateway unreachable');
    }) as any;

    const broadcasts: Array<{ type: string; payload: unknown }> = [];
    bus.broadcast = (type: string, payload: Record<string, unknown>) => {
      broadcasts.push({ type, payload });
    };

    const realSetTimeout = globalThis.setTimeout;
    const scheduled: Array<() => void> = [];
    (globalThis as any).setTimeout = ((fn: () => void, _ms: number) => {
      scheduled.push(fn);
      return 0 as any;
    }) as any;
    try {
      bus._autoReconnect();
      await new Promise((r) => setImmediate(r));
      // Attempts 1-4 each schedule a retry and broadcast nothing.
      for (let i = 0; i < 4; i++) {
        assert.equal(broadcasts.length, 0, `no broadcast yet after attempt ${i + 1}`);
        const next = scheduled.shift()!;
        next();
        await new Promise((r) => setImmediate(r));
      }
      // The 5th (final) attempt exhausts maxAttempts and broadcasts once.
      assert.equal(scheduled.length, 0);
      assert.equal(broadcasts.length, 1);
      assert.equal(broadcasts[0]!.type, 'knx:reconnect-failed');
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });
});

describe('KnxBusManager.addKeepAliveRef', () => {
  it('ref-counts and only reaches zero once every release() is called', () => {
    const bus = new KnxBusManager();
    assert.equal(bus._keepAliveRefs, 0);

    const releaseA = bus.addKeepAliveRef();
    const releaseB = bus.addKeepAliveRef();
    assert.equal(bus._keepAliveRefs, 2);

    releaseA();
    assert.equal(bus._keepAliveRefs, 1);

    releaseB();
    assert.equal(bus._keepAliveRefs, 0);
  });

  it('is idempotent - calling the same release() twice does not underflow', () => {
    const bus = new KnxBusManager();
    const release = bus.addKeepAliveRef();
    release();
    release();
    assert.equal(bus._keepAliveRefs, 0);
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

  it('does not proactively reconnect on disconnect without a keep-alive ref', async () => {
    const bus = new KnxBusManager();
    bus.host = '10.0.0.5';
    bus.type = 'tcp';
    bus.broadcast = () => {};
    let connectCalls = 0;
    bus.connect = (async () => {
      connectCalls++;
      return { host: '', port: 0, type: 'tcp' as const };
    }) as any;

    const conn = new TestKnxConnection();
    bus._attachEvents(conn);
    conn.emit('disconnected');
    await new Promise((r) => setImmediate(r));

    assert.equal(connectCalls, 0);
  });

  it('proactively reconnects on disconnect while a keep-alive ref is held', async () => {
    const bus = new KnxBusManager();
    bus.host = '10.0.0.5';
    bus.type = 'tcp';
    bus.broadcast = () => {};
    bus.addKeepAliveRef();
    let connectCalls = 0;
    bus.connect = (async (host: string, port: number) => {
      connectCalls++;
      bus.connected = true;
      bus.connection = {} as any;
      return { host, port, type: 'tcp' as const };
    }) as any;

    const conn = new TestKnxConnection();
    bus._attachEvents(conn);
    conn.emit('disconnected');
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(connectCalls, 1);
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

describe('KnxBusManager.broadcast', () => {
  it('preserves the message-kind discriminator even when the payload has its own `type` field', () => {
    const bus = new KnxBusManager();
    const sent: Array<{ readyState: number; data?: string }> = [];
    const client = {
      readyState: 1,
      send(data: string) {
        sent.push({ readyState: 1, data });
      },
    };
    bus.attachWSS({ clients: new Set([client]) } as any);

    // A payload field literally named `type` (e.g. a connection's
    // transport, 'tcp') must not collide with and overwrite the outer
    // message-kind discriminator the client dispatches on.
    bus.broadcast('knx:connected', { host: '10.0.0.5', type: 'tcp' });

    assert.equal(sent.length, 1);
    const parsed = JSON.parse(sent[0]!.data!);
    assert.equal(parsed.type, 'knx:connected');
  });

  it("connect()'s knx:connected broadcast carries the transport under connectionType, not type", async () => {
    const bus = new KnxBusManager();
    const sent: string[] = [];
    bus.attachWSS({
      clients: new Set([
        {
          readyState: 1,
          send(data: string) {
            sent.push(data);
          },
        },
      ]),
    } as any);

    // KnxBusManager.connect() constructs its own KnxIpConnection instance
    // internally (no dependency injection) - patch the shared prototype's
    // connect() so that instance resolves to a fake, network-free
    // implementation instead of attempting a real socket connection.
    const knxProtocol = await import('../server/knx-protocol.ts');
    const proto = (knxProtocol.KnxConnection as any).prototype;
    const realConnect = proto.connect;
    proto.connect = async function (this: any) {
      this.transport = 'tcp';
    };

    try {
      await bus.connect('10.0.0.5', 3671, 1, 'tcp');
    } finally {
      proto.connect = realConnect;
    }

    const connectedMsg = sent
      .map((s) => JSON.parse(s))
      .find((m) => m.type === 'knx:connected');
    assert.ok(connectedMsg, 'a knx:connected message was broadcast');
    assert.equal(connectedMsg.connectionType, 'tcp');
    assert.equal(connectedMsg.host, '10.0.0.5');
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
