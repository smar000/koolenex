import { createContext, useContext } from 'react';
import { normalizeDpt, dptInfo, dptToRefId, _i18nT } from './dpt.ts';
import type {
  DeviceStatus,
  ProjectFull,
  BusTelegram,
} from '../../shared/types.ts';
import type { VerifyDeviceResult } from './api.ts';
import type { VerifyCacheEntry } from './state.ts';

export type DptMode = 'numeric' | 'formal' | 'friendly';

export const DptCtx = createContext<DptMode>('numeric');
export type PinFn = ((wtype: string, address: string) => void) | null;
export const PinContext = createContext<PinFn>(null);

/**
 * Three display modes for DPT:
 *   numeric  — "DPST-9-1"
 *   formal   — "DPT_Value_Temp"
 *   friendly — "temperature (°C)"
 * Hover shows the other two.
 */
export function useDpt(): {
  display: (raw: string | number) => string;
  hover: (raw: string | number) => string | undefined;
} {
  const mode = useContext(DptCtx);

  const formats = (raw: string | number) => {
    if (!raw) return { numeric: '', formal: '', friendly: '' };
    const norm = normalizeDpt(raw);
    const info = dptInfo(raw);
    const refId = dptToRefId(raw);
    const translated = refId && _i18nT(refId);

    const numeric = String(raw); // keep original format (e.g., "DPST-9-1" or "9.001")
    const formal = info.name || norm;
    const friendly = translated || info.text || '';
    return { numeric, formal, friendly };
  };

  return {
    display: (raw: string | number) => {
      if (!raw) return '—';
      const f = formats(raw);
      if (mode === 'formal') return f.formal || String(raw);
      if (mode === 'friendly') return f.friendly || f.formal || String(raw);
      return f.numeric;
    },
    hover: (raw: string | number) => {
      if (!raw) return undefined;
      const f = formats(raw);
      const parts: string[] = [];
      if (mode !== 'numeric') parts.push(f.numeric);
      if (mode !== 'formal') parts.push(f.formal);
      if (mode !== 'friendly' && f.friendly) parts.push(f.friendly);
      return parts.filter(Boolean).join(' — ') || undefined;
    },
  };
}

// ── Project actions context ──────────────────────────────────────────────────
export interface ProjectActions {
  updateGA: (gaId: number, patch: Record<string, unknown>) => Promise<void>;
  renameGAGroup: (
    main: number,
    middle: number | null | undefined,
    name: string,
  ) => Promise<void>;
  updateDevice: (
    deviceId: number,
    patch: Record<string, unknown>,
  ) => Promise<void>;
  updateSpace: (
    spaceId: number,
    patch: Record<string, unknown>,
  ) => Promise<void>;
  createTopology: (body: Record<string, unknown>) => Promise<unknown>;
  updateTopology: (
    topoId: number,
    patch: Record<string, unknown>,
  ) => Promise<void>;
  deleteTopology: (topoId: number) => Promise<void>;
  createSpace: (body: Record<string, unknown>) => Promise<unknown>;
  deleteSpace: (spaceId: number) => Promise<void>;
  createGA: (body: Record<string, unknown>) => Promise<unknown>;
  deleteGA: (gaId: number) => Promise<void>;
  addDevice: (body: Record<string, unknown>) => Promise<unknown>;
  updateComObjectGAs: (coId: number, body: unknown) => Promise<void>;
  addScannedDevice: (address: string) => Promise<void>;
}

export const ProjectActionsCtx = createContext<ProjectActions | null>(null);

export function useProjectActions(): ProjectActions {
  const ctx = useContext(ProjectActionsCtx);
  if (!ctx)
    throw new Error('useProjectActions must be used within ProjectActionsCtx');
  return ctx;
}

// ── Bus actions context ──────────────────────────────────────────────────────
export interface BusActions {
  connect: (host: string, port: number) => Promise<unknown>;
  connectUsb: (devicePath: string) => Promise<unknown>;
  disconnect: () => Promise<void>;
  deviceStatus: (deviceId: number, status: DeviceStatus) => Promise<void>;
  write: (ga: string, value: unknown, dpt: unknown) => Promise<void>;
  clearTelegrams: () => Promise<void>;
}

export const BusActionsCtx = createContext<BusActions | null>(null);

