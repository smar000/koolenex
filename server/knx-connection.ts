/**
 * KnxConnection — base class for KNX bus communication.
 * Contains all shared protocol logic (CEMI, APDU, management sessions, etc.)
 * Transport-specific subclasses (UDP, USB) implement sendCEMI() and connect/disconnect.
 */

import EventEmitter from 'events';
import { logger } from './log.ts';
import { decodeDptBuffer } from './knx-dpt.ts';
import {
  buildCEMI,
  TPCI,
  APCI_EXT,
  apduGroup,
  apduGroupRead,
  apduGroupWrite,
  apduConnected,
  apduControl,
  apduMemoryRead,
  parseMemoryResponse,
  apduMemoryExtendedRead,
  apduMemoryExtendedWrite,
  parseMemoryExtendedResponse,
  apduPropertyValueWrite,
  apduPropertyValueRead,
  apduAuthorizeRequest,
  apduIndividualAddressSerialNumberWrite,
  apduIndividualAddressSerialNumberRead,
  parseIndividualAddressSerialNumberResponse,
  apduSystemNetworkParamRead,
  parseSystemNetworkParamResponse,
  encodePhysical,
  eventType,
  type CemiFrame,
} from './knx-cemi.ts';
import {
  planDownload,
  isAbsSegmentProcedure,
  type PlanStep,
  type AbsSegSeed,
} from './knx-download-plan.ts';

// Re-export from knx-dpt.ts
export { encodeDpt, decodeDptBuffer } from './knx-dpt.ts';

// Re-export from knx-cemi.ts
export {
  MC,
  APCI_EXT,
  buildCEMI,
  parseCEMI,
  encodePhysical,
  decodePhysical,
  encodeGroup,
  decodeGroup,
  apduGroup,
  apduConnected,
  apduConnectedFull,
  apduPropertyValueWrite,
  apduPropertyValueRead,
  apduControl,
  apduIndividualAddressSerialNumberWrite,
  apduIndividualAddressSerialNumberRead,
  parseIndividualAddressSerialNumberResponse,
  apduSystemNetworkParamRead,
  parseSystemNetworkParamResponse,
  eventType,
} from './knx-cemi.ts';
export type {
  CemiFrame,
  IndividualAddressSerialNumberResponse,
  SystemNetworkParamResponse,
} from './knx-cemi.ts';
export {
  _apduGroupRead,
  _apduGroupWrite,
  _apduGroupResponse,
  _apduControl,
  _apduPropertyValueRead,
  _apduPropertyValueWrite,
  _TPCI,
  _APCI,
} from './knx-cemi.ts';

// ── Telegram type ──────────────────────────────────────────────────────────────

interface Telegram {
  timestamp: string;
  src: string;
  dst: string;
  type: string;
  raw_value: string;
  decoded: string;
  priority: string;
}

// ── Download step type ─────────────────────────────────────────────────────────

export interface DownloadStep {
  type: string;
  objIdx: number;
  propId: number;
  data?: Buffer;
  size?: number;
  offset?: number;
  // RelSegment (ABB/System-7-style) fields — see the RelSegment/WriteRelMem
  // handling in downloadDevice() below. mode is a comma-joined string when
  // a segment has both "full" and "par" RelSegment declarations for the
  // same lsmIdx (e.g. "full,par" on the WriteRelMem step); fill is the
  // segment's declared fill byte.
  mode?: string;
  fill?: number;
  // AbsoluteSegment (MDT-style) load-procedure fields — see knx-download-plan.ts
  lsmIdx?: number;
  address?: number;
}

export interface DownloadProgress {
  msg: string;
  pct?: number;
  done?: boolean;
  // Real request, 2026-08-31: a dedicated "press the button" modal on the
  // client (Cancel-only, auto-dismisses once the wait resolves) needs a
  // reliable way to tell THIS specific progress message apart from every
  // other one - see /bus/program-device's own pre-flight, server/routes/
  // bus.ts. Only ever true on the single message announcing the wait;
  // every subsequent message (found, ambiguous, written, confirmed, or a
  // real error) omits it, which is the client's own cue to dismiss.
  awaitingButton?: boolean;
}

/** Extra context needed to plan an AbsoluteSegment (MDT-style) download. */
export interface DownloadExtra {
  paramBase?: number | null;
  absSegData?: Record<number, AbsSegSeed>;
  appId?: string;
  resolvedBases?: Record<number, number>;
  // 'full' (default) preserves all pre-existing behavior exactly: LoadData's
  // mode byte follows the model's own declared full/combined shape, and
  // every RelSegment/table write always happens regardless of current
  // device content - matches every real ETS Full Download this project has
  // captured. 'partial' is new (2026-08-29): forces LoadData's mode byte to
  // the real captured Partial-Download value (0x00, see
  // docs/knx-device-write-protocol.md) and, before touching an object, reads
  // its current on-device bytes and skips the whole Unload/StartLoading/
  // LoadData/write/LoadCompleted cycle when they already match the computed
  // image - mirroring the real "17 bytes only, rest skipped" optimization
  // observed in an ETS Partial Download capture. Only tested against
  // RelSegment/ABB-style (System 7) apps (1.1.9/1.1.10's app family, mask
  // 07B0) - the AbsoluteSegment (MDT-style) branch above is untouched by
  // this and still only ever does a full replay.
  mode?: 'full' | 'partial';
  // Object 3 (Group Object Table) content, computed by buildGroupObjectTable()
  // (server/routes/knx-tables.ts). Written via the same universal "undeclared
  // table" mechanism as gaTable/assocTable (writeUndeclaredTable, below) -
  // unconditional write on 'full' mode, peek-and-skip-if-unchanged on
  // 'partial' mode, matching the trigger policy already established and
  // real-hardware-proven for GA/Association tables (docs/knx-device-write-
  // protocol.md Part 6). This is a deliberate choice, not yet independently
  // proven for Object 3 specifically: real ETS's own Full-Download trigger
  // for Object 3 is only understood for one device/app (1.1.10, gated on an
  // anomalous property-27 checksum - Part 8/§10.3); 1.1.9 writes it
  // unconditionally on every Full Download tested, with no known mechanism
  // to predict when it wouldn't. Always writing on 'full' mode matches the
  // *safer* of the two observed real behaviors (never skips when uncertain)
  // rather than trying to replicate the checksum-based skip - a deliberately
  // conservative choice pending real-hardware validation of this exact path.
  groupObjectTable?: Buffer | null;
}

// ── Device info type ───────────────────────────────────────────────────────────

export interface DeviceInfo {
  descriptor: string;
  address: string;
  serialNumber?: string;
  manufacturerId?: number;
  programVersion?: {
    manufacturerId: number;
    deviceType: number;
    appVersion: number;
  };
  orderInfo?: string;
  hardwareType?: string;
  firmwareRevision?: number;
  error?: string;
}

// ── Scan progress type ─────────────────────────────────────────────────────────

export interface ScanProgress {
  address: string;
  reachable: boolean;
  descriptor: string | null;
  done: number;
  total: number;
}

// ── Management session helpers ──────────────────────────────────────────────────

interface ManagementSessionFns {
  sendData: (apciName: string, extraBuf?: Buffer | null) => Promise<void>;
  waitResponse: (apciNameExpected: string, ms?: number) => Promise<CemiFrame>;
  nextSeq: () => number;
}

// ── KnxConnection base class ───────────────────────────────────────────────────

export class KnxConnection extends EventEmitter {
  localAddr: string;
  connected: boolean;
  _scanAbort: boolean;

  constructor() {
    super();
    this.localAddr = '0.0.0'; // physical addr (assigned by gateway or USB device)
    this.connected = false;
    this._scanAbort = false;
  }

  /**
   * Send a CEMI frame over the transport. Must be implemented by subclasses.
   * @param {Buffer} cemi - raw CEMI frame
   * @returns {Promise<void>}
   */
  sendCEMI(_cemi: Buffer): Promise<void> {
    throw new Error('sendCEMI() must be implemented by transport subclass');
  }

  /**
   * Send a CEMI frame via KNXnet/IP Routing (multicast) instead of the
   * normal Tunneling connection. Default throws (no Routing capability) -
   * only KnxIpConnection (knx-protocol.ts) overrides this; USB has no IP
   * path at all. See docs/knx-device-write-protocol.md §9.
   */
  sendCEMIViaRouting(_cemi: Buffer): Promise<void> {
    throw new Error(
      'KNXnet/IP Routing is not available on this transport',
    );
  }

  /** Disconnect from the bus. Must be implemented by transport subclass. */
  disconnect(): void {
    throw new Error('disconnect() must be implemented by transport subclass');
  }

  /** Called by transport subclass when a CEMI frame is received from the bus. */
  _onCEMI(cemi: CemiFrame): void {
    // KNX network-management broadcast services (individual-address
    // discovery, serial-number addressing) use the GROUP address space's
    // reserved broadcast address 0/0/0 - see
    // docs/knx-device-write-protocol.md §9. 0/0/0 is never a legitimate
    // application group address, so a reply here is routed to '_mgmt'
    // (where checkProgrammingMode()/the serial-number services listen),
    // not 'telegram', even though it's a GROUP-type frame.
    if (cemi.isGroup && cemi.dst === '0/0/0') {
      this.emit('_mgmt', cemi);
    } else if (cemi.isGroup && cemi.apciName) {
      const raw = cemi.apduData.toString('hex');
      const decoded = decodeDptBuffer(cemi.apduData);
      const telegram: Telegram = {
        timestamp: new Date().toISOString(),
        src: cemi.src,
        dst: cemi.dst,
        type: eventType(cemi.apciName),
        raw_value: raw,
        decoded,
        priority: 'low',
      };
      this.emit('telegram', telegram);
    } else if (!cemi.isGroup) {
      this.emit('_mgmt', cemi);
    }
  }

  // ── Group communication ───────────────────────────────────────────────────────

  async write(
    ga: string,
    value: unknown,
    dpt: string | number = '1',
  ): Promise<{
    ok: boolean;
    ga: string;
    value: unknown;
    dpt: string | number;
  }> {
    if (!this.connected) throw new Error('Not connected');
    const apdu = apduGroupWrite(value, dpt);
    const cemi = buildCEMI(this.localAddr, ga, apdu, true);
    await this.sendCEMI(cemi);
    return { ok: true, ga, value, dpt };
  }

