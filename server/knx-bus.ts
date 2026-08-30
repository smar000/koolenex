/**
 * KNX Bus Manager
 * Facade over KnxIpConnection (UDP) and KnxUsbConnection (USB HID).
 */

import EventEmitter from 'events';
import { logger } from './log.ts';
import {
  KnxConnection,
  type DownloadStep,
  type DownloadProgress,
  type DownloadExtra,
  type ScanProgress,
  type DeviceInfo,
} from './knx-connection.ts';
import {
  KnxConnection as KnxIpConnection,
  type IpTransportProtocol,
} from './knx-protocol.ts';
import { KnxUsbConnection } from './knx-usb.ts';
import type { Telegram } from '../shared/types.ts';

interface WebSocketClient {
  readyState: number;
  send(data: string): void;
}

interface WebSocketServer {
  clients: Set<WebSocketClient>;
}

class KnxBusManager extends EventEmitter {
  connection: KnxConnection | null;
  connected: boolean;
  host: string | null;
  port: number | null;
  type: 'udp' | 'tcp' | 'usb' | null;
  projectId: number | string | null;
  _wss: WebSocketServer | null;
  _remapFn: ((telegram: Telegram) => Telegram) | null;
  _reconnecting: Promise<{ host: string; port: number; type: 'udp' | 'tcp' }> | null;

  constructor() {
    super();
    this.connection = null;
    this.connected = false;
    this.host = null;
    this.port = 3671;
    this.type = null;
    this.projectId = null;
    this._wss = null;
    this._remapFn = null;
    this._reconnecting = null;
  }

  /** Set a function that remaps telegram src/dst addresses (for demo mode) */
  setRemapper(fn: (telegram: Telegram) => Telegram): void {
    this._remapFn = fn;
  }

  attachWSS(wss: WebSocketServer): void {
    this._wss = wss;
  }