export function useBusActions(): BusActions {
  const ctx = useContext(BusActionsCtx);
  if (!ctx) throw new Error('useBusActions must be used within BusActionsCtx');
  return ctx;
}

// ── Undo context ─────────────────────────────────────────────────────────────
export interface UndoActions {
  undoStackRef: React.MutableRefObject<
    { desc: string; detail: string; undo: () => Promise<void> }[]
  >;
  undoCount: number;
  undoOpen: boolean;
  setUndoOpen: (v: boolean | ((p: boolean) => boolean)) => void;
  performUndo: (count?: number) => Promise<void>;
  toast: string | null;
  setToast: (v: string | null) => void;
}

export const UndoCtx = createContext<UndoActions | null>(null);

export function useUndo(): UndoActions {
  const ctx = useContext(UndoCtx);
  if (!ctx) throw new Error('useUndo must be used within UndoCtx');
  return ctx;
}

// ── App data contexts (split to avoid re-renders) ──────────────────────────
// ProjectData changes on project load/edit — relatively infrequent.
// LiveData changes on every telegram/bus event — high frequency on active bus.
// Views that only need project data subscribe to AppDataCtx and won't
// re-render when telegrams arrive.

export interface BusStatus {
  connected: boolean;
  host: string | null;
  hasLib: boolean;
  type?: string;
  port?: number;
  path?: string;
}

export interface AppData {
  projectData: ProjectFull | null;
  activeProjectId: number | null;
}

export const AppDataCtx = createContext<AppData | null>(null);

export function useAppData(): AppData {
  const ctx = useContext(AppDataCtx);
  if (!ctx) throw new Error('useAppData must be used within AppDataCtx');
  return ctx;
}

export interface LiveData {
  busStatus: BusStatus;
  telegrams: BusTelegram[];
}

export const LiveDataCtx = createContext<LiveData | null>(null);

export function useLiveData(): LiveData {
  const ctx = useContext(LiveDataCtx);
  if (!ctx) throw new Error('useLiveData must be used within LiveDataCtx');
  return ctx;
}

// ── Verify-result cache — shared across every view that can trigger a
// /bus/verify-device call (Programming's "Verify" button, the Device vs
// Project comparison page), keyed by device id, so switching devices or
// views reuses the last real read instead of forcing a fresh ~2-minute bus
// read. Callers decide when to force a refresh (e.g. an explicit button).
export interface VerifyProgress {
  bytesRead: number;
  totalBytes: number;
  pct: number;
}

export interface VerifyCache {
  cache: Record<number, VerifyCacheEntry>;
  setResult: (deviceId: number, result: VerifyDeviceResult) => void;
  // Live progress while a verify read is in flight, keyed by device
  // *address* (progress events only carry the address, not the id) - not
  // persisted like `cache`, just transient UI state updated from the
  // verify:progress WebSocket messages a verify-device call now broadcasts.
  progress: Record<string, VerifyProgress>;
}

export const VerifyCacheCtx = createContext<VerifyCache | null>(null);

export function useVerifyCache(): VerifyCache {
  const ctx = useContext(VerifyCacheCtx);
  if (!ctx)
    throw new Error('useVerifyCache must be used within VerifyCacheCtx');
  return ctx;
}

// ── Programming page's operation log — lifted out of ProgrammingView's own
// state so it survives navigating away and back (that page previously reset
// its log to [] on every remount). In-memory only, not localStorage - a real
// page reload still clears it like everything else in the app, this just
// stops navigation between routes from doing the same thing. Capped at
// PROGRAMMING_LOG_CAP entries (oldest dropped) so a long-running session
// doesn't grow this unbounded; no time-based expiry, since the cap plus the
// natural reset on reload is enough for how this log is actually used.
export const PROGRAMMING_LOG_CAP = 300;

export interface ProgrammingLog {
  entries: string[];
  add: (line: string) => void;
  clear: () => void;
}

export const ProgrammingLogCtx = createContext<ProgrammingLog | null>(null);

export function useProgrammingLog(): ProgrammingLog {
  const ctx = useContext(ProgrammingLogCtx);
  if (!ctx)
    throw new Error('useProgrammingLog must be used within ProgrammingLogCtx');
  return ctx;
}