  // Note: no request correlation ID — concurrent reads to the same GA could
  // consume each other's responses. KNX has no request/response correlation
  // at the group level, so this is a protocol-level limitation, not a bug.
  read(
    ga: string,
    timeoutMs: number = 4000,
  ): Promise<{ ga: string; value: string }> {
    if (!this.connected) throw new Error('Not connected');
    return new Promise((resolve, reject) => {
      const onTelegram = (tg: Telegram): void => {
        if (tg.dst === ga && tg.type === 'GroupValue_Response') {
          clearTimeout(timer);
          this.off('telegram', onTelegram);
          resolve({ ga, value: tg.decoded });
        }
      };
      const timer = setTimeout(() => {
        this.off('telegram', onTelegram);
        reject(new Error('Read timeout'));
      }, timeoutMs);
      this.on('telegram', onTelegram);
      const cemi = buildCEMI(this.localAddr, ga, apduGroupRead(), true);
      this.sendCEMI(cemi).catch((err: Error) => {
        clearTimeout(timer);
        this.off('telegram', onTelegram);
        reject(err);
      });
    });
  }

  // ── Management session ────────────────────────────────────────────────────────

  async managementSession(
    deviceAddr: string,
    fn: (fns: ManagementSessionFns) => Promise<void>,
    timeoutMs: number = 5000,
  ): Promise<void> {
    if (!this.connected) throw new Error('Not connected');

    let seq = 0;

    const sendControl = async (
      tpciCode: number,
      s: number = 0,
    ): Promise<void> => {
      const apdu = apduControl(tpciCode, s);
      const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false);
      await this.sendCEMI(cemi);
    };