  broadcast(type: string, payload: Record<string, unknown>): void {
    if (!this._wss) return;
    const msg = JSON.stringify({ type, ...payload });
    this._wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        try {
          client.send(msg);
        } catch (_) {}
      }
    });
  }

  _attachEvents(conn: KnxConnection): void {
    conn.on('telegram', (...args: unknown[]) => {
      const telegram = args[0] as Telegram;
      const tg = { ...telegram, projectId: this.projectId ?? undefined };
      const mapped = this._remapFn ? this._remapFn(tg) : tg;
      this.broadcast('knx:telegram', {
        telegram: mapped,
        projectId: this.projectId,
      } as Record<string, unknown>);
      this.emit('telegram', mapped);
    });

    conn.on('disconnected', () => {
      this.connected = false;
      this.broadcast('knx:disconnected', {});
    });

    conn.on('error', (...args: unknown[]) => {
      this.connected = false;
      this.broadcast('knx:error', { error: String(args[0]) });
    });
  }

  connect(
    host: string,
    port: number,
    projectId?: number | string | null,
    protocol: IpTransportProtocol = 'auto',
  ): Promise<{ host: string; port: number; type: 'udp' | 'tcp' }> {
    if (this.connection) this.disconnect();

    this.host = host;
    const resolvedPort = port || 3671;
    this.port = resolvedPort;
    this.projectId = projectId ?? null;

    const conn = new KnxIpConnection();
    this._attachEvents(conn);

    return conn.connect(host, resolvedPort, undefined, protocol).then(() => {
      this.connection = conn;
      this.connected = true;
      // Reflects what connect() actually negotiated ('auto' may have
      // resolved to either) - see knx-protocol.ts's TCP-first/UDP-fallback
      // logic.
      const negotiated = conn.transport ?? 'udp';
      this.type = negotiated;
      logger.info(
        'knx',
        `Connected to ${host}:${resolvedPort} (${negotiated})`,
      );
      this.broadcast('knx:connected', {
        host,
        port: resolvedPort,
        type: negotiated,
      });
      return { host, port: resolvedPort, type: negotiated };
    });
  }

  connectUsb(
    devicePath: string,
    projectId?: number | string | null,
  ): Promise<Record<string, unknown>> {
    if (this.connection) this.disconnect();

    this.projectId = projectId ?? null;
    this.type = 'usb';
    this.host = null;
    this.port = null;

    const conn = new KnxUsbConnection();
    this._attachEvents(conn);

    return (conn.connect(devicePath) as Promise<Record<string, unknown>>).then(
      (info) => {
        this.connection = conn;
        this.connected = true;
        logger.info('knx', `Connected via USB: ${devicePath}`);
        this.broadcast('knx:connected', { type: 'usb', path: devicePath });
        return info;
      },
    );
  }

  /** List available KNX USB HID devices */
  listUsbDevices(): Record<string, unknown>[] {
    return KnxUsbConnection.listDevices();
  }

  /** List all HID devices (for debugging) */
  listAllHidDevices(): Record<string, unknown>[] {
    return KnxUsbConnection.listAllHidDevices();
  }

  disconnect(): void {
    if (this.connection) {
      try {
        this.connection.disconnect();
      } catch (_) {}
      this.connection = null;
    }
    this.connected = false;
    this.host = null;
    this.type = null;
  }

  /**
   * Transparently reconnects before a bus operation if the connection has
   * gone idle-dropped since the last one - a KNXnet/IP gateway may close an
   * idle TCP tunneling connection on its own after a period with no
   * traffic (see knx-protocol.ts). Rather than holding the connection open
   * indefinitely against a gateway-specific, unconfirmed idle timeout, the
   * bus reconnects using the last known host/port/transport on demand.
   * USB connections are not auto-reconnected (no default device path to
   * retry); callers get the usual "not connected" error for those.
   */
  async _ensureConnected(): Promise<void> {
    if (this.connected && this.connection) return;
    if (!this.host || this.type === 'usb') {
      throw new Error('Not connected to KNX bus');
    }
    if (!this._reconnecting) {
      this._reconnecting = this.connect(
        this.host,
        this.port ?? 3671,
        this.projectId,
        (this.type ?? 'auto') as IpTransportProtocol,
      ).finally(() => {
        this._reconnecting = null;
      });
    }
    await this._reconnecting;
  }

  async write(
    groupAddress: string,
    value: unknown,
    dpt: string | number = '1',
  ): Promise<{
    ok: boolean;
    ga: string;
    value: unknown;
    dpt: string | number;
  }> {
    await this._ensureConnected();
    return this.connection!.write(groupAddress, value, dpt);
  }

  async read(groupAddress: string): Promise<{ ga: string; value: string }> {
    await this._ensureConnected();
    return this.connection!.read(groupAddress);
  }

  async ping(
    gaAddresses: string[],
    deviceAddress: string | null = null,
    timeoutMs: number = 2000,
  ): Promise<{ reachable: boolean; ga: string | null }> {
    await this._ensureConnected();
    return this.connection!.ping(gaAddresses, deviceAddress ?? '', timeoutMs);
  }

  async identify(deviceAddress: string): Promise<void> {
    await this._ensureConnected();
    return this.connection!.identify(deviceAddress);
  }

  async scan(
    area: number,
    line: number,
    timeoutMs: number = 200,
    onProgress?: (prog: ScanProgress) => void,
  ): Promise<Array<{ address: string; descriptor: string }>> {
    await this._ensureConnected();
    return this.connection!.scan(area, line, timeoutMs, onProgress);
  }

  abortScan(): void {
    if (this.connection) this.connection.abortScan();
  }

  async readDeviceInfo(deviceAddr: string): Promise<DeviceInfo> {
    await this._ensureConnected();
    return this.connection!.readDeviceInfo(deviceAddr);
  }

  async programIA(newAddr: string): Promise<{ ok: boolean; newAddr: string }> {
    await this._ensureConnected();
    return this.connection!.programIA(newAddr);
  }

  async checkProgrammingMode(
    timeoutMs?: number,
  ): Promise<{ address: string | null }> {
    await this._ensureConnected();
    return this.connection!.checkProgrammingMode(timeoutMs);
  }

  async readSerialNumbersInProgrammingMode(
    timeoutMs?: number,
  ): Promise<Array<{ serial: string; src: string }>> {
    await this._ensureConnected();
    return this.connection!.readSerialNumbersInProgrammingMode(timeoutMs);
  }

  async assignIndividualAddressBySerial(
    serial: Buffer,
    newAddr: string,
    timeoutMs?: number,
  ): Promise<{ ok: boolean; verified: boolean; address: string | null }> {
    await this._ensureConnected();
    return this.connection!.assignIndividualAddressBySerial(
      serial,
      newAddr,
      timeoutMs,
    );
  }

  async downloadDevice(
    deviceAddr: string,
    steps: DownloadStep[],
    gaTable: Buffer | null,
    assocTable: Buffer | null,
    paramMem: Buffer | null,
    onProgress?: (p: DownloadProgress) => void,
    extra?: DownloadExtra,
  ): Promise<void> {
    await this._ensureConnected();
    return this.connection!.downloadDevice(
      deviceAddr,
      steps,
      gaTable,
      assocTable,
      paramMem,
      onProgress,
      extra,
    );
  }

  async readMemory(
    deviceAddr: string,
    address: number,
    length: number,
    chunkSize?: number,
  ): Promise<Buffer> {
    await this._ensureConnected();
    return this.connection!.readMemory(deviceAddr, address, length, chunkSize);
  }

  /**
   * Replay a literal sequence of raw CEMI frame bytes, completely verbatim
   * - no automatic T_Connect/T_Disconnect wrapping, no APDU reconstruction.
   * The caller is expected to include the real captured Connect/Disconnect
   * control frames as part of `frames` itself (extracted straight from a
   * real ETS capture) - this method just fires each buffer through
   * sendCEMI() in order, nothing more. Debug-only.
   */
  async replayFrames(
    _deviceAddr: string,
    frames: Buffer[],
    delayMs: number = 30,
    onProgress?: (i: number, total: number) => void,
  ): Promise<void> {
    await this._ensureConnected();
    for (let i = 0; i < frames.length; i++) {
      await this.connection!.sendCEMI(frames[i]!);
      if (onProgress) onProgress(i + 1, frames.length);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  async readMemoryMany(
    deviceAddr: string,
    regions: Array<{ address: number; length: number }>,
    chunkSize?: number,
    onChunk?: (bytesRead: number) => void,
  ): Promise<Buffer[]> {
    await this._ensureConnected();
    return this.connection!.readMemoryMany(
      deviceAddr,
      regions,
      chunkSize,
      onChunk,
    );
  }

  // Extended memory read (A_MemoryExtended_Read, 0x1FD) for System B / System 7
  // devices that do not answer the legacy A_Memory_Read. Exposed here so the
  // capability is reachable from routes; see the note in /bus/verify-device.
  async readMemoryExtended(
    deviceAddr: string,
    address: number,
    length: number,
    chunkSize?: number,
  ): Promise<Buffer> {
    await this._ensureConnected();
    return this.connection!.readMemoryExtended(
      deviceAddr,
      address,
      length,
      chunkSize,
    );
  }

  async readProperty(
    deviceAddr: string,
    objIdx: number,
    propId: number,
  ): Promise<Buffer> {
    await this._ensureConnected();
    return this.connection!.readProperty(deviceAddr, objIdx, propId);
  }

  async readPropertyMany(
    deviceAddr: string,
    reads: Array<{ objIdx: number; propId: number }>,
  ): Promise<Buffer[]> {
    await this._ensureConnected();
    return this.connection!.readPropertyMany(deviceAddr, reads);
  }

  status(): {
    connected: boolean;
    type: string | null;
    host: string | null;
    port: number | null;
    hasLib: boolean;
  } {
    return {
      connected: this.connected,
      type: this.type,
      host: this.host,
      port: this.port,
      hasLib: true,
    };
  }
}

export default KnxBusManager;
