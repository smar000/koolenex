import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { STATUS_COLOR } from '../theme.ts';
import {
  Btn,
  Spinner,
  TH,
  TD,
  SectionHeader,
  DeviceAddr,
  Badge,
} from '../primitives.tsx';
import { DeviceTypeIcon, IconSerial } from '../icons.tsx';
import { api } from '../api.ts';
import {
  useAppData,
  useBusActions,
  useProjectActions,
  useVerifyCache,
  useProgrammingLog,
} from '../contexts.ts';
import { DeviceCompareResults, displaySectionName } from './DeviceCompareResults.tsx';
import { AddressDeviceModal } from '../AddressDeviceModal.tsx';
import styles from './ProgrammingView.module.css';

export function ProgrammingView() {
  const { projectData: data } = useAppData();
  const { deviceStatus: onDeviceStatus } = useBusActions();
  const { updateDevice } = useProjectActions();
  const {
    cache: verifyCache,
    setResult: setVerifyResult,
    clearResult: clearVerifyResult,
    progress: verifyProgress,
    programProgress,
    clearProgramProgress,
  } = useVerifyCache();
  const COLMAP: Record<string, string> = {
    actuator: 'var(--actuator)',
    sensor: 'var(--sensor)',
    router: 'var(--router)',
    generic: 'var(--muted)',
  };
  // Real request 2026-08-31: the device-type icon's color had no
  // explanation on hover - operators had to be told, rather than being
  // able to see, what amber/blue/green meant.
  const DEVICE_TYPE_LABEL: Record<string, string> = {
    actuator: 'Actuator',
    sensor: 'Sensor',
    router: 'Router',
    generic: 'Generic device',
  };
  const [progress, setProgress] = useState<Record<string, { state: string }>>(
    {},
  );
  // A device download isn't one write, it's several in sequence (parameter
  // memory, then possibly GA table / Association table / Object 3 flags) -
  // the server's own progress is computed PER SEGMENT, not cumulatively
  // across the whole download (see server/knx-connection.ts's WriteRelMem
  // case: `pct: (off / mem.length) * 80`, local to whichever segment is
  // currently being written). So the raw signal genuinely climbs, resets to
  // ~0 when the next segment starts, climbs again, etc. Found live
  // 2026-08-29: "gets to 99%, then goes to 0 for a few seconds before
  // changing to 100%" is exactly that reset, right before the final
  // (small, fast) segment. Standard progress-bar practice regardless of the
  // cause: never let the DISPLAYED value move backward mid-run - track the
  // max seen per device, reset only when a new run starts.
  const programPctMaxRef = useRef<Record<string, number>>({});
  const { entries: log, add: addLog, clear: clearLog } = useProgrammingLog();
  const [verifyingIds, setVerifyingIds] = useState<Set<number>>(new Set());
  const [slideOverDevice, setSlideOverDevice] = useState<any | null>(null);
  const { devices = [] } = data || {};

  // ── Log sidebar: width-resizable via a drag handle on its left edge.
  // Width persists in localStorage so it survives reloads/navigation.
  const SIDEBAR_MIN = 180;
  const SIDEBAR_MAX = 520;
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem('programmingLogWidth'));
      if (saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX) return saved;
    } catch {}
    return 220;
  });
  const widthRef = useRef(sidebarWidth);
  const [resizing, setResizing] = useState(false);
  // Collapsed by default - the log pane was eating real width from the
  // device table (which isn't responsive enough to give it up gracefully
  // yet) for a log that's empty most of the time. Auto-opens itself the
  // moment there's something to show (a Verify or Program click).
  const [logOpen, setLogOpen] = useState(false);

  // ── Log panel orientation: vertical (right-docked, the original layout)
  // or horizontal (bottom-docked) - real request 2026-08-31, deliberately
  // its own independent size/preference from the vertical sidebar's width,
  // so switching back and forth doesn't lose either one's own resize.
  const SIDEBAR_HEIGHT_MIN = 120;
  const SIDEBAR_HEIGHT_MAX = 420;
  const [sidebarHeight, setSidebarHeight] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem('programmingLogHeight'));
      if (saved >= SIDEBAR_HEIGHT_MIN && saved <= SIDEBAR_HEIGHT_MAX)
        return saved;
    } catch {}
    return 180;
  });
  const heightRef = useRef(sidebarHeight);
  const [logOrientation, setLogOrientation] = useState<
    'vertical' | 'horizontal'
  >(() => {
    try {
      const saved = localStorage.getItem('programmingLogOrientation');
      if (saved === 'horizontal' || saved === 'vertical') return saved;
    } catch {}
    return 'vertical';
  });
  const toggleLogOrientation = () => {
    setLogOrientation((o) => {
      const next = o === 'vertical' ? 'horizontal' : 'vertical';
      try {
        localStorage.setItem('programmingLogOrientation', next);
      } catch {}
      return next;
    });
  };

  // How much width/height the log panel/collapsed strip currently reserves
  // on the right (vertical) or bottom (horizontal), so the slide-over (and
  // its scrim) can stop short of it instead of covering it - see the
  // comment at the slide-over below. Only one of the two is ever actually
  // used at a time (by orientation), but both are always computed since
  // each mode remembers its own independent size even while inactive.
  const logPanelWidth = logOpen ? sidebarWidth + 5 : 28;
  const logPanelHeight = logOpen ? sidebarHeight + 5 : 28;

  const onResizerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setResizing(true);
      document.body.style.userSelect = 'none';
      if (logOrientation === 'horizontal') {
        document.body.style.cursor = 'row-resize';
        const startY = e.clientY;
        const startHeight = sidebarHeight;
        const onMove = (ev: MouseEvent) => {
          const delta = startY - ev.clientY; // panel is at the bottom - dragging up grows it
          const next = Math.min(
            SIDEBAR_HEIGHT_MAX,
            Math.max(SIDEBAR_HEIGHT_MIN, startHeight + delta),
          );
          heightRef.current = next;
          setSidebarHeight(next);
        };
        const onUp = () => {
          setResizing(false);
          document.body.style.userSelect = '';
          document.body.style.cursor = '';
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          try {
            localStorage.setItem(
              'programmingLogHeight',
              String(heightRef.current),
            );
          } catch {}
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        return;
      }
      document.body.style.cursor = 'col-resize';
      const startX = e.clientX;
      const startWidth = sidebarWidth;
      const onMove = (ev: MouseEvent) => {
        const delta = startX - ev.clientX; // sidebar is on the right - dragging left widens it
        const next = Math.min(
          SIDEBAR_MAX,
          Math.max(SIDEBAR_MIN, startWidth + delta),
        );
        widthRef.current = next;
        setSidebarWidth(next);
      };
      const onUp = () => {
        setResizing(false);
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        try {
          localStorage.setItem(
            'programmingLogWidth',
            String(widthRef.current),
          );
        } catch {}
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [sidebarWidth, sidebarHeight, logOrientation],
  );

  const programDevice = async (
    deviceId: any,
    devAddr: string,
    mode: 'full' | 'partial' = 'full',
  ) => {
    setLogOpen(true);
    programPctMaxRef.current[deviceId] = 0;
    // Real bug, found live: resetting the ratchet above isn't enough on its
    // own - a device that finished at 100% in a PRIOR run leaves that
    // stale entry sitting in programProgress (context, WS-fed) until a
    // fresh program:progress message for this run overwrites it. On the
    // very first render after this function starts, the ratchet reads
    // that stale 100 as the "raw" signal (no new message has arrived yet)
    // and immediately clamps itself right back up to it, then stays stuck
    // there for the whole new download since nothing lower can move it.
    // Clearing the stale entry here closes that window.
    clearProgramProgress(devAddr);
    // `progress[deviceId]` now only tracks coarse state (running/done/error)
    // for the button/status-badge - the real percentage/message comes from
    // `programProgress[devAddr]` (context, fed by the server's own
    // program:progress WebSocket broadcasts) instead of a fake climb. Real
    // bug, found live 2026-08-29: the old code faked progress with a
    // setInterval capped at a hardcoded 90%, completely disconnected from
    // the real write - "shows 90% then sits there for a few minutes" was
    // exactly that fake cap, while the real (much slower) write continued
    // underneath it, unreported. Real progress was already being broadcast
    // by the server the whole time (server/routes/bus.ts's onProgress,
    // wired through knx-connection.ts's downloadDevice() calls) - the
    // client just never listened for it.
    setProgress((p) => ({ ...p, [deviceId]: { state: 'running' } }));
    addLog(
      `[${new Date().toLocaleTimeString()}] Downloading (${mode}) → ${devAddr}`,
    );
    try {
      const pid = data?.project?.id;
      const result = await api.busProgramDevice(devAddr, pid!, deviceId, mode);
      setProgress((p) => ({ ...p, [deviceId]: { state: 'done' } }));
      // Real request, 2026-08-31: "the log doesn't say that the download
      // was successful. We should show this in the logs, including
      // serial number of the device, and the number of bytes written."
      addLog(
        `[${new Date().toLocaleTimeString()}] ✓ Download successful (${mode}) → ${devAddr}` +
          (result.serialNumber ? `, serial ${result.serialNumber}` : '') +
          `, ${result.totalBytes} bytes written`,
      );
      onDeviceStatus(deviceId, 'programmed');
      // The server already persisted the read-back serial (see /bus/
      // program-device's own doc comment) - sync it into local state too,
      // the same way onDeviceStatus above syncs `status`, so the Verify
      // button (gated on serial_number - real user confirmation, same
      // day: "we should have both address and serial number for a device
      // before we enable verify") reflects it immediately, not just after
      // a reload.
      if (result.serialNumber) {
        try {
          await updateDevice(deviceId, { serial_number: result.serialNumber });
        } catch (e: any) {
          // Real, defensive fix: this previously swallowed any failure
          // silently (fire-and-forget with an empty .catch()) - the
          // server-side write already succeeded at this point, so a
          // failure here is purely "the local badge didn't refresh",
          // genuinely worth knowing about (a reload would still show it
          // correctly, since the DB write already happened) rather than
          // vanishing with no trace.
          addLog(
            `[${new Date().toLocaleTimeString()}] Serial recorded on the device, but the project record didn't refresh locally → ${e.message} (a reload will show it correctly)`,
          );
        }
      }
      // A successful write just changed the device's real content - the
      // cached verify result (if any) now describes the PRE-write state and
      // would otherwise keep showing until the user manually hits "clear
      // cache" or re-verifies successfully. Found live: a real Program
      // finished, but the compare page kept showing the old differences as
      // if nothing had happened. Drop it so the page reverts to "not yet
      // verified" rather than silently-stale data.
      clearVerifyResult(deviceId);
    } catch (err: any) {
      setProgress((p) => ({ ...p, [deviceId]: { state: 'error' } }));
      addLog(
        `[${new Date().toLocaleTimeString()}] Download failed (${mode}) → ${devAddr} — ${err.message}`,
      );
    }
  };

  const verifyDevice = async (deviceId: any, devAddr: string) => {
    setLogOpen(true);
    setVerifyingIds((s) => new Set(s).add(deviceId));
    addLog(
      `[${new Date().toLocaleTimeString()}] Verifying (read-only) → ${devAddr}`,
    );
    try {
      const pid = data?.project?.id;
      const r = await api.busVerifyDevice(devAddr, pid!, deviceId);
      setVerifyResult(deviceId, r);
      // Real gap found live 2026-08-29: `status` (Programmed/Modified/
      // Unassigned - the top summary badges and this button's own color)
      // was ONLY ever set by a successful Program action, never by Verify -
      // so a real Verify showing genuine differences left the device still
      // reading "Programmed" (or whatever it was before), and the Modified
      // count never populated through normal use at all. Verify now updates
      // the same persistent status Program does, so it reflects live
      // read-back state, not just "was this ever successfully programmed
      // once." Deliberately does NOT touch 'unassigned' - only match/no
      // match, not "never verified".
      onDeviceStatus(deviceId, r.match ? 'programmed' : 'modified');
      // r.match now accounts for decoded rows (GA table / communication
      // flags, i.e. Object 3) as well as raw parameter-memory bytes (see
      // docs/knx-device-write-protocol.md Part 21, koolenex repo).
      // `totalDiffering`/`totalBytes` are DELIBERATELY scoped to just the
      // named-parameter memory region - GA table, Association table, and
      // Object 3 are each read from their own separate memory address (see
      // the `undeclaredTableMem` comment in server/routes/bus.ts) - so it's
      // entirely possible, and not a contradiction, for parameter memory to
      // match in full while a GA or flags row still differs. Object 3
      // additionally reports its OWN raw byte totals (`flagsTotalBytes`/
      // `flagsDifferingBytes`, added 2026-08-29) - quote a real "N/M bytes
      // match" figure for it too, not just a count of differing named rows.
      const scopes = [
        `parameter memory ${r.totalBytes - r.totalDiffering}/${r.totalBytes} bytes match`,
      ];
      if (r.flagsTotalBytes !== undefined) {
        scopes.push(
          `communication flags ${r.flagsTotalBytes - (r.flagsDifferingBytes ?? 0)}/${r.flagsTotalBytes} bytes match`,
        );
      }
      // GA links (and Object 3 itself, when its byte totals above already
      // aren't enough to make a real mismatch obvious - e.g. bytes match but
      // a decoded row still differs) don't have their own byte-level total
      // at all, so name them separately rather than let a mismatch there go
      // unmentioned just because there's no number to attach to it. Counted,
      // not just named - a bare "Communication Flags differ" (no number)
      // was reported as unhelpfully vague, matching the same badge wording
      // used above the row table ("Comm Object" for Object 3's rows, "GA"
      // for Group Addresses).
      const sectionWord = (name: string): string =>
        name === 'Communication Flags'
          ? 'Comm Object'
          : name === 'Group Addresses'
            ? 'GA'
            : name;
      const mismatchCountsBySection = new Map<string, number>();
      for (const d of r.decoded ?? []) {
        if (d.match === false) {
          const name = displaySectionName(d.section);
          mismatchCountsBySection.set(
            name,
            (mismatchCountsBySection.get(name) ?? 0) + 1,
          );
        }
      }
      const mismatchedSections = [...mismatchCountsBySection.entries()]
        .filter(
          ([name]) =>
            !(
              name === 'Communication Flags' &&
              r.flagsTotalBytes !== undefined &&
              r.flagsDifferingBytes === 0
            ),
        )
        .map(
          ([name, count]) =>
            `${count} ${sectionWord(name)}${count === 1 ? '' : 's'}`,
        );
      // No leading match/mismatch symbol - the byte-match figures and any
      // named differing sections already say whether it matched, without
      // needing a separate glyph or color to repeat the same information
      // (real request 2026-08-31: log entries shouldn't rely on
      // color/tick to carry the "did this succeed" signal at all).
      const msg =
        `Verified → ${devAddr} — ${scopes.join('; ')}` +
        (mismatchedSections.length ? `; ${mismatchedSections.join(', ')} differ` : '');
      addLog(`[${new Date().toLocaleTimeString()}] ${msg}`);
      // Slide over to show the full comparison as soon as the read completes,
      // auto-closing the log panel (per explicit request) so the slide-over
      // isn't fighting the log for the same screen space right after it's
      // the thing the user actually wants to look at.
      const dev = devices.find((d: any) => d.id === deviceId) ?? null;
      setSlideOverDevice(dev);
      if (dev) setLogOpen(false);
    } catch (err: any) {
      addLog(
        `[${new Date().toLocaleTimeString()}] Verify failed → ${devAddr} — ${err.message}`,
      );
    } finally {
      setVerifyingIds((s) => {
        const next = new Set(s);
        next.delete(deviceId);
        return next;
      });
    }
  };

  const openComparison = (deviceId: any) => {
    const dev = devices.find((d: any) => d.id === deviceId) ?? null;
    setSlideOverDevice(dev);
    if (dev) setLogOpen(false);
  };

  // Real bug, flagged live 2026-08-29 (task_2abb6756): this used to fire
  // every device's programDevice() concurrently via .forEach (no await at
  // all) - a real risk of corrupting overlapping download sessions on the
  // single shared bus connection, which only ever supports one in-flight
  // transaction. Also mislabeled: "Program All Modified" was actually
  // filtering `status !== 'programmed'`, which silently swept in
  // 'unassigned' devices too - those have no confirmed prior write to
  // compare against and aren't what "Modified" means. Now: a real
  // sequential queue (await each device fully before starting the next),
  // scoped to status === 'modified' only, skipping any device with no
  // resolved individual address (can't be addressed at all yet - see
  // knx_serial_number_addressing_research memory for the real fix for
  // that case, not yet implemented).
  const [programmingAll, setProgrammingAll] = useState(false);
  const programmAll = async (mode: 'full' | 'partial') => {
    if (programmingAll) return;
    const targets = devices.filter(
      (d: any) =>
        d.status === 'modified' && d.individual_address && d.has_address,
    );
    if (!targets.length) return;
    setProgrammingAll(true);
    addLog(
      `[${new Date().toLocaleTimeString()}] Program All Modified (${mode}) — queued ${targets.length} device(s)`,
    );
    try {
      for (const d of targets) {
        await programDevice(d.id, d.individual_address, mode);
      }
    } finally {
      setProgrammingAll(false);
    }
  };

  // ── Full vs Partial download picker: a small popover anchored to
  // whichever Program button was clicked (a device row's own button, or
  // the page-level "Program All Modified"), rather than a page-level
  // setting or a split-button menu - explicit choice, per click, right
  // where the action happens. `downloadModePopoverFor` is either a device
  // id (row button) or the literal 'all' (header button); null means
  // closed.
  //
  // Real bug, found live 2026-08-30: an earlier version positioned this
  // with plain CSS (position:absolute against a wrapper div sitting in
  // the table's own DOM position). The table's containing .content panel
  // scrolls (table-layout:fixed forces horizontal scroll once the log
  // pane is open), and a position:absolute descendant of a scrolling
  // ancestor gets clipped by that ancestor's overflow - not just visually
  // cramped, its trailing text was cut off outright rather than wrapping,
  // which is exactly what showed up live. Fixed by rendering the popover
  // through a portal into document.body, positioned with `fixed`
  // coordinates computed from the real anchor's on-screen rect
  // (anchorRefs, one per row + the header button) - a portal is
  // unaffected by any ancestor's overflow/clipping, by definition.
  const [downloadModePopoverFor, setDownloadModePopoverFor] = useState<
    number | 'all' | null
  >(null);
  const anchorRefs = useRef<Map<number | 'all', HTMLDivElement>>(new Map());
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [popoverPos, setPopoverPos] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const DOWNLOAD_POPOVER_WIDTH = 300;

  useEffect(() => {
    if (downloadModePopoverFor === null) {
      setPopoverPos(null);
      return;
    }
    const place = () => {
      const anchor = anchorRefs.current.get(downloadModePopoverFor);
      if (!anchor) return;
      const rect = anchor.getBoundingClientRect();
      const left = Math.max(
        8,
        Math.min(
          rect.right - DOWNLOAD_POPOVER_WIDTH,
          window.innerWidth - DOWNLOAD_POPOVER_WIDTH - 8,
        ),
      );
      setPopoverPos({ top: rect.bottom + 6, left });
    };
    place();
    const onDocClick = (e: MouseEvent) => {
      if (!popoverRef.current?.contains(e.target as Node)) {
        setDownloadModePopoverFor(null);
      }
    };
    // Closes rather than tracks on scroll/resize (any nested scroll
    // container, via capture:true) - simpler than continuously
    // repositioning a short-lived menu, and avoids it drifting away from
    // its anchor mid-scroll.
    const onScrollOrResize = () => setDownloadModePopoverFor(null);
    document.addEventListener('mousedown', onDocClick);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [downloadModePopoverFor]);

  const chooseDownloadMode = (mode: 'full' | 'partial') => {
    const target = downloadModePopoverFor;
    setDownloadModePopoverFor(null);
    if (target === null) return;
    if (target === 'all') {
      programmAll(mode);
      return;
    }
    const dev = devices.find((d: any) => d.id === target);
    if (dev) programDevice(dev.id, dev.individual_address, mode);
  };

  // 'scan' = the page-level "Scan for New Device" button (no row context,
  // general discovery/bulk-match workflow); a number = opened from a
  // specific row's serial icon, pre-selecting that device but still
  // allowing a different match if the scan turns up something else.
  // Also opened by clicking the "-.-.-" placeholder badge itself (see
  // DeviceAddr's onAssignClick below) - AddressDeviceModal's lockedNoAddress
  // case handles a device with has_address=0 directly; the separate
  // AssignProjectAddressModal this used to open is gone (merged in, 2026-
  // 08-31 - real user feedback: "let's combine address edit and serial
  // edit into the one popup").
  const [addressModalFor, setAddressModalFor] = useState<number | 'scan' | null>(
    null,
  );

  return (
    <div
      className={`${styles.root} ${logOrientation === 'horizontal' ? styles.rootHorizontal : ''}`}
    >
      <div className={styles.main}>
        <SectionHeader
          title="Programming"
          actions={[
            <Btn
              key="address"
              onClick={() => setAddressModalFor('scan')}
              color="var(--accent)"
            >
              ⟲ Scan for New Device
            </Btn>,
            <div
              key="all"
              className={styles.downloadModeAnchor}
              ref={(el) => {
                if (el) anchorRefs.current.set('all', el);
                else anchorRefs.current.delete('all');
              }}
            >
              <Btn
                onClick={() =>
                  setDownloadModePopoverFor((v) => (v === 'all' ? null : 'all'))
                }
                color="var(--amber)"
                disabled={programmingAll}
              >
                {programmingAll ? '⋯ Programming…' : '▷ Program All Modified'}
              </Btn>
            </div>,
          ]}
        />
        <div className={styles.content}>
          {/* Shrunk from a giant stat-card grid (huge numbers + label below)
              to the app's standard small Badge pills, per explicit request
              2026-08-29 - this row was disproportionately large next to
              everything else on the page. */}
          <div className={styles.statBadgeRow}>
            {[
              [
                'Programmed',
                devices.filter((d: any) => d.status === 'programmed').length,
                STATUS_COLOR.programmed,
              ],
              [
                'Modified',
                devices.filter((d: any) => d.status === 'modified').length,
                STATUS_COLOR.modified,
              ],
              [
                'Unassigned',
                devices.filter((d: any) => d.status === 'unassigned').length,
                STATUS_COLOR.unassigned,
              ],
            ].map(([label, count, col]) => (
              <Badge
                key={label as string}
                label={`${count} ${label}`}
                color={col as string}
              />
            ))}
          </div>
          <table className={styles.table}>
            <thead>
              <tr>
                <TH className={styles.thDevice}>DEVICE</TH>
                <TH className={styles.thStatus}>STATUS</TH>
                <TH className={styles.thActions}></TH>
              </tr>
            </thead>
            <tbody>
              {devices.map((d: any) => {
                const prog = progress[d.id];
                const verifying = verifyingIds.has(d.id);
                const liveVerifyProgress = verifyProgress[d.individual_address];
                const liveProgramProgress =
                  programProgress[d.individual_address];
                // Real pct when the server has reported one for this device
                // yet; 0 before the first message arrives (e.g. the very
                // first onProgress call is msg-only, no pct - see
                // ProgramProgress's doc comment) rather than undefined,
                // which would render as a NaN-width bar. Clamped to never
                // move backward mid-run (programPctMaxRef, see its own doc
                // comment) - the raw signal resets to ~0 at the start of
                // each segment the download writes in sequence.
                const rawProgramPct = liveProgramProgress?.pct ?? 0;
                const prevMax = programPctMaxRef.current[d.id] ?? 0;
                const clampedProgramPct = Math.max(prevMax, rawProgramPct);
                if (prog?.state === 'running')
                  programPctMaxRef.current[d.id] = clampedProgramPct;
                const programPct =
                  prog?.state === 'done' ? 100 : clampedProgramPct;
                return (
                  <tr key={d.id} className="rh">
                    <TD>
                      {/* Address folded into the DEVICE cell as a small pill
                          (was its own ADDRESS column) - reclaims a column's
                          worth of width, which matters once the log pane is
                          open and .table's min-width forces horizontal
                          scroll (see .table's comment in the CSS module). */}
                      <span className={styles.devName}>
                        <DeviceTypeIcon
                          type={d.device_type}
                          style={{
                            color: COLMAP[d.device_type] || 'var(--muted)',
                          }}
                          title={
                            DEVICE_TYPE_LABEL[d.device_type] ||
                            'Generic device'
                          }
                        />
                        <DeviceAddr
                          device={d}
                          wtype="device"
                          className={styles.addrBadge}
                          // Opens the same combined AddressDeviceModal the
                          // serial icon does (not the old, separate
                          // AssignProjectAddressModal - merged in 2026-08-
                          // 31, see that component's own doc comment) -
                          // it already supports a locked target with no
                          // project address yet (lockedNoAddress).
                          onAssignClick={() => setAddressModalFor(d.id)}
                        />
                        {/* Serial-status indicator, added 2026-08-30: a
                            device can have a real project address and still
                            never have been physically commissioned - ETS
                            only ever learns a real unit's serial when its
                            programming button is pressed during a write, or
                            when entered by hand (see AddressDeviceModal) -
                            it is NOT always present just because the
                            imported project has a planned address. Always
                            opens AddressDeviceModal, regardless of
                            has_address (fixed 2026-08-31 - previously
                            routed a has_address=0 row into the address-
                            assignment modal instead, which was actually
                            inconsistent: this icon is about the SERIAL,
                            and AddressDeviceModal now has its own
                            capture-only layout for a device with no real
                            address yet - see its lockedNoAddress). */}
                        <span
                          className={styles.serialIcon}
                          style={{
                            color: !d.has_address
                              ? 'var(--amber)'
                              : d.serial_number
                                ? 'var(--green)'
                                : 'var(--amber)',
                            cursor: 'pointer',
                          }}
                          title={
                            !d.has_address
                              ? 'No serial captured yet — click to detect or enter one'
                              : d.serial_number
                                ? `Serial ${d.serial_number} — click to re-address`
                                : 'Not yet commissioned — no serial recorded. Click to address this device.'
                          }
                          onClick={() => setAddressModalFor(d.id)}
                        >
                          <IconSerial size={12} />
                        </span>
                        <span className={styles.devNameCol}>
                          <span className={styles.devNameText}>{d.name}</span>
                          {d.manufacturer && (
                            <span className={styles.mfrLabel}>
                              {d.manufacturer}
                            </span>
                          )}
                        </span>
                      </span>
                    </TD>
                    <TD>
                      <div className={styles.statusCol}>
                        {prog?.state === 'done' ? (
                          <Badge label="PROGRAMMED" color="var(--green)" />
                        ) : (
                          <Badge
                            label={d.status.toUpperCase()}
                            color={STATUS_COLOR[d.status] || 'var(--dim)'}
                          />
                        )}
                        {d.last_download && (
                          <span
                            className={styles.lastDownloadLabel}
                            title={`Last download to device: ${new Date(d.last_download).toLocaleString()}`}
                          >
                            D/L: {new Date(d.last_download).toLocaleDateString()}
                          </span>
                        )}
                      </div>
                    </TD>
                    <TD>
                      <div className={styles.rowActions}>
                        {/* Fixed-width slot, always rendered (empty when
                            there's no cached result yet) so Verify/Program
                            start at the same x position on every row -
                            View used to sit inline before Re-verify, which
                            pushed everything right only on rows that had a
                            cached result. Icon pair (View / clear cache)
                            rather than text so both fit without widening
                            the slot as much as two text buttons would. */}
                        <div className={styles.viewSlot}>
                          {verifyCache[d.id] && (
                            <>
                              <button
                                type="button"
                                className={styles.iconChipBtn}
                                onClick={() => openComparison(d.id)}
                                disabled={verifying}
                                title="View the last comparison result — no bus read"
                              >
                                👁
                              </button>
                              <button
                                type="button"
                                className={`${styles.iconChipBtn} ${styles.clearCacheBtn}`}
                                onClick={() => clearVerifyResult(d.id)}
                                disabled={verifying}
                                title="Clear the cached comparison result for this device — does not touch the device itself, only local cache"
                              >
                                🗑
                              </button>
                            </>
                          )}
                        </div>
                        <div className={styles.verifyBtnWrap}>
                          <Btn
                            className={`${styles.actionBtn}${verifying ? ' ' + styles.actionBtnRunning : ''}`}
                            onClick={() =>
                              verifyDevice(d.id, d.individual_address)
                            }
                            // Gating on serial_number (not just has_address/
                            // status) is deliberate, real user confirmation
                            // 2026-08-31: a physically-confirmed serial is
                            // the genuine "this exact unit was actually
                            // commissioned" signal, not merely "the project
                            // thinks a download happened". The real gap
                            // this surfaced (a plain Program/Full-Download
                            // never captured a serial at all, unlike the
                            // addressing flow) is fixed at the source
                            // instead - see /bus/program-device's own
                            // post-write serial read-back, server/routes/
                            // bus.ts.
                            disabled={
                              prog?.state === 'running' ||
                              verifying ||
                              !d.has_address ||
                              !d.serial_number
                            }
                            title={
                              !d.has_address
                                ? 'No individual address assigned yet'
                                : !d.serial_number
                                  ? 'Not yet commissioned — no serial recorded for this device'
                                  : verifying
                                  ? (liveVerifyProgress
                                      ? `${liveVerifyProgress.bytesRead}/${liveVerifyProgress.totalBytes} bytes`
                                      : 'Reading device…')
                                  : verifyCache[d.id]
                                    ? 'Read the device again and compare to the computed image — no writes'
                                    : 'Read the device and compare to the computed image — no writes'
                            }
                            // Same treatment as the Program button - the
                            // button's own background becomes the progress
                            // bar while a verify read is in flight, with the
                            // live percentage as its text. Previously paired
                            // with a separate floating popover (byte
                            // counter, its own mini bar) - removed, it read
                            // as messy/overlapping neighboring rows once the
                            // button itself already showed the percentage.
                            // The total byte count now goes into the log
                            // once at the start of the read instead (see
                            // verifyDevice()) for anyone who wants it.
                            style={
                              verifying && liveVerifyProgress
                                ? ({
                                    background: `linear-gradient(to right, color-mix(in srgb, var(--accent) 55%, transparent) 0%, color-mix(in srgb, var(--accent) 55%, transparent) ${Math.round(liveVerifyProgress.pct)}%, var(--surface) ${Math.round(liveVerifyProgress.pct)}%, var(--surface) 100%)`,
                                    color: 'var(--text)',
                                    cursor: 'wait',
                                    // Clips the flow animation's ::before
                                    // to just the filled portion (see
                                    // .actionBtnRunning, ProgrammingView.
                                    // module.css) - real request
                                    // 2026-08-31: it swept the whole
                                    // button regardless of real progress,
                                    // which didn't read as "part of the
                                    // progress bar".
                                    '--action-pct': `${Math.round(liveVerifyProgress.pct)}%`,
                                  } as CSSProperties)
                                : undefined
                            }
                          >
                            {verifying ? (
                              liveVerifyProgress ? (
                                `${Math.round(liveVerifyProgress.pct)}%`
                              ) : (
                                <Spinner />
                              )
                            ) : verifyCache[d.id] ? (
                              'Re-verify'
                            ) : (
                              'Verify'
                            )}
                          </Btn>
                        </div>
                        <div
                          className={styles.downloadModeAnchor}
                          ref={(el) => {
                            if (el) anchorRefs.current.set(d.id, el);
                            else anchorRefs.current.delete(d.id);
                          }}
                        >
                        <Btn
                          className={`${styles.actionBtn}${prog?.state === 'running' ? ' ' + styles.actionBtnRunning : ''}`}
                          onClick={() => {
                            // Real request 2026-08-30: only offer the
                            // Full/Partial choice when there's something a
                            // Partial Download could actually skip - a
                            // device with no known modifications (never
                            // downloaded, or already matching what was
                            // last written) has nothing to differentiate
                            // the two modes on, so the popup would just be
                            // an extra click for no real decision. Go
                            // straight to a Full download for those.
                            if (d.status !== 'modified') {
                              programDevice(d.id, d.individual_address, 'full');
                              return;
                            }
                            setDownloadModePopoverFor((v) =>
                              v === d.id ? null : d.id,
                            );
                          }}
                          disabled={prog?.state === 'running' || !d.has_address}
                          title={
                            !d.has_address
                              ? 'No individual address assigned yet — click the "-.-.-" badge to assign one'
                              : prog?.state === 'running'
                                ? liveProgramProgress?.msg
                                : undefined
                          }
                          // Colored/labeled off the PERSISTENT status
                          // (d.status, stored server-side), not the
                          // transient in-memory `prog` state, so it still
                          // reads correctly after a page reload/navigation,
                          // not just immediately after a click. Reuses
                          // STATUS_COLOR (the same map the summary badges
                          // use) rather than a green-only check - found
                          // live: 'modified' devices (a real, populated
                          // status as of the same day this button's color
                          // was added) fell through to the exact same
                          // plain, uncolored "Program" as a device that's
                          // never been touched (unassigned) at all, no
                          // visual distinction despite being materially
                          // different states.
                          color={
                            prog?.state !== 'error' && d.status !== 'unassigned'
                              ? STATUS_COLOR[d.status]
                              : undefined
                          }
                          bg={
                            prog?.state !== 'error' && d.status !== 'unassigned'
                              ? `color-mix(in srgb, ${STATUS_COLOR[d.status]} 12%, transparent)`
                              : undefined
                          }
                          // While running, the button's own background
                          // becomes the progress bar (a hard-stop
                          // linear-gradient, filled up to the live
                          // percentage) instead of popping a separate
                          // PROGRESS column open elsewhere in the row -
                          // explicit request, replacing that column
                          // entirely. `style` is spread last inside Btn, so
                          // this overrides its usual disabled-state gray.
                          // The `actionBtnRunning` flow animation (below,
                          // this module's own CSS - not the global `pulse`
                          // whole-button opacity fade, found too harsh on a
                          // filled button, real request 2026-08-31) and
                          // `wait` cursor make clear the download is still
                          // active during a real, long, percentage-static
                          // stretch late in a write (observed live: ~20s+
                          // sitting at 80% before jumping to 100%) rather than
                          // reading as stalled.
                          style={
                            prog?.state === 'running'
                              ? ({
                                  background: `linear-gradient(to right, color-mix(in srgb, var(--accent) 55%, transparent) 0%, color-mix(in srgb, var(--accent) 55%, transparent) ${Math.round(programPct)}%, var(--surface) ${Math.round(programPct)}%, var(--surface) 100%)`,
                                  color: 'var(--text)',
                                  cursor: 'wait',
                                  '--action-pct': `${Math.round(programPct)}%`,
                                } as CSSProperties)
                              : undefined
                          }
                        >
                          {prog?.state === 'running' ? (
                            `${Math.round(programPct)}%`
                          ) : prog?.state === 'error' ? (
                            'Retry'
                          ) : d.status === 'programmed' ? (
                            '✓ Re-program'
                          ) : d.status === 'modified' ? (
                            'Re-program'
                          ) : (
                            'Program'
                          )}
                        </Btn>
                        </div>
                      </div>
                    </TD>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      {logOpen ? (
        <>
          <div
            className={
              logOrientation === 'horizontal'
                ? styles.resizerHorizontal
                : styles.resizer
            }
            onMouseDown={onResizerMouseDown}
            title="Drag to resize"
          />
          <div
            className={`${styles.sidebar} ${logOrientation === 'horizontal' ? styles.sidebarHorizontal : ''} ${resizing ? styles.sidebarResizing : ''}`}
            style={
              logOrientation === 'horizontal'
                ? { height: sidebarHeight }
                : { width: sidebarWidth }
            }
          >
            <div
              className={`${styles.logHeader} ${logOrientation === 'horizontal' ? styles.logHeaderHorizontal : ''}`}
            >
              LOG
              <div className={styles.logHeaderActions}>
                <button
                  type="button"
                  className={`${styles.iconChipBtn} ${styles.clearCacheBtn}`}
                  onClick={() => clearLog()}
                  title="Clear log"
                >
                  🗑
                </button>
                <button
                  type="button"
                  className={styles.logCollapseBtn}
                  onClick={toggleLogOrientation}
                  title={
                    logOrientation === 'horizontal'
                      ? 'Switch to a vertical (right-docked) log panel'
                      : 'Switch to a horizontal (bottom-docked) log panel'
                  }
                >
                  {logOrientation === 'horizontal' ? '⬓' : '⬔'}
                </button>
                <button
                  type="button"
                  className={styles.logCollapseBtnLarge}
                  onClick={() => setLogOpen(false)}
                  title="Collapse log"
                >
                  {logOrientation === 'horizontal' ? '▼' : '▶'}
                </button>
              </div>
            </div>
            <div className={styles.logBody}>
              {log.length === 0 ? (
                <span className={styles.logEmpty}>No operations yet</span>
              ) : (
                log.map((l, i) => {
                  // Every entry is logged as "[HH:MM:SS] message" (see
                  // addLog() call sites throughout this file/
                  // AddressDeviceModal/AssignProjectAddressModal) - split
                  // that back apart at render time rather than changing
                  // every call site to pass a structured {time, text},
                  // added 2026-08-30: the timestamp gets its own line
                  // (dim/grey) with the message indented below it (normal
                  // text), instead of one long wrapped line mixing both,
                  // which read as cluttered once a message wrapped to a
                  // second line with no visual break from the timestamp.
                  const m = l.match(/^\[([^\]]+)\]\s*([\s\S]*)$/);
                  const time = m?.[1];
                  const text = m ? m[2] : l;
                  // Deliberately no success/failure color or symbol here -
                  // real request 2026-08-31: every entry's own wording
                  // already says what happened ("Downloaded", "Download
                  // failed", "Verified", etc.), so a separate color/tick
                  // was redundant, not an extra signal.
                  return (
                    <div key={i} className={styles.logEntry}>
                      {time && (
                        <div className={styles.logEntryTime}>{time}</div>
                      )}
                      <div className={styles.logEntryText}>{text}</div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </>
      ) : (
        <button
          type="button"
          className={
            logOrientation === 'horizontal'
              ? styles.logCollapsedStripHorizontal
              : styles.logCollapsedStrip
          }
          onClick={() => setLogOpen(true)}
          title="Open log"
        >
          <span
            className={
              logOrientation === 'horizontal'
                ? styles.logCollapsedLabelHorizontal
                : styles.logCollapsedLabel
            }
          >
            LOG
          </span>
          {log.length > 0 && (
            <span className={styles.logCollapsedCount}>{log.length}</span>
          )}
        </button>
      )}

      {/* Slide-over: opens automatically once a Verify read completes,
          showing the full device-vs-project comparison. Same
          DeviceCompareResults component the standalone "Device vs Project"
          page uses, reading the same shared verify cache - no separate
          fetch, no duplicated rendering logic.

          Both the slide-over and its scrim stop short of the log
          panel/collapsed strip (right: <its current width> instead of a
          flat 0) rather than covering it - both anchor from .root's right
          edge, so a flat right:0 would render the slide-over directly on
          top of the log, making it look like the log "disappeared" the
          moment a verify completes and the slide-over opens (it isn't
          cleared - see logOpen/log state above - just hidden behind a
          higher-stacked, opaque sibling).

          Only while OPEN, though: this div stays mounted (with
          transform:translateX(100%)) even when closed so the slide-in/out
          animation has something to animate, and that transform pushes it
          offscreen by 100% of ITS OWN box - which starts from `right`, not
          from the true viewport edge. Give it a non-zero `right` even
          while closed and the "offscreen" resting position shifts left by
          that same amount, leaving a sliver of the (empty) panel visible
          over the log instead of nothing - which is exactly what covering
          the log's own collapse/expand button looked like. Closed always
          reverts to right:0 so it goes fully offscreen as before.

          width is ALSO overridden inline while open, not left at its CSS
          default of min(900px, 96%) - that 96% is 96% of .root's FULL
          width, independent of `right`, so right (up to ~525px for a
          widened log panel) plus that width could exceed .root's actual
          width, pushing the panel's left edge negative and clipping away
          everything but a sliver near its own right edge (exactly what a
          too-wide log panel looked like: only a fragment of a summary
          chip visible, header/table clipped off). calc(96% - Rpx) instead
          of a flat 96% keeps right + width always <= 96% of .root's
          width, however wide the log panel's own reserved space gets. */}
      <div
        className={`${styles.slideOver} ${slideOverDevice ? styles.slideOverOpen : ''}`}
        style={
          slideOverDevice
            ? logOrientation === 'horizontal'
              ? // Horizontal mode reserves no width on the right at all
                // (the log panel is bottom-docked instead) - only needs to
                // stop short of it vertically.
                { right: 0, bottom: logPanelHeight }
              : {
                  right: logPanelWidth,
                  width: `min(900px, max(320px, calc(96% - ${logPanelWidth}px)))`,
                }
            : { right: 0 }
        }
      >
        {slideOverDevice && (
          <>
            <div className={styles.slideOverHeader}>
              <span className={styles.slideOverTitle}>
                <DeviceTypeIcon
                  type={slideOverDevice.device_type}
                  style={{
                    color:
                      COLMAP[slideOverDevice.device_type] || 'var(--muted)',
                  }}
                  title={
                    DEVICE_TYPE_LABEL[slideOverDevice.device_type] ||
                    'Generic device'
                  }
                />
                {slideOverDevice.has_address
                  ? slideOverDevice.individual_address
                  : '-.-.-'}{' '}
                — {slideOverDevice.name}
              </span>
              <button
                className={styles.slideOverClose}
                onClick={() => setSlideOverDevice(null)}
                title="Close"
              >
                ✕
              </button>
            </div>
            <div className={styles.slideOverBody}>
              <DeviceCompareResults
                device={slideOverDevice}
                showDeviceLabel={false}
              />
            </div>
          </>
        )}
      </div>
      {slideOverDevice && (
        <div
          className={styles.slideOverScrim}
          style={
            logOrientation === 'horizontal'
              ? { right: 0, bottom: logPanelHeight }
              : { right: logPanelWidth }
          }
          onClick={() => setSlideOverDevice(null)}
        />
      )}
      {addressModalFor !== null &&
        (() => {
          // Any row-scoped opening (the serial icon on a specific device)
          // locks the modal to that device, regardless of whether it has a
          // recorded serial or a real address yet - only the top-level
          // "Scan for New Device" button (addressModalFor === 'scan', no
          // row context) leaves it unlocked, since picking among several
          // detected devices is the actual point there. A known-serial
          // device (already commissioned once) additionally opens
          // straight on the serial tab, pre-filled - re-scanning/
          // re-picking a device we already have a record for is
          // unnecessary friction. A row with no recorded serial still
          // opens on the general 'detect' tab (its own default), since
          // that IS the discovery step.
          const rowDevice =
            typeof addressModalFor === 'number'
              ? devices.find((d: any) => d.id === addressModalFor)
              : undefined;
          const known = !!rowDevice?.serial_number;
          return (
            <AddressDeviceModal
              devices={devices}
              initialDeviceId={
                typeof addressModalFor === 'number'
                  ? addressModalFor
                  : undefined
              }
              initialTab={known ? 'serial' : undefined}
              initialSerial={known ? rowDevice!.serial_number : undefined}
              lockDevice={typeof addressModalFor === 'number'}
              onClose={() => setAddressModalFor(null)}
              addLog={(line) => {
                setLogOpen(true);
                addLog(line);
              }}
            />
          );
        })()}
      {downloadModePopoverFor !== null &&
        popoverPos &&
        createPortal(
          <DownloadModePopover
            panelRef={popoverRef}
            pos={popoverPos}
            width={DOWNLOAD_POPOVER_WIDTH}
            // Defensive only, in practice never true: a row's own Program
            // button (see its onClick above) now skips this popup
            // entirely and goes straight to a Full download unless
            // status==='modified', and the header's "Program All
            // Modified" only ever targets status==='modified' devices
            // (see programmAll) - so by the time this popup can be
            // showing at all, there's always something real for Partial
            // to diff against. Kept as a belt-and-braces check rather
            // than assuming that invariant can never drift.
            partialDisabled={
              downloadModePopoverFor !== 'all' &&
              devices.find((d: any) => d.id === downloadModePopoverFor)
                ?.status !== 'modified'
            }
            onChoose={chooseDownloadMode}
          />,
          document.body,
        )}
    </div>
  );
}

/**
 * Full vs Partial download choice, shown as a small popover anchored right
 * under whichever Program button was clicked - see downloadModePopoverFor's
 * own comment in ProgrammingView for why this is a per-click popover rather
 * than a page-level setting or a split-button menu, and its own comment for
 * why this renders through a portal (document.body) at `fixed` coordinates
 * rather than plain CSS positioning against its trigger button. Mode
 * meanings and the real evidence behind them: docs/knx-device-write-
 * protocol.md §4.2 (koolenex repo) - Full rewrites the object's whole
 * segment, Partial skips whatever the device already matches and writes
 * only the difference.
 */
function DownloadModePopover({
  panelRef,
  pos,
  width,
  partialDisabled,
  onChoose,
}: {
  panelRef: React.RefObject<HTMLDivElement | null>;
  pos: { top: number; left: number };
  width: number;
  partialDisabled: boolean;
  onChoose: (mode: 'full' | 'partial') => void;
}) {
  return (
    <div
      className={styles.downloadModePopover}
      ref={panelRef}
      style={{ top: pos.top, left: pos.left, width }}
    >
      <div className={styles.downloadModeHeader}>DOWNLOAD MODE</div>
      <button
        type="button"
        className={`${styles.downloadModeOption} ${styles.downloadModeOptionFull}`}
        onClick={() => onChoose('full')}
      >
        <span
          className={`${styles.downloadModeIcon} ${styles.downloadModeIconFull}`}
        >
          ⬇
        </span>
        <span className={styles.downloadModeText}>
          <span className={styles.downloadModeLabel}>Full Download</span>
          <span className={styles.downloadModeDesc}>
            Rewrites every segment. Always safe, slower.
          </span>
        </span>
      </button>
      <button
        type="button"
        className={`${styles.downloadModeOption} ${styles.downloadModeOptionPartial}`}
        onClick={() => onChoose('partial')}
        disabled={partialDisabled}
        title={
          partialDisabled
            ? 'Not available — no known modifications for this device, so there is nothing to skip'
            : undefined
        }
      >
        <span
          className={`${styles.downloadModeIcon} ${styles.downloadModeIconPartial}`}
        >
          ⚡
        </span>
        <span className={styles.downloadModeText}>
          <span className={styles.downloadModeLabel}>Partial Download</span>
          <span className={styles.downloadModeDesc}>
            Writes only what differs from the device. Faster.
          </span>
        </span>
      </button>
    </div>
  );
}