    const sendData = async (
      apciName: string,
      extraBuf: Buffer | null = null,
    ): Promise<void> => {
      const apdu = apduConnected(seq, apciName, extraBuf);
      const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false);
      await this.sendCEMI(cemi);
    };

    const waitResponse = (
      apciNameExpected: string,
      ms: number = timeoutMs,
    ): Promise<CemiFrame> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.off('_mgmt', handler);
          reject(
            new Error(`Management timeout waiting for ${apciNameExpected}`),
          );
        }, ms);
        const handler = (cemi: CemiFrame): void => {
          if (cemi.src === deviceAddr && cemi.apciName === apciNameExpected) {
            clearTimeout(timer);
            this.off('_mgmt', handler);
            resolve(cemi);
          }
        };
        this.on('_mgmt', handler);
      });

    // Connection-oriented transport requires us to T_Ack every numbered data
    // frame the device sends (its responses), before issuing the next request —
    // otherwise the peer desyncs and stops responding after the first exchange.
    // (Confirmed against ETS's own bus trace, which acks each device response.)
    const ackHandler = (cemi: CemiFrame): void => {
      if (cemi.src !== deviceAddr || cemi.tpciType !== 'DATA_CONNECTED') return;
      const rxSeq = (cemi.apdu[0]! >> 2) & 0xf;
      // Fire-and-forget the T_Ack, but swallow a failed send (e.g. a KNXnet/IP
      // ACK timeout on a flaky link) so it never becomes an unhandled promise
      // rejection that crashes the process. The awaiting read/verify surfaces
      // the failure through its own waitResponse timeout.
      sendControl(TPCI.ACK, rxSeq).catch(() => {});
    };
    this.on('_mgmt', ackHandler);

    await sendControl(TPCI.CONNECT);
    await delay(100);

    try {
      await fn({ sendData, waitResponse, nextSeq: () => seq++ });
    } finally {
      this.off('_mgmt', ackHandler);
      try {
        await sendControl(TPCI.DISCONNECT);
      } catch (_) {}
    }
  }

  // ── Ping ──────────────────────────────────────────────────────────────────────

  ping(
    gaAddresses: string[],
    deviceAddr: string,
    timeoutMs: number = 2000,
  ): Promise<{ reachable: boolean; ga: string | null }> {
    if (!this.connected) return Promise.reject(new Error('Not connected'));
    return new Promise((resolve) => {
      let done = false;
      const finish = (reachable: boolean, ga: string | null = null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.off('telegram', onTelegram);
        this.off('_mgmt', onMgmt);
        resolve({ reachable, ga });
      };

      const timer = setTimeout(() => finish(false), timeoutMs);

      const gaSet = new Set(gaAddresses);
      const onTelegram = (tg: Telegram): void => {
        if ((deviceAddr && tg.src === deviceAddr) || gaSet.has(tg.dst))
          finish(true, tg.dst);
      };
      this.on('telegram', onTelegram);

      const onMgmt = (cemi: CemiFrame): void => {
        if (
          cemi.src === deviceAddr &&
          cemi.apciName === 'DeviceDescriptor_Response'
        )
          finish(true, deviceAddr);
      };
      this.on('_mgmt', onMgmt);

      this.managementSession(
        deviceAddr,
        async ({ sendData, waitResponse }) => {
          await sendData('DeviceDescriptor_Read', null);
          await waitResponse('DeviceDescriptor_Response', timeoutMs - 200);
          finish(true, deviceAddr);
        },
        timeoutMs,
      ).catch(() => {});
    });
  }

  /**
   * Sends a connection-oriented device Restart (A_Restart) on its own - opens
   * a fresh management session (T_Connect) to `deviceAddr`, reads its
   * identity, sends Restart, waits, then disconnects. Reused by the
   * address-write paths below, per real user question, 2026-08-31: "ETS
   * restarts the device after updating its address. I don't think we are
   * as yet." Confirmed correct on inspection: neither programIA() nor
   * assignIndividualAddressBySerial() sent one.
   *
   * 🔴 Real bug, found live 2026-08-31 (a real HDL device's physical
   * confirmation of a genuine restart - its screen lighting up and
   * displaying its IP - did NOT happen after this method's first version):
   * that first version sent a bare Connect -> Restart with nothing in
   * between, timed at ~110ms apart in the real capture. A real tshark
   * capture of ETS performing the SAME "Download Individual Address"
   * operation (docs/data/captures/2026-08-31_ets_address_write_hdl_real.
   * pcapng) shows ETS does NOT do that - it reads DeviceDescriptor plus
   * two properties (P=56, P=11) BEFORE Restart, roughly half a second of
   * real exchange, not an immediate bare Restart. This method now mirrors
   * that real sequence. Every read here is best-effort (failure logged/
   * swallowed, not fatal) - the goal is mirroring ETS's real session shape
   * for whatever the device expects from it, not the specific property
   * values themselves.
   *
   * 🟢 Real live retry, 2026-08-31: the missing-identity-reads hypothesis
   * above is DISCONFIRMED as the explanation for the earlier "device did
   * not reboot" report - the real cause is now RESOLVED, not merely open.
   * With this fuller sequence in place, a real write+Restart against the
   * same device was captured showing A_Restart genuinely sent and
   * .con-acknowledged, the correct ~3s wait, then a fresh connection
   * reading the device back successfully a few seconds later - the device
   * is unambiguously alive and correctly addressed - but still no visible
   * screen/IP reboot. A dedicated isolated-restart diagnostic
   * (POST /bus/restart-device, no write/detect around it at all) then
   * sent the SAME A_Restart, same code path, against a genuinely different
   * device (1.1.10, Albrecht Jung) with its status light left on
   * beforehand - the light turned off, confirming a real reboot. Identical
   * trigger, identical code, opposite outcomes on two real devices: this
   * device/firmware (HDL) simply does not perform a visible reboot on
   * A_Restart, while the Albrecht Jung device does. Not a koolenex defect.
   * This fix (the fuller ETS-mirroring session shape) is real and correct
   * regardless, and is kept. Full writeup: docs/knx-device-write-protocol.
   * md §9.5.
   *
   * The ~3s gap between Restart and Disconnect (postRestartDelayMs below)
   * is real-capture-confirmed (80.60s Restart, 83.60s Disconnect - exactly
   * 3.0s, same capture). A brief settle delay is still given before
   * connecting, since the device has just adopted a new address it may
   * not be immediately ready to accept a T_Connect at - that part is not
   * calibrated against a real capture, a conservative guess.
   */
  async restartDevice(
    deviceAddr: string,
    settleMs: number = 300,
    postRestartDelayMs: number = 3000,
  ): Promise<void> {
    if (settleMs > 0) await delay(settleMs);
    await this.managementSession(
      deviceAddr,
      async ({ sendData, waitResponse, nextSeq }) => {
        const propRead = async (
          objIdx: number,
          propId: number,
        ): Promise<void> => {
          try {
            const seq = nextSeq();
            const apdu = apduPropertyValueRead(seq, objIdx, propId);
            const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false);
            await this.sendCEMI(cemi);
            await waitResponse('OTHER', 2000);
          } catch (e) {
            logger.warn(
              'knx',
              'restartDevice: identity read before Restart failed (continuing anyway)',
              { deviceAddr, objIdx, propId, error: (e as Error).message },
            );
          }
        };
        try {
          await sendData('DeviceDescriptor_Read');
          await waitResponse('DeviceDescriptor_Response', 2000);
        } catch (e) {
          logger.warn(
            'knx',
            'restartDevice: DeviceDescriptor_Read before Restart failed (continuing anyway)',
            { deviceAddr, error: (e as Error).message },
          );
        }
        await propRead(0, 56);
        await propRead(0, 11);
        await sendData('Restart');
        if (postRestartDelayMs > 0) await delay(postRestartDelayMs);
      },
    );
  }

  // ── Individual address programming ────────────────────────────────────────────

  /**
   * Write an individual address to whichever device is currently in
   * physical programming mode (button held down) - A_IndividualAddress_Write,
   * the write-side counterpart to checkProgrammingMode()'s
   * A_IndividualAddress_Read below. Real bug, found live 2026-08-30: this
   * predates the real-capture investigation that established the correct
   * wire format for these network-management broadcast services (GROUP-type
   * frame to 0/0/0 at System priority - see checkProgrammingMode()'s own
   * doc comment) and was never updated to match - it was still sending an
   * individual-type frame to 0.0.0 at ordinary/Low priority, which a real
   * device silently never accepted (confirmed: the device stayed fully
   * responsive at its old address afterward, with no error reported at any
   * layer). Fixed to use the same confirmed-correct framing as every other
   * service in this family.
   *
   * Restarts the device at its new address afterward (see restartDevice()'s
   * own doc comment) - real ETS does this after every address write, not
   * just after a content download; koolenex's own address-write paths
   * didn't until 2026-08-31. Restart failure doesn't fail the whole call -
   * the address write itself (this service has no response to confirm
   * against anyway) already succeeded from koolenex's point of view; a
   * failed restart is surfaced via `restarted: false`, not an exception.
   */
  async programIA(
    newAddr: string,
    _timeoutMs: number = 5000,
  ): Promise<{ ok: boolean; newAddr: string; restarted: boolean }> {
    if (!this.connected) throw new Error('Not connected');
    const addrBuf = encodePhysical(newAddr);
    const apdu = apduGroup('PhysicalAddress_Write', 0, addrBuf);
    const cemi = buildCEMI(this.localAddr, '0/0/0', apdu, true, {
      priority: 'system',
    });
    await this.sendCEMI(cemi);
    let restarted = true;
    try {
      await this.restartDevice(newAddr);
    } catch (e) {
      restarted = false;
      logger.warn('knx', 'programIA: restart after address write failed', {
        newAddr,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return { ok: true, newAddr, restarted };
  }

  /**
   * Broadcast A_IndividualAddress_Read (APCI PhysicalAddress_Read) and wait
   * for a device currently in physical programming mode (button held down)
   * to answer with A_IndividualAddress_Response. This is the real standard
   * KNX commissioning discovery service - the read-side counterpart to
   * programIA() above (which writes, this only detects/queries), and
   * complementary to (not the same mechanism as) the serial-number-based
   * addressing below.
   *
   * Sent as a GROUP-type frame to address `0/0/0` (KNX's "default
   * broadcast" address) at System priority (ctrl1 `0xB0`), over the
   * normal Tunneling connection - confirmed byte-for-byte against a real
   * KNXnet/IP capture of ETS's own commissioning traffic; see
   * docs/knx-device-write-protocol.md §9 for the full wire-format
   * reference.
   *
   * Real KNX precondition, not enforced here: only ONE device should be in
   * programming mode on a bus at a time - if more than one is, only the
   * first response is surfaced. Real-hardware testing with two devices
   * simultaneously in programming mode showed both reply cleanly with no
   * collision/corruption - this function simply returns whichever arrives
   * first and stops listening, silently not surfacing that a second
   * device was also active. Worth accounting for in a future rollout
   * tool's UX, not addressed here.
   */
  checkProgrammingMode(
    timeoutMs: number = 3000,
  ): Promise<{ address: string | null }> {
    if (!this.connected) throw new Error('Not connected');
    return new Promise((resolve, reject) => {
      const onMgmt = (cemi: CemiFrame): void => {
        // Diagnostic: log every incoming _mgmt frame during the wait
        // window, not just ones that match - cheap to keep, useful if
        // this ever needs re-verifying against different hardware.
        logger.info('knx', 'checkProgrammingMode: _mgmt frame seen', {
          src: cemi.src,
          apciName: cemi.apciName,
          apduHex: cemi.apdu.toString('hex'),
        });
        if (cemi.apciName !== 'PhysicalAddress_Response') return;
        clearTimeout(timer);
        clearInterval(repeat);
        this.off('_mgmt', onMgmt);
        resolve({ address: cemi.src });
      };
      const timer = setTimeout(() => {
        clearInterval(repeat);
        this.off('_mgmt', onMgmt);
        resolve({ address: null });
      }, timeoutMs);
      this.on('_mgmt', onMgmt);
      const apdu = apduGroup('PhysicalAddress_Read');
      // GROUP-type frame to 0/0/0 (KNX's "default broadcast" address) at
      // System priority (ctrl1 0xB0) - confirmed byte-for-byte against
      // real ETS traffic, 2026-08-30 (see this function's doc comment
      // above).
      const cemi = buildCEMI(this.localAddr, '0/0/0', apdu, true, {
        priority: 'system',
      });
      const send = (): void => {
        logger.info('knx', 'checkProgrammingMode: sending broadcast', {
          cemiHex: cemi.toString('hex'),
        });
        this.sendCEMI(cemi).catch((err: Error) => {
          clearTimeout(timer);
          clearInterval(repeat);
          this.off('_mgmt', onMgmt);
          reject(err);
        });
      };
      // Real live-test finding, 2026-08-31: a single one-shot broadcast at
      // the start of the wait window only catches a device that is
      // ALREADY in programming mode at that exact instant - a broadcast
      // telegram can't retroactively be "seen" by a device that enters
      // programming mode moments later. Real ETS itself, captured against
      // this same real HDL device the same day, re-sends its own
      // equivalent broadcast roughly every 3s for the WHOLE wait window
      // (docs/knx-device-write-protocol.md §9.4) - matched here so an
      // operator walking to a device and pressing its button partway
      // through the window still gets caught, not just one sent at t=0.
      send();
      const repeat = setInterval(send, 3000);
    });
  }

  /**
   * Broadcast A_SystemNetworkParameter_Read for PID_SERIAL_NUMBER (object
   * type 0 = Device) and collect every device's response for the full
   * `timeoutMs` window - the real KNX network-management procedure
   * NM_Read_SerialNumber_By_ProgrammingMode: query the serial number of
   * whichever device(s) are currently in physical programming mode, no
   * prior knowledge of any device needed at all. Unlike
   * checkProgrammingMode() above, this deliberately does NOT stop on the
   * first match - multiple devices reply cleanly with no collision (real
   * hardware confirmed with two different manufacturers simultaneously in
   * programming mode), so collecting all of them is the whole point: for
   * genuinely blank devices, checkProgrammingMode()'s address-based
   * response can't tell two blank devices apart (both report the same
   * factory-default address), but their serial numbers are always
   * unique. Duplicates from normal KNX frame repetition are de-duplicated
   * by serial.
   *
   * Sent as a GROUP-type frame to `0/0/0` at System priority (ctrl1
   * `0xB0`) - the same framing as checkProgrammingMode() and the
   * address-assignment services below - confirmed byte-for-byte against a
   * real KNXnet/IP capture of ETS's own commissioning traffic; see
   * docs/knx-device-write-protocol.md §9.
   */
  readSerialNumbersInProgrammingMode(
    timeoutMs: number = 3000,
  ): Promise<Array<{ serial: string; src: string }>> {
    if (!this.connected) throw new Error('Not connected');
    return new Promise((resolve, reject) => {
      const found = new Map<string, string>(); // serial hex -> src
      const onMgmt = (cemi: CemiFrame): void => {
        if (cemi.apdu.length < 2) return;
        const fullApci = ((cemi.apdu[0]! & 0x03) << 8) | cemi.apdu[1]!;
        if (fullApci !== APCI_EXT.SystemNetworkParam_Response) return;
        const resp = parseSystemNetworkParamResponse(cemi);
        if (resp.objectType !== 0 || resp.pid !== 11 || resp.value.length < 6)
          return;
        found.set(resp.value.slice(0, 6).toString('hex'), cemi.src);
      };
      const timer = setTimeout(() => {
        clearInterval(repeat);
        this.off('_mgmt', onMgmt);
        resolve(
          [...found.entries()].map(([serial, src]) => ({ serial, src })),
        );
      }, timeoutMs);
      this.on('_mgmt', onMgmt);
      const apdu = apduSystemNetworkParamRead(0, 11, 1);
      const cemi = buildCEMI(this.localAddr, '0/0/0', apdu, true, {
        priority: 'system',
      });
      const send = (): void => {
        this.sendCEMI(cemi).catch((err: Error) => {
          clearTimeout(timer);
          clearInterval(repeat);
          this.off('_mgmt', onMgmt);
          reject(err);
        });
      };
      // Same real-hardware finding as checkProgrammingMode() above
      // (2026-08-31): a one-shot broadcast only catches a device already
      // in programming mode at the instant it's sent. Re-sent every 3s for
      // the whole wait window, matching real ETS's own repeat cadence.
      send();
      const repeat = setInterval(send, 3000);
    });
  }

  // ── Individual address by serial number ───────────────────────────────────────
  // A_IndividualAddressSerialNumber_Write/_Read (spec 3/5/2 §2.5/§2.4) - assigns
  // or queries a device's individual address via its 6-byte KNX serial number,
  // with no physical programming-button press needed (unlike programIA() above,
  // which relies on the device being in programming mode and only one device
  // responding). Sent as a GROUP-type frame to 0/0/0 (KNX's "default broadcast"
  // address) at System priority, over the normal Tunneling connection - see
  // docs/knx-device-write-protocol.md §9 for the full wire-format reference.
  // UNNUMBERED (no TPCI sequence, no managementSession()/T_Connect - broadcast
  // destinations don't carry a transport-layer connection to ack/sequence
  // against). Real standard KNX procedure, spec 3/5/2 §2.4/§2.5.

  /**
   * Broadcast A_IndividualAddressSerialNumber_Write - assigns `newAddr` to
   * whichever device on the bus matches `serial` (6 bytes). Fire-and-forget
   * at the protocol level (the service itself has no response) - call
   * `readIndividualAddressBySerial()` afterward to verify, or use
   * `assignIndividualAddressBySerial()` which does both.
   */
  async writeIndividualAddressBySerial(
    serial: Buffer,
    newAddr: string,
  ): Promise<{ ok: boolean }> {
    if (!this.connected) throw new Error('Not connected');
    const apdu = apduIndividualAddressSerialNumberWrite(serial, newAddr);
    const cemi = buildCEMI(this.localAddr, '0/0/0', apdu, true, {
      priority: 'system',
    });
    await this.sendCEMI(cemi);
    return { ok: true };
  }

  /**
   * Broadcast A_IndividualAddressSerialNumber_Read and wait for the one
   * device whose own serial number matches to answer. Not correlated by
   * source address (unknown ahead of time - that's the whole point of
   * addressing by serial) - matched instead by the serial number embedded
   * in the reply payload, and by the exact 10-bit response APCI (not just
   * the generic 'OTHER' bucket several extended services share) to avoid
   * mistaking an unrelated concurrent exchange for our response. Returns
   * null on timeout (no matching device answered).
   */
  readIndividualAddressBySerial(
    serial: Buffer,
    timeoutMs: number = 3000,
  ): Promise<{ address: string } | null> {
    if (!this.connected) throw new Error('Not connected');
    return new Promise((resolve, reject) => {
      const onMgmt = (cemi: CemiFrame): void => {
        if (cemi.apdu.length < 2) return;
        const fullApci = ((cemi.apdu[0]! & 0x03) << 8) | cemi.apdu[1]!;
        if (fullApci !== APCI_EXT.IndividualAddressSerialNumber_Response)
          return;
        const resp = parseIndividualAddressSerialNumberResponse(cemi);
        if (resp.serial.equals(serial)) {
          clearTimeout(timer);
          this.off('_mgmt', onMgmt);
          resolve({ address: resp.address });
        }
      };
      const timer = setTimeout(() => {
        this.off('_mgmt', onMgmt);
        resolve(null);
      }, timeoutMs);
      this.on('_mgmt', onMgmt);
      const apdu = apduIndividualAddressSerialNumberRead(serial);
      const cemi = buildCEMI(this.localAddr, '0/0/0', apdu, true, {
        priority: 'system',
      });
      this.sendCEMI(cemi).catch((err: Error) => {
        clearTimeout(timer);
        this.off('_mgmt', onMgmt);
        reject(err);
      });
    });
  }

  /**
   * Write-then-read-verify, mirroring Calimero's real
   * ManagementProceduresImpl.writeAddress() procedure: broadcast the
   * Write, then broadcast a Read as verification and compare. Deliberately
   * no precondition check that the device isn't already addressed - per
   * Calimero's real implementation this can re-address an already-
   * configured device too, not just commission a blank one.
   *
   * Restarts the device at its new address afterward, but only once the
   * read-back has actually confirmed the write landed - see
   * restartDevice()'s own doc comment. Previously this method never
   * restarted at all ("No Restart afterward" - real user question,
   * 2026-08-31: "ETS restarts the device after updating its address. I
   * don't think we are as yet" - confirmed correct on inspection). Skipped
   * (not attempted) when verification failed/timed out - restarting a
   * device at an address it may not have actually adopted isn't
   * meaningful, and `verified: false` already tells the caller something's
   * wrong. Restart failure doesn't fail the whole call - surfaced via
   * `restarted: false`, not an exception, same reasoning as programIA().
   */
  async assignIndividualAddressBySerial(
    serial: Buffer,
    newAddr: string,
    timeoutMs: number = 3000,
  ): Promise<{
    ok: boolean;
    verified: boolean;
    address: string | null;
    restarted: boolean;
  }> {
    await this.writeIndividualAddressBySerial(serial, newAddr);
    const chk = await this.readIndividualAddressBySerial(serial, timeoutMs);
    const verified = chk?.address === newAddr;
    let restarted = false;
    if (verified) {
      try {
        await this.restartDevice(newAddr);
        restarted = true;
      } catch (e) {
        logger.warn(
          'knx',
          'assignIndividualAddressBySerial: restart after address write failed',
          { newAddr, error: e instanceof Error ? e.message : String(e) },
        );
      }
    }
    return { ok: true, verified, address: chk?.address ?? null, restarted };
  }

  // ── Application download ──────────────────────────────────────────────────────

  /**
   * Read `length` bytes of device memory starting at `address`, over the bus.
   * Non-destructive: issues A_Memory_Read requests only. Used by the read-first
   * validation flow to compare a device's actual memory against a computed image.
   *
   * Default chunk size 228, matching the real MEM_CHUNK confirmed for
   * writes (see its own comment in downloadDevice()). A first attempt at
   * this live 2026-08-30 was reverted after a real `rc=252` device error -
   * traced afterward (same day) to a genuinely unrelated cause: that test
   * used a stale device id (a project reimport had regenerated device
   * rows; the id in use no longer existed), so the GA table's computed
   * "expected" length was wrong, and the read request over-ran the real,
   * much smaller table actually allocated on the device. Confirmed via a
   * real packet capture: real ETS reads the SAME address in two phases
   * (2 bytes, then 4 more) specifically because it doesn't know the real
   * count upfront either - but a SINGLE read for the correct total length
   * (6 bytes here, matching the device's real 2 linked group addresses)
   * succeeded in one shot, byte-for-byte identical to ETS's own phased
   * result. The real lesson: `chunkSize` was never the problem - a
   * REQUESTED LENGTH that exceeds a small table's real allocated size is.
   * Restored to 228 now that this is understood; `readRegionInSession`'s
   * own `Math.min(chunkSize, length - off)` already clamps correctly down
   * to a small region's real length regardless of chunk size, so this is
   * safe for both the large parameter-memory region (where it matters for
   * speed) and small undeclared tables (where it's a no-op, correctly).
   */
  async readMemory(
    deviceAddr: string,
    address: number,
    length: number,
    chunkSize: number = 228,
    onChunk?: (bytesRead: number) => void,
  ): Promise<Buffer> {
    if (!this.connected) throw new Error('Not connected');
    let out: Buffer = Buffer.alloc(length);
    await this.managementSession(deviceAddr, async (fns) => {
      out = await this.readRegionInSession(
        fns,
        deviceAddr,
        address,
        length,
        chunkSize,
        onChunk,
      );
    });
    return out;
  }

  /**
   * Read several memory regions of one device inside a SINGLE management
   * session (one Connect/Disconnect for the whole batch), rather than opening
   * a fresh connection-oriented session per region. Mirrors how a real
   * download drives all of a device's transfers over one session. Returns one
   * Buffer per requested region, in order. onChunk, if given, is called after
   * every chunk across every region with the cumulative bytes read so far -
   * the total length across all regions is known upfront by the caller
   * (it's the same computed-image size used for "expected"), so real
   * progress reporting is possible without waiting for the whole read to
   * finish.
   *
   * Default chunk size 228 - see readMemory()'s own comment for the real
   * story: an early rc=252 rejection at this size traced back to a stale
   * device id (wrong computed table length, not the chunk size itself).
   */
  async readMemoryMany(
    deviceAddr: string,
    regions: Array<{ address: number; length: number }>,
    chunkSize: number = 228,
    onChunk?: (bytesRead: number) => void,
  ): Promise<Buffer[]> {
    if (!this.connected) throw new Error('Not connected');
    const results: Buffer[] = [];
    let cumulative = 0;
    await this.managementSession(deviceAddr, async (fns) => {
      for (const r of regions)
        results.push(
          await this.readRegionInSession(
            fns,
            deviceAddr,
            r.address,
            r.length,
            chunkSize,
            onChunk
              ? (n) => {
                  cumulative += n;
                  onChunk(cumulative);
                }
              : undefined,
          ),
        );
    });
    return results;
  }

  /**
   * Read one memory region using an already-open management session. The
   * device echoes the requested address in every A_Memory_Response; we reject
   * any response whose address does not match the chunk we asked for, so a
   * stale or reordered response can never be copied into the wrong offset of
   * the read-back buffer.
   */
  private async readRegionInSession(
    fns: ManagementSessionFns,
    deviceAddr: string,
    address: number,
    length: number,
    chunkSize: number,
    onChunk?: (bytesJustRead: number) => void,
  ): Promise<Buffer> {
    const { waitResponse, nextSeq } = fns;
    const out = Buffer.alloc(length);
    let off = 0;
    while (off < length) {
      const seq = nextSeq();
      const wantAddr = address + off;
      // A_Memory_Read only carries a 16-bit address. A resolved relmem base
      // (via PID 7) can legitimately land well above 0xFFFF - using the legacy
      // service there silently truncates to the wrong (low) address and reads
      // unrelated memory instead of erroring, so use A_MemoryExtended_Read
      // (24-bit address space) whenever the real address doesn't fit in 16
      // bits. Devices whose address does fit keep using the legacy service
      // unchanged - some legacy/ABB-style devices are only known to answer
      // that one, so this is deliberately the minimum change, not a blanket
      // switch to extended, based on real-hardware evidence of which
      // service each device family actually answers.
      const useExtended = wantAddr > 0xffff;
      // Real bug, found live 2026-08-30, same session as the short-response
      // fix below: `apduMemoryRead`'s legacy A_Memory_Read packs its byte
      // count into a 6-bit APCI field (`count & 0x3f`, max 63) - NOT a
      // koolenex/device disagreement at all, a genuinely malformed request
      // on koolenex's own part. `chunkSize` defaults to 228 (correct for
      // the extended service's full 1-byte count field), and once a prior
      // short response left `off` at a non-round offset, `n` could land at
      // 64 - which `apduMemoryRead` then silently encoded as `64 & 0x3f =
      // 0`, a request for literally zero bytes. The device answered
      // exactly what was asked (nothing); the "zero bytes returned" safety
      // check below caught the SYMPTOM correctly, but the actual cause was
      // upstream. Cap `n` to each service's own real wire-format limit
      // BEFORE building the request, not just AFTER interpreting the
      // response.
      const maxN = useExtended ? 255 : 63;
      const n = Math.min(chunkSize, length - off, maxN);
      if (useExtended) {
        const apdu = apduMemoryExtendedRead(seq, n, wantAddr);
        const respP = waitResponse('MemoryExtended_Read_Response', 3000);
        await this.sendCEMI(buildCEMI(this.localAddr, deviceAddr, apdu, false));
        const frame = await respP;
        const { returnCode, address: gotAddr, data } =
          parseMemoryExtendedResponse(frame);
        if (returnCode !== 0)
          throw new Error(
            `MemoryExtended read error rc=${returnCode} at 0x${wantAddr.toString(16)}`,
          );
        if (gotAddr !== wantAddr)
          throw new Error(
            `MemoryExtended_Read_Response address mismatch: requested 0x${wantAddr.toString(
              16,
            )}, device answered 0x${gotAddr.toString(16)}`,
          );
        // Real bug, found live 2026-08-30: a real device can answer a
        // large single read request with a genuinely SHORT response (real
        // capture evidence: a 98-byte request returned only ~34 real
        // bytes, for reasons unrelated to `chunkSize` - the request
        // itself is well-formed and the device ACKs it, it just doesn't
        // return everything asked for in one response). This loop used to
        // advance by the REQUESTED amount (`chunkSize`) regardless of how
        // much data actually came back, permanently losing the shortfall -
        // every later byte silently stayed at Buffer.alloc()'s zero
        // default, indistinguishable from genuine on-device content,
        // which looked exactly like a real device-side data-loss bug
        // until a deliberately smaller, separate re-read of the same
        // address range came back with the real (non-zero) content the
        // large read had silently dropped. Clamping the copy length (the
        // pre-existing fix below, for the OPPOSITE case - a
        // padded/oversized response) already protects against a buffer
        // overrun either way; the real fix is advancing `off` by what was
        // ACTUALLY received, not what was requested, so a short response
        // is retried for its own remainder on the next loop iteration
        // instead of being silently accepted as complete.
        const gotLen = Math.min(data.length, n);
        if (gotLen === 0)
          throw new Error(
            `MemoryExtended_Read_Response returned zero bytes at 0x${wantAddr.toString(16)} (requested ${n})`,
          );
        data.copy(out, off, 0, gotLen);
        onChunk?.(gotLen);
        off += gotLen;
        continue;
      }
      const apdu = apduMemoryRead(seq, n, wantAddr);
      const respP = waitResponse('Memory_Response', 3000);
      await this.sendCEMI(buildCEMI(this.localAddr, deviceAddr, apdu, false));
      const frame = await respP;
      const { address: gotAddr, data } = parseMemoryResponse(frame);
      if (gotAddr !== wantAddr)
        throw new Error(
          `Memory_Response address mismatch: requested 0x${wantAddr.toString(
            16,
          )}, device answered 0x${gotAddr.toString(16)}`,
        );
      // Same real-short-response protection as the extended branch above.
      const gotLen = Math.min(data.length, n);
      if (gotLen === 0)
        throw new Error(
          `Memory_Response returned zero bytes at 0x${wantAddr.toString(16)} (requested ${n})`,
        );
      data.copy(out, off, 0, gotLen);
      onChunk?.(gotLen);
      off += gotLen;
    }
    return out;
  }

  /**
   * Read a single interface-object property value (A_PropertyValue_Read).
   * Non-destructive. Returns the property VALUE bytes only — the 4-byte
   * response header (objIdx, propId, count, startIndex) is stripped. Used by
   * read-back verification of property-configured devices (e.g. KNX IP
   * routers) that carry no downloadable parameter-memory image.
   */
  async readProperty(
    deviceAddr: string,
    objIdx: number,
    propId: number,
  ): Promise<Buffer> {
    const [value] = await this.readPropertyMany(deviceAddr, [
      { objIdx, propId },
    ]);
    return value ?? Buffer.alloc(0);
  }

  /**
   * Read several interface-object property values of one device inside a
   * SINGLE management session. Returns one VALUE buffer per read (the 4-byte
   * response header stripped), in order.
   */
  async readPropertyMany(
    deviceAddr: string,
    reads: Array<{ objIdx: number; propId: number }>,
  ): Promise<Buffer[]> {
    if (!this.connected) throw new Error('Not connected');
    const values: Buffer[] = [];
    await this.managementSession(
      deviceAddr,
      async ({ waitResponse, nextSeq }) => {
        for (const { objIdx, propId } of reads) {
          const seq = nextSeq();
          const apdu = apduPropertyValueRead(seq, objIdx, propId);
          const respP = waitResponse('OTHER', 3000);
          await this.sendCEMI(
            buildCEMI(this.localAddr, deviceAddr, apdu, false),
          );
          const res = await respP;
          const data = res?.apduData;
          if (!data)
            throw new Error(
              `No PropertyValue_Response for obj=${objIdx} pid=${propId}`,
            );
          values.push(
            data.length > 4 ? Buffer.from(data.subarray(4)) : Buffer.alloc(0),
          );
        }
      },
    );
    return values;
  }

  /**
   * Read device memory using the extended memory services (A_MemoryExtended_Read,
   * 0x1FD) — required by System B / System 7 devices, which do not answer the
   * legacy A_Memory_Read. Non-destructive. 24-bit address space.
   */
  async readMemoryExtended(
    deviceAddr: string,
    address: number,
    length: number,
    chunkSize: number = 11,
  ): Promise<Buffer> {
    if (!this.connected) throw new Error('Not connected');
    const out = Buffer.alloc(length);
    await this.managementSession(
      deviceAddr,
      async ({ waitResponse, nextSeq }) => {
        for (let off = 0; off < length; off += chunkSize) {
          const n = Math.min(chunkSize, length - off);
          const seq = nextSeq();
          const apdu = apduMemoryExtendedRead(seq, n, address + off);
          const respP = waitResponse('MemoryExtended_Read_Response', 3000);
          await this.sendCEMI(
            buildCEMI(this.localAddr, deviceAddr, apdu, false),
          );
          const frame = await respP;
          const { returnCode, data } = parseMemoryExtendedResponse(frame);
          if (returnCode !== 0)
            throw new Error(
              `MemoryExtended read error rc=${returnCode} at 0x${(address + off).toString(16)}`,
            );
          data.copy(out, off);
        }
      },
    );
    return out;
  }

  async downloadDevice(
    deviceAddr: string,
    steps: DownloadStep[],
    gaTable: Buffer | null,
    assocTable: Buffer | null,
    paramMem: Buffer | null,
    onProgress?: (progress: DownloadProgress) => void,
    extra?: DownloadExtra,
  ): Promise<void> {
    if (!this.connected) throw new Error('Not connected');

    const log = (msg: string): void => {
      if (onProgress) onProgress({ msg });
    };

    // AbsoluteSegment (MDT-style) load procedures — Connect/Unload/Load/
    // AbsSegment/TaskSegment/LoadCompleted/Restart/Disconnect — are planned
    // by the pure planDownload() function (see knx-download-plan.ts) and
    // this executor just replays the resulting ops as CEMI frames. Legacy
    // RelSegment/WriteRelMem/LoadImageProp (ABB-style) devices keep using
    // the inline loop below unchanged.
    if (isAbsSegmentProcedure(steps)) {
      await this.managementSession(deviceAddr, async ({ nextSeq }) => {
        const MEM_CHUNK = 44;

        const ops = planDownload(
          steps as PlanStep[],
          gaTable,
          assocTable,
          paramMem,
          extra?.paramBase ?? null,
          extra?.absSegData ?? {},
          extra?.appId ?? '',
        );

        for (const op of ops) {
          switch (op.kind) {
            case 'connect':
            case 'disconnect': {
              // The connection-oriented session is already opened/closed by
              // managementSession() around this whole download; nothing to
              // send here.
              log(op.kind === 'connect' ? 'Connect' : 'Disconnect');
              break;
            }
            case 'propWrite': {
              log(`PropWrite ObjIdx=${op.obj} PropId=${op.pid}`);
              const seq = nextSeq();
              const apdu = apduPropertyValueWrite(seq, op.obj, op.pid, op.data);
              const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false);
              await this.sendCEMI(cemi);
              await delay(50);
              break;
            }
            case 'memWrite': {
              log(
                `MemWrite Addr=0x${op.addr.toString(16)} Len=${op.bytes.length}`,
              );
              for (let off = 0; off < op.bytes.length; off += MEM_CHUNK) {
                const chunk = op.bytes.subarray(off, off + MEM_CHUNK);
                const addr = op.addr + off;
                const seq = nextSeq();
                const chunkExtra = Buffer.concat([
                  Buffer.from([chunk.length, (addr >> 8) & 0xff, addr & 0xff]),
                  chunk,
                ]);
                const apdu = apduConnected(seq, 'Memory_Write', chunkExtra);
                const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false);
                await this.sendCEMI(cemi);
                await delay(30);
              }
              break;
            }
            case 'restart': {
              log('Restart');
              const seq = nextSeq();
              const apdu = apduConnected(seq, 'Restart');
              const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false);
              await this.sendCEMI(cemi);
              break;
            }
          }
        }

        log('Download complete');
        if (onProgress)
          onProgress({ msg: 'Download complete', pct: 100, done: true });
      });
      return;
    }

    await this.managementSession(deviceAddr, async (fns) => {
      const { nextSeq, waitResponse } = fns;
      // Real bug, found live 2026-08-30: this was 10 for as long as this
      // per-chunk-flow-control code has existed, with no real evidence
      // behind that number - it made writes correct (each chunk gets a
      // real, healthy response) but needlessly slow, since it forces far
      // more round trips than the data needs. Decoded a real ETS Full
      // Download capture (docs/data/captures/2026-08-30_ets_full_download_
      // serial_addressing.pcapng) directly: real ETS's own
      // MemoryExtended_Write chunk sizes are 1, 2, 3, 4, 5, 6, 7, 10, 15,
      // 30, 61, 62, 97, and 228 bytes - i.e. "as much as fits, capped at
      // 228", using the smaller values only for a segment's tail remainder
      // or genuinely small segments, never a fixed small pace. 228 matches
      // exactly, confirmed against the real wire bytes rather than assumed.
      const MEM_CHUNK = 228;
      // See DownloadExtra.mode's doc comment above for what 'partial' does.
      const mode: 'full' | 'partial' = extra?.mode ?? 'full';

      // Waits for the device's actual PropertyValue_Response before
      // resolving - PropertyValue_Write/Response (0x3D7/0x3D5) aren't
      // registered as named extended APCIs (see parseCEMI's APCI_EXT_NAMES),
      // so the response comes back as apciName 'OTHER', same as
      // readPropertyMany()'s own PropertyValue_Read/Response exchange above.
      // Previously fire-and-forget with a fixed 50ms delay - real hardware
      // showed a LoadCompleted response can take ~500ms to arrive (see
      // docs/follow-ups/2026-08-28-write-path-missing-load-sequence.md's
      // "Restart race" finding), so a fixed short delay let Restart fire
      // before the device had actually confirmed the transition, discarding
      // the just-loaded segment. Not fatal if the response never arrives
      // (some property writes may legitimately not always respond) - logs
      // and continues rather than aborting the whole download over it.
      const propWrite = async (
        objIdx: number,
        propId: number,
        data: Buffer,
        startIndex = 1,
      ): Promise<void> => {
        const seq = nextSeq();
        const apdu = apduPropertyValueWrite(seq, objIdx, propId, data, 1, startIndex);
        const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false);
        const respP = waitResponse('OTHER', 3000);
        await this.sendCEMI(cemi);
        try {
          await respP;
        } catch (_e) {
          log(`No PropertyValue_Response for ObjIdx=${objIdx} PropId=${propId} (continuing)`);
        }
      };

      /** Read a property's current value. Returns null on no response. */
      const propRead = async (
        objIdx: number,
        propId: number,
        count = 1,
        startIndex = 1,
      ): Promise<Buffer | null> => {
        const seq = nextSeq();
        const apdu = apduPropertyValueRead(seq, objIdx, propId, count, startIndex);
        const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false);
        const respP = waitResponse('OTHER', 3000);
        await this.sendCEMI(cemi);
        try {
          const res = await respP;
          return res.apduData.length > 4
            ? Buffer.from(res.apduData.subarray(4))
            : Buffer.alloc(0);
        } catch (_e) {
          return null;
        }
      };

      // Which memory-write service this device actually requires -
      // determined from its real mask version (A_DeviceDescriptor_Read),
      // not assumed. 2026-08-28: WriteRelMem was briefly changed to always
      // use A_MemoryExtended_Write unconditionally, based on real-hardware
      // evidence from exactly two devices (1.1.9, 1.1.10) - both real
      // mask-version reads on this testbed came back `0x07B0` ("System B"
      // per this project's own bundled KNX Master Data,
      // `data/knx_master_*.xml`'s `<MaskVersion>` table: `ManagementModel`
      // "SystemB" for masks `07B0`/`17B0`/`27B0`/`57B0`, vs. legacy
      // `Bcu1`/`Bcu2`/`BimM112`/`PropertyBased` families for older masks).
      // Generalizing "always extended" from a same-family two-device
      // sample would be unsound - a genuinely older Bcu1/Bcu2/System-7
      // device could still require the legacy service. Real ETS itself
      // reads the device descriptor as the very first frame
      // of every download session (confirmed in every real capture this
      // project has) - almost certainly for exactly this reason. Mirror
      // that: read it here, and gate on the mask's low byte being `0xB0`
      // (true for every SystemB medium variant in the master table) rather
      // than hardcoding a blanket choice. If the read fails or the device
      // isn't in a recognized family, fall back to the original,
      // conservative address-size heuristic (extended only when the
      // resolved address doesn't fit in 16 bits) rather than guessing.
      let useExtendedMemory: boolean | null = null;
      {
        const apdu = apduGroup('DeviceDescriptor_Read');
        const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false);
        const respP = waitResponse('DeviceDescriptor_Response', 3000);
        await this.sendCEMI(cemi);
        try {
          const resp = await respP;
          const mask = resp.apduData.length >= 2
            ? (resp.apduData[0]! << 8) | resp.apduData[1]!
            : null;
          if (mask != null) {
            useExtendedMemory = (mask & 0xff) === 0xb0;
            log(
              `DeviceDescriptor mask=0x${mask.toString(16).padStart(4, '0')} ` +
                `(${useExtendedMemory ? 'SystemB family - extended memory writes' : 'legacy family - address-size heuristic applies'})`,
            );
          }
        } catch (_e) {
          log('No DeviceDescriptor_Response received (falling back to address-size heuristic for memory writes)');
        }
      }

      // A_Authorize_Request with the well-known/default key - real ETS
      // sends this near the start of every download session, before any
      // property/memory writes, and koolenex never has (any code path).
      // Root-caused 2026-08-28: a small, correctly-addressed, correctly-
      // sequenced write (including the LSM fix above) still didn't persist
      // even once Restart was correctly delayed until after LoadCompleted's
      // real response - the response itself looked valid, so the remaining
      // plausible explanation is that the underlying commit is gated behind
      // authorization we'd never requested. Sent once, unconditionally, at
      // the start of any RelSegment-driven download (see the log line if
      // the device declines it - a non-zero response is possible on a
      // device with real project-set access keys, unlike this testbed's
      // presumed-default 0xFFFFFFFF).
      {
        const seq = nextSeq();
        const apdu = apduAuthorizeRequest(seq);
        const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false);
        const respP = waitResponse('OTHER', 3000);
        await this.sendCEMI(cemi);
        try {
          const resp = await respP;
          log(`Authorize level=${resp.apduData[0] ?? 'unknown'}`);
        } catch (_e) {
          log('No Authorize_Response received (continuing)');
        }
      }

      // ── Load State Machine transitions (PID_LOAD_STATE_CONTROL = property
      // 5) around a RelSegment/WriteRelMem write. Real device firmware
      // silently ignores memory writes to an interface object outside
      // "Loading" state - koolenex used to send WriteRelMem completely raw,
      // with no load-state transition at all, so every such write was a
      // silent no-op regardless of address correctness. Root-caused
      // 2026-08-28 via a real hardware test (a manually-targeted single-byte
      // write had zero effect) and confirmed against koolenex's own real
      // wire traffic - see docs/follow-ups/2026-08-28-write-path-missing-
      // load-sequence.md for the full decode. Event/state codes and the
      // LoadData wire format below are transcribed directly from that real
      // capture (four independent real examples, sizes matched exactly),
      // not derived from the KNX spec in the abstract - treat as verified
      // for RelSegment/ABB-style (System 7) apps specifically.
      const LSM_EVENT = {
        UNLOAD: 0x04,
        START_LOADING: 0x01,
        LOAD_DATA: 0x03,
        LOAD_COMPLETED: 0x02,
      } as const;
      const lsmWrite = async (
        objIdx: number,
        event: number,
        extraBytes: Buffer = Buffer.alloc(9),
      ): Promise<void> => {
        await propWrite(objIdx, 5, Buffer.concat([Buffer.from([event]), extraBytes]));
      };
      // LoadData's real wire shape: [event=03][SCF=0x0B][rsvd:2][size:2 BE]
      // [combinedFullPar:1][fill:1][rsvd:2] - `combined` is set when the
      // model declares both a "full" and a "par" RelSegment for the same
      // object (only ever observed for the parameter object so far; every
      // other object's real example had combined=0).
      const loadDataExtra = (
        size: number,
        fill: number,
        combined: boolean,
      ): Buffer => {
        // Layout (9 bytes, after the leading event byte lsmWrite prepends):
        // [SCF=0x0B][rsvd:2][size:2 BE][mode:1][fill:1][rsvd:2] - verified
        // byte-for-byte against 4 independent real captures (offsets 1-9 of
        // the real 10-byte PropValueWrite value), see the doc referenced
        // above.
        const b = Buffer.alloc(9);
        b.writeUInt8(0x0b, 0);
        b.writeUInt16BE(size, 3);
        b.writeUInt8(combined ? 1 : 0, 5);
        b.writeUInt8(fill, 6);
        return b;
      };
      // Real relSeg info (size/fill/combined) per object, from the model's
      // own RelSegment step(s) - one step per mode ("full"/"par"), same
      // lsmIdx, real devices only need ONE combined LoadData either way.
      const relSegByObj = new Map<
        number,
        { size: number; fill: number; combined: boolean }
      >();
      for (const s of steps) {
        if (s.type !== 'RelSegment' || s.lsmIdx == null || s.size == null)
          continue;
        const existing = relSegByObj.get(s.lsmIdx);
        relSegByObj.set(s.lsmIdx, {
          size: s.size,
          fill: s.fill ?? 0,
          combined: !!existing, // a second RelSegment for the same object -> combined
        });
      }
      let anyRelSegmentLoaded = false;

      // One real, resolved-write job per interface object - the parameter
      // object (from a `WriteRelMem` step below) and the GA/Association/
      // Object 3 undeclared tables (further below) all become one of
      // these, and are all executed together through the same batched
      // phases (see the big comment further down for why).
      interface RelmemJob {
        objIdx: number;
        label: string;
        table: Buffer;
        offset: number;
        // Non-null only for a caller-supplied base (the /bus/write-memory
        // debug tool's `resolvedBases`) - skips PID_TABLE_REFERENCE
        // resolution entirely and uses this address directly.
        presetBase: number | null;
        // The real 9-byte LOAD_DATA extra, or null when no Unload/
        // StartLoading/LoadData cycle applies at all (a WriteRelMem step
        // whose object has no RelSegment declaration - the object is
        // already loaded/known, use the caller-supplied base as-is).
        loadDataPayload: Buffer | null;
        // objIdx 4 (the application program) gets a real, real-hardware-
        // confirmed PID_PROGRAM_VERSION write-back after its memory write
        // finishes, before LoadCompleted - see the WriteRelMem case below.
        isParamObject: boolean;
      }
      const relmemJobs: RelmemJob[] = [];

      for (const step of steps) {
        switch (step.type) {
          case 'WriteProp': {
            log(`WriteProp ObjIdx=${step.objIdx} PropId=${step.propId}`);
            if (step.data && step.data.length) {
              // Property 27's declared InlineData is always 2 bytes longer
              // than what real ETS actually puts on the wire - confirmed
              // 2026-08-29 by comparing a real capture against the project
              // file's own data, then checked against every app in this
              // project's data/apps that declares a WriteProp for objIdx4/
              // propId27 (several different manufacturers: 0004, 0048,
              // 00C5, 0233) - every single one is exactly 10 bytes, always
              // ending in the same 2 trailing zero-padding bytes beyond the
              // real 8-byte element. Not observed for any other property in
              // that same data, so this trim is scoped to propId 27 only,
              // not a general InlineData-parsing artifact.
              const data = step.propId === 27 ? step.data.subarray(0, 8) : step.data;
              await propWrite(step.objIdx, step.propId, data);
            }
            break;
          }
          case 'CompareProp': {
            log(`CompareProp ObjIdx=${step.objIdx} PropId=${step.propId}`);
            break;
          }
          case 'WriteRelMem': {
            log(`WriteRelMem ObjIdx=${step.objIdx} Size=${step.size}`);
            if (!paramMem) throw new Error('Parameter memory not available');
            const objIdx = step.objIdx ?? 4;
            const relSeg = relSegByObj.get(objIdx);
            const presetBase = extra?.resolvedBases?.[objIdx] ?? null;
            const mem = paramMem.slice(0, step.size);
            // Deferred to the batched phases below (Unload/StartLoading/
            // LoadData/PID7-resolve/write/LoadCompleted run together across
            // every interface object, not one at a time) - see the big
            // comment on that batch for why. `presetBase` (the
            // /bus/write-memory debug tool's caller-supplied address) skips
            // PID_TABLE_REFERENCE resolution there entirely, same as before.
            relmemJobs.push({
              objIdx,
              label: `param obj ${objIdx}`,
              table: mem,
              offset: step.offset ?? 0,
              presetBase,
              // Full mode: preserve the model's own declared full/combined
              // shape exactly as before. Partial mode: force the real
              // captured Partial-Download mode byte (0x00) regardless of
              // what the model declares - see DownloadExtra.mode. `null`
              // when the object has no RelSegment declaration at all - no
              // Unload/StartLoading/LoadData cycle applies, same as before
              // (the object is already loaded/known; write directly to
              // whatever base was supplied).
              loadDataPayload: relSeg
                ? loadDataExtra(
                    relSeg.size,
                    relSeg.fill,
                    mode === 'full' ? relSeg.combined : false,
                  )
                : null,
              isParamObject: objIdx === 4,
            });
            break;
          }
          case 'LoadImageProp': {
            // Real ETS behavior here is NOT "write the image to this
            // property" despite the step name, for ANY objIdx - confirmed
            // 2026-08-29 across 3 independent real downloads (Full + 2
            // Partials) against 1.1.10's app (M-0004_A-3030-23-F0EA-O000A),
            // the only app this project has seen declare LoadImageProp at
            // all. ETS only ever READS this property for every one of
            // objIdx 1/2/3/4 (identical value before/after the load cycle,
            // every time, including objIdx4) - it's a read-back/verify step,
            // not a write. The previous code here blindly WROTE the GA
            // table to objIdx1, the Association table to objIdx2, a stray
            // 0x04 byte to objIdx3, and (an earlier, now-corrected fix)
            // reconstructed an unnecessary "checksum recompute" write for
            // objIdx4 - all real bugs, none of which real ETS does here.
            //
            // objIdx4's property 27 genuinely IS written by real ETS, but
            // via a completely separate mechanism this app's own model
            // already declares explicitly: two `WriteProp` steps earlier in
            // this same loadProcedures list, carrying literal fixed data
            // straight from the project file (see the WriteProp case
            // above, and its propId===27 trim fix). Confirmed directly from
            // the capture's own frame timeline: the only 2 real writes to
            // objIdx4/P27 land BEFORE the LoadImageProp steps run, timed to
            // match those WriteProp steps exactly - LoadImageProp
            // contributes nothing but a read for objIdx4 too.
            log(
              `LoadImageProp ObjIdx=${step.objIdx} PropId=${step.propId} - read-only per real ETS, not writing`,
            );
            await propRead(step.objIdx, step.propId);
            break;
          }
        }
      }

      // Real ETS also writes the GA table (objIdx 1) and Association table
      // (objIdx 2) during a Full Download, via the exact same Unload/
      // StartLoading/LoadData/write/LoadCompleted RelSegment mechanism used
      // above for the parameter object - confirmed directly in
      // docs/knx-device-write-protocol.md's capture decode. Neither real
      // app model this project has tested DECLARES this itself for objIdx
      // 1/2 the way real ETS actually behaves: 1.1.9's app
      // (M-0004_A-0025-10-1BA6-O00A6) has no step at all for these objects
      // in its own Static/LoadProcedures XML; 1.1.10's app
      // (M-0004_A-3030-23-F0EA-O000A) declares `LoadImageProp` instead (a
      // different mechanism, honored by the switch above). Root-caused
      // 2026-08-29: real ETS's GA/Association table loading is apparently a
      // universal, mask-defined procedure, not something every app needs to
      // (or, for 1.1.9's app, does) declare - koolenex previously had no
      // fallback for the "doesn't declare it" case at all, meaning it never
      // wrote either table for that app, ever. Only synthesize this when
      // the model hasn't already handled the object some other way
      // (WriteRelMem or LoadImageProp above), and only when the caller
      // actually supplied a table - never blind-writes an absent one.
      //
      // No real Partial Download example exists for these two objects (see
      // the reference doc's §2.3/§1.2 caveats) - `mode=Full` (combined
      // `true`) is used unconditionally here since every real example of an
      // actual GA/Association table write observed is a Full Download; not
      // proven for what a real Partial variant would look like.
      //
      // FIXED 2026-08-29 (later same day): `LoadImageProp` used to count as
      // "the model already handles this object" here, alongside genuine
      // `WriteRelMem` declarations - but the LoadImageProp case above
      // confirms it's read-only for EVERY objIdx real ETS has ever declared
      // it for, never a real write. 1.1.10's app declares LoadImageProp for
      // objIdx 1/2/3 (GA/Assoc/Group Object Table) as well as 4 - under the
      // old logic this incorrectly suppressed the real undeclared-table
      // write for all three, a latent bug never caught because that path
      // was only ever validated against real ETS's own captures, never
      // exercised end-to-end through koolenex's own write path for 1.1.10.
      // Only a genuine `WriteRelMem` declaration (a real content write)
      // should count as "already handled".
      const declaredTableObjIdxs = new Set(
        steps.filter((s) => s.type === 'WriteRelMem').map((s) => s.objIdx),
      );
      // Undeclared-table write: GA table (objIdx 1), Association table
      // (objIdx 2), and Object 3 / Group Object Table (objIdx 3) all use
      // the same real mechanism real ETS uses for a table the app's own
      // model doesn't declare a step for - the same undeclared-table
      // mechanism, folded into the same `relmemJobs` batch as the
      // parameter object above (see the big comment on that batch below
      // for why they all need to run together).
      if (gaTable && gaTable.length && !declaredTableObjIdxs.has(1)) {
        relmemJobs.push({
          objIdx: 1,
          label: 'GA table',
          table: gaTable,
          offset: 0,
          presetBase: null,
          loadDataPayload: loadDataExtra(gaTable.length, 0, mode === 'full'),
          isParamObject: false,
        });
      }
      if (assocTable && assocTable.length && !declaredTableObjIdxs.has(2)) {
        relmemJobs.push({
          objIdx: 2,
          label: 'Association table',
          table: assocTable,
          offset: 0,
          presetBase: null,
          loadDataPayload: loadDataExtra(assocTable.length, 0, mode === 'full'),
          isParamObject: false,
        });
      }
      // Object 3's own write-trigger policy and caveats: see
      // DownloadExtra.groupObjectTable's doc comment.
      if (
        extra?.groupObjectTable &&
        extra.groupObjectTable.length &&
        !declaredTableObjIdxs.has(3)
      ) {
        relmemJobs.push({
          objIdx: 3,
          label: 'Group Object Table',
          table: extra.groupObjectTable,
          offset: 0,
          presetBase: null,
          loadDataPayload: loadDataExtra(
            extra.groupObjectTable.length,
            0,
            mode === 'full',
          ),
          isParamObject: false,
        });
      }

      // Every interface-object write this download needs - the parameter
      // object (WriteRelMem, above) and the undeclared GA/Association/
      // Object 3 tables (above) - runs through the SAME batched phases
      // together: Unload for every object first, then StartLoading+
      // LoadData for every object, and only THEN PID_TABLE_REFERENCE
      // (property 7) resolution + the real memory write for every object,
      // then LoadCompleted for every object. Never one object's whole
      // cycle run to completion before starting the next.
      //
      // Found via two real ETS Full Download captures against a freshly-
      // reset device (2026-08-30): the first (GA/Association/Object 3
      // only) showed Object 3 - last in an earlier, per-object-sequential
      // version of this code - come back with PID 7 still unallocated even
      // after its own correctly-formed Unload/StartLoading/LoadData cycle,
      // on a real device, in a real run; the apparent "~1.5s gap before
      // Object 3's PID 7 read" in that capture wasn't a deliberate
      // per-object wait, it was real ETS working through the other two
      // objects' own StartLoading/LoadData first. A second capture,
      // re-examined after the parameter object hit the identical failure
      // mode (a real koolenex Full Download attempt against the same
      // freshly-reset device returned "segment_unallocated" for the
      // parameter object itself, confirmed not caused by TCP reconnection
      // or the device still being in physical programming mode - both
      // ruled out live), showed the parameter object's own Unload/
      // StartLoading/LoadData interleaved into the exact same batch as the
      // other three, not run separately or first.
      //
      // Partial mode: peek each object's real base and current content
      // BEFORE starting any load-state transition, and drop it from the
      // batch entirely if the device already matches - same rationale as
      // before this refactor. A job with a caller-supplied `presetBase`
      // (the /bus/write-memory debug tool) peeks with that address
      // directly instead of resolving PID 7 first. No real Partial
      // Download example of a GA/Association/Object-3 table write exists
      // yet (see the reference doc's caveat below), so extending this to
      // those three objects is a best-effort extrapolation, not something
      // independently confirmed for them - the parameter object's own
      // partial-mode behavior is unchanged from before this refactor.
      //
      // Confirmed end to end on real hardware, 2026-08-30, alongside the
      // memory-write flow-control fix below (both were needed together):
      // a real Full Download against a genuinely blank, factory-reset
      // device wrote all four objects cleanly in one run (no unallocated
      // skips), and a subsequent Verify read back the parameter memory
      // byte-for-byte matching (0 of 8178 bytes differing). See
      // docs/knx-device-write-protocol.md's timing/pacing section for the
      // consolidated writeup.
      let activeJobs: RelmemJob[] = relmemJobs;
      if (mode === 'partial') {
        activeJobs = [];
        for (const j of relmemJobs) {
          let resolvedPeekBase: number;
          if (j.presetBase != null) {
            resolvedPeekBase = j.presetBase;
          } else {
            const buf = await propRead(j.objIdx, 7);
            resolvedPeekBase = buf && buf.length >= 4 ? buf.readUInt32BE(0) : 0;
          }
          if (resolvedPeekBase) {
            const current = await this.readRegionInSession(
              fns,
              deviceAddr,
              resolvedPeekBase + j.offset,
              j.table.length,
              MEM_CHUNK,
            );
            if (current.equals(j.table)) {
              log(
                `ObjIdx=${j.objIdx} (${j.label}): partial mode, device already matches - skipping`,
              );
              continue;
            }
          }
          activeJobs.push(j);
        }
      }

      if (activeJobs.length) {
        anyRelSegmentLoaded = true;

        const loadCycleJobs = activeJobs.filter((j) => j.loadDataPayload);
        for (const j of loadCycleJobs) {
          log(`Unload ObjIdx=${j.objIdx} (${j.label})`);
          await lsmWrite(j.objIdx, LSM_EVENT.UNLOAD);
        }
        for (const j of loadCycleJobs) {
          log(`StartLoading ObjIdx=${j.objIdx} (${j.label})`);
          await lsmWrite(j.objIdx, LSM_EVENT.START_LOADING);
          log(`LoadData ObjIdx=${j.objIdx} Size=${j.table.length} (${j.label})`);
          await lsmWrite(j.objIdx, LSM_EVENT.LOAD_DATA, j.loadDataPayload!);
        }

        // Real live-test finding, 2026-08-31: "we don't seem to get a
        // progress bar... stuck at 0% for good 20/30 seconds, then jumps
        // to 100%" - the onProgress call in the chunk-write loop below was
        // gated to isParamObject only, so the GA/Association/Object 3
        // tables (each their own real job here, often the bulk of a Full
        // Download to a genuinely blank device - see the undeclared-table
        // write mechanism this project's own docs describe at length)
        // reported nothing at all while they wrote, only the (frequently
        // much smaller, or completely absent for this app) parameter
        // object ever moved the bar. Tracked here as real cumulative
        // progress across every active job, not just one - a resumed
        // count across objects, not each restarting its own 0-80% scale
        // per object (which would visibly jump backward every time a new
        // object's writes began).
        const totalActiveBytes = activeJobs.reduce(
          (sum, jj) => sum + jj.table.length,
          0,
        );
        let bytesWrittenSoFar = 0;
        const resolvedBase = new Map<number, number>();
        for (const j of activeJobs) {
          let base: number;
          if (j.presetBase != null) {
            base = j.presetBase;
          } else if (j.loadDataPayload) {
            // A small pacing delay before each PID_TABLE_REFERENCE read.
            // Real-hardware testing (2026-08-30) against a genuinely blank
            // device found the real underlying cause of an object's reads
            // going unanswered was a large preceding memory write leaving
            // the device processing a response backlog (see the real fix
            // in the write loop below - it now waits for each chunk's own
            // response instead of firing a fixed pace, which was the
            // actual root cause). This delay is a low-risk, cheap
            // defensive margin between consecutive objects' reads within
            // the same batch phase, kept alongside that fix rather than
            // independently proven necessary on its own.
            await delay(30);
            const baseBuf = await propRead(j.objIdx, 7);
            base = baseBuf && baseBuf.length >= 4 ? baseBuf.readUInt32BE(0) : 0;
            if (!base) {
              log(
                `ObjIdx=${j.objIdx} (${j.label}): PID_TABLE_REFERENCE unallocated - skipping write`,
              );
              continue;
            }
          } else {
            // No RelSegment declaration and no caller-supplied base - the
            // object is already loaded/known; matches the pre-refactor
            // behavior of writing to address 0 + offset in this case
            // (a real caller is expected to always supply a base here).
            base = 0;
          }
          resolvedBase.set(j.objIdx, base);
          for (let off = 0; off < j.table.length; off += MEM_CHUNK) {
            const chunk = j.table.subarray(off, off + MEM_CHUNK);
            const seq = nextSeq();
            const addr = base + j.offset + off;
            // A_Memory_Write only carries a 16-bit address - same problem as
            // the read side (see readRegionInSession). A resolved relmem
            // base can land above 0xFFFF, in which case the legacy service
            // silently truncates to the wrong (low) address and writes
            // nothing meaningful to the real target. Originally this only
            // switched to A_MemoryExtended_Write when the address itself
            // didn't fit in 16 bits. Correction: a real captured ETS
            // Partial Download against 1.1.9 (address 0x5F53, well within
            // 16 bits) still used A_MemoryExtended_Write exclusively -
            // confirmed via byte-level replay: a verbatim replay of ETS's
            // own captured frames (all-extended) persisted correctly on
            // real hardware, while koolenex's own reconstruction (legacy
            // Memory_Write for this same address, otherwise byte-identical
            // count/address/data) silently failed to persist, twice,
            // reproducibly. Root cause: this is a SystemB-family device
            // (mask 0x07B0), which apparently only honors
            // A_MemoryExtended_Write on the RelSegment-gated download path
            // regardless of address size. Not a universal rule though -
            // gate on `useExtendedMemory` (the device's real mask version,
            // read above) rather than hardcoding "always extended": use
            // extended unconditionally for a confirmed SystemB device,
            // fall back to the original per-chunk address-size heuristic
            // for anything else (unrecognized/unread mask, or a genuine
            // legacy Bcu1/Bcu2/System-7 device, which real hardware has
            // never confirmed either way for this specific write path).
            const useExtendedForThisChunk = useExtendedMemory ?? addr > 0xffff;
            const apdu = useExtendedForThisChunk
              ? apduMemoryExtendedWrite(seq, addr, chunk)
              : apduConnected(
                  seq,
                  'Memory_Write',
                  Buffer.concat([
                    Buffer.from([chunk.length, (addr >> 8) & 0xff, addr & 0xff]),
                    chunk,
                  ]),
                );
            const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false);
            // Real bug, found live 2026-08-30: this loop used to fire each
            // chunk with a flat 30ms pace and never confirm the device
            // actually kept up (these writes weren't response-waited at
            // all, unlike propRead/propWrite). For a large write (the
            // parameter object's memory, hundreds of chunks) a real device
            // was found genuinely backlogged: its own response
            // confirmations kept trickling in for ~9s after we'd finished
            // BLASTING the whole burst - moving straight on to another
            // object's PID 7 read while the device was still digesting
            // that backlog meant the read queued behind it and timed out
            // on our side, not a protocol/sequencing bug. Confirmed
            // against a real ETS capture of this exact write (2026-08-30):
            // ETS never blasts chunks either - it waits for each one's own
            // real response (response times observed varying 56ms-279ms
            // as the write progressed) before sending the next, adapting
            // automatically to whatever the device's real pace is, no
            // fixed delay involved at all. Same real response APCI
            // (MemoryExtended_Write_Response / Memory_Response) either
            // way; not fatal if a chunk's response never arrives (log and
            // continue - a real device may legitimately not always
            // respond, matching propWrite's own tolerance elsewhere).
            const respP = waitResponse(
              useExtendedForThisChunk
                ? 'MemoryExtended_Write_Response'
                : 'Memory_Response',
              3000,
            );
            await this.sendCEMI(cemi);
            try {
              await respP;
            } catch (_e) {
              log(`No write response for ObjIdx=${j.objIdx} offset=${off} (continuing)`);
            }
            if (onProgress && totalActiveBytes > 0)
              onProgress({
                msg: `WriteRelMem ObjIdx=${j.objIdx} (${j.label}) ${off}/${j.table.length}`,
                pct: ((bytesWrittenSoFar + off) / totalActiveBytes) * 80,
              });
          }
          bytesWrittenSoFar += j.table.length;
          // Real ETS reads PID_PROGRAM_VERSION (property 13) on the
          // Application Program object early in its session, then writes
          // that SAME value back after its memory writes finish, right
          // before LoadCompleted - root-caused 2026-08-28 by doing a
          // complete, systematic pass over every frame in a real capture
          // (not just the frames already expected), after two prior real
          // fixes (load sequence, then authorization) still didn't make a
          // write persist. Working theory: LoadCompleted marks the SEGMENT
          // loaded, but this registers the freshly-loaded data as
          // belonging to a real, known application - without it the
          // device may discard the segment on restart despite
          // LoadCompleted confirming Loaded state. Only meaningful for the
          // Application Program object itself (objIdx 4 by KNX System 7
          // convention) - the GA/Association/Object 3 objects don't have a
          // program version to register. See docs/follow-ups/2026-08-28-
          // write-path-missing-load-sequence.md.
          if (j.isParamObject && j.loadDataPayload) {
            const version = await propRead(4, 13);
            if (version && version.length) {
              log(`PID_PROGRAM_VERSION=${version.toString('hex')} (write-back)`);
              await propWrite(4, 13, version);
            } else {
              log('Could not read PID_PROGRAM_VERSION - skipping write-back');
            }
          }
        }

        for (const j of loadCycleJobs) {
          if (!resolvedBase.has(j.objIdx)) continue; // unallocated - skipped above
          log(`LoadCompleted ObjIdx=${j.objIdx} (${j.label})`);
          await lsmWrite(j.objIdx, LSM_EVENT.LOAD_COMPLETED);
        }
      }

      // Real ETS ends a RelSegment-driven download with a device Restart
      // once every loaded object has been marked LoadCompleted - without it
      // a freshly-loaded segment isn't confirmed to actually apply
      // functionally, per the real capture this fix is based on. Only sent
      // if we actually did a load cycle above (nothing to restart for a
      // pure WriteProp/CompareProp/LoadImageProp download).
      if (anyRelSegmentLoaded) {
        // Real ETS itself waits roughly another second after LoadCompleted's
        // own response before sending Restart (see the doc above's "Restart
        // race" finding - even with propWrite now waiting for the response
        // itself, real ETS's extra margin here is real, observed behavior,
        // not just a safety guess this fix invented on top of it).
        await delay(1000);
        log('Restart');
        const seq = nextSeq();
        const apdu = apduConnected(seq, 'Restart');
        const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false);
        await this.sendCEMI(cemi);
      }

      log('Download complete');
      if (onProgress)
        onProgress({ msg: 'Download complete', pct: 100, done: true });
    });
  }

  // ── Identify ──────────────────────────────────────────────────────────────────

  async identify(deviceAddr: string): Promise<void> {
    if (!this.connected) throw new Error('Not connected');

    const memWrite = (seq: number, addr: number, dataByte: number): Buffer => {
      const extra = Buffer.from([
        0x01,
        (addr >> 8) & 0xff,
        addr & 0xff,
        dataByte,
      ]);
      return apduConnected(seq, 'Memory_Write', extra);
    };

    await this.managementSession(deviceAddr, async ({ nextSeq }) => {
      const seq0 = nextSeq();
      const on = buildCEMI(
        this.localAddr,
        deviceAddr,
        memWrite(seq0, 0x0060, 0x01),
        false,
      );
      await this.sendCEMI(on);
      await delay(3000);
      const seq1 = nextSeq();
      const off = buildCEMI(
        this.localAddr,
        deviceAddr,
        memWrite(seq1, 0x0060, 0x00),
        false,
      );
      await this.sendCEMI(off);
    });
  }

  // ── Device info ───────────────────────────────────────────────────────────────

  async readDeviceInfo(deviceAddr: string): Promise<DeviceInfo> {
    if (!this.connected) throw new Error('Not connected');

    const probe = await this._probeSingle(deviceAddr, 2000);
    if (!probe) throw new Error(`Device ${deviceAddr} did not respond`);

    const info: DeviceInfo = {
      descriptor: probe.descriptor,
      address: deviceAddr,
    };

    try {
      await this.managementSession(
        deviceAddr,
        async ({ waitResponse, nextSeq }) => {
          const propRead = async (
            objIdx: number,
            propId: number,
          ): Promise<Buffer | null> => {
            const seq = nextSeq();
            const apdu = apduPropertyValueRead(seq, objIdx, propId);
            const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false);
            await this.sendCEMI(cemi);
            const res = await waitResponse('OTHER', 2000);
            return res?.apduData || null;
          };

          const tryProp = async (
            propId: number,
            label: string,
            handler: (data: Buffer) => void,
          ): Promise<void> => {
            try {
              const data = await propRead(0, propId);
              if (data) handler(data);
            } catch (e) {
              logger.warn(
                'knx',
                `${deviceAddr} prop ${label} (${propId}) read failed`,
                {
                  error: (e as Error).message,
                },
              );
            }
          };

          await tryProp(11, 'serialNumber', (data) => {
            if (data.length >= 10)
              info.serialNumber = data.slice(4).toString('hex');
          });
          await tryProp(12, 'manufacturerId', (data) => {
            if (data.length >= 6) info.manufacturerId = data.readUInt16BE(4);
          });
          await tryProp(13, 'programVersion', (data) => {
            if (data.length >= 9) {
              const pv = data.slice(4);
              info.programVersion = {
                manufacturerId: pv.readUInt16BE(0),
                deviceType: pv.readUInt16BE(2),
                appVersion: pv[4]!,
              };
            }
          });
          await tryProp(15, 'orderInfo', (data) => {
            if (data.length > 4) {
              const raw = data.slice(4);
              const nullIdx = raw.indexOf(0);
              const text = (nullIdx >= 0 ? raw.slice(0, nullIdx) : raw)
                .toString('ascii')
                .trim();
              info.orderInfo = text || raw.toString('hex');
            }
          });
          await tryProp(78, 'hardwareType', (data) => {
            if (data.length >= 10)
              info.hardwareType = data.slice(4).toString('hex');
          });
          await tryProp(9, 'firmwareRevision', (data) => {
            if (data.length >= 5) info.firmwareRevision = data[4];
          });
        },
      );
    } catch (e) {
      info.error = (e as Error).message;
    }

    return info;
  }

  // ── Bus scan ──────────────────────────────────────────────────────────────────

  _probeSingle(
    deviceAddr: string,
    timeoutMs: number,
  ): Promise<{ descriptor: string } | null> {
    if (!this.connected) return Promise.resolve(null);
    return new Promise((resolve) => {
      let done = false;
      const finish = (result: { descriptor: string } | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.off('_mgmt', onMgmt);
        resolve(result);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      const onMgmt = (cemi: CemiFrame): void => {
        if (
          cemi.src === deviceAddr &&
          cemi.apciName === 'DeviceDescriptor_Response'
        )
          finish({ descriptor: cemi.apduData?.toString('hex') || '' });
      };
      this.on('_mgmt', onMgmt);
      const apdu = apduGroup('DeviceDescriptor_Read');
      const cemi = buildCEMI(this.localAddr, deviceAddr, apdu, false);
      this.sendCEMI(cemi).catch(() => {});
    });
  }

  scan(
    area: number,
    line: number,
    timeoutMs: number,
    onProgress?: (progress: ScanProgress) => void,
  ): Promise<Array<{ address: string; descriptor: string }>> {
    if (!this.connected) return Promise.reject(new Error('Not connected'));
    this._scanAbort = false;
    return (async () => {
      const found: Array<{ address: string; descriptor: string }> = [];
      for (let dev = 0; dev <= 255; dev++) {
        if (this._scanAbort) break;
        const addr = `${area}.${line}.${dev}`;
        const result = await this._probeSingle(addr, timeoutMs);
        if (result)
          found.push({ address: addr, descriptor: result.descriptor });
        if (onProgress)
          onProgress({
            address: addr,
            reachable: !!result,
            descriptor: result?.descriptor || null,
            done: dev + 1,
            total: 256,
          });
      }
      return found;
    })();
  }

  abortScan(): void {
    this._scanAbort = true;
  }

  status(): { connected: boolean; hasLib: boolean } {
    return { connected: this.connected, hasLib: true };
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
