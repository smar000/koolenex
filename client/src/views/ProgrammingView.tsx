import { useCallback, useRef, useState } from 'react';
import { STATUS_COLOR } from '../theme.ts';
import {
  Btn,
  Spinner,
  TH,
  TD,
  SectionHeader,
  PinAddr,
  Badge,
} from '../primitives.tsx';
import { DeviceTypeIcon } from '../icons.tsx';
import { api } from '../api.ts';
import {
  useAppData,
  useBusActions,
  useVerifyCache,
  useProgrammingLog,
} from '../contexts.ts';
import { DeviceCompareResults, displaySectionName } from './DeviceCompareResults.tsx';
import styles from './ProgrammingView.module.css';

export function ProgrammingView() {
  const { projectData: data } = useAppData();
  const { deviceStatus: onDeviceStatus } = useBusActions();
  const {
    cache: verifyCache,
    setResult: setVerifyResult,
    clearResult: clearVerifyResult,
    progress: verifyProgress,
    programProgress,
  } = useVerifyCache();
  const COLMAP: Record<string, string> = {
    actuator: 'var(--actuator)',
    sensor: 'var(--sensor)',
    router: 'var(--router)',
    generic: 'var(--muted)',
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
  // How much width the log panel/collapsed strip currently reserves on the
  // right, so the slide-over (and its scrim) can stop short of it instead
  // of covering it - see the comment at the slide-over below.
  const logPanelWidth = logOpen ? sidebarWidth + 5 : 28;

  const onResizerMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setResizing(true);
      document.body.style.userSelect = 'none';
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
    [sidebarWidth],
  );

  const programDevice = async (deviceId: any, devAddr: string) => {
    setLogOpen(true);
    programPctMaxRef.current[deviceId] = 0;
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
    addLog(`[${new Date().toLocaleTimeString()}] Downloading → ${devAddr}`);
    try {
      const pid = data?.project?.id;
      await api.busProgramDevice(devAddr, pid!, deviceId);
      setProgress((p) => ({ ...p, [deviceId]: { state: 'done' } }));
      addLog(
        `[${new Date().toLocaleTimeString()}] ✓ ${devAddr} — programmed`,
      );
      onDeviceStatus(deviceId, 'programmed');
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
        `[${new Date().toLocaleTimeString()}] ✗ ${devAddr} — ${err.message}`,
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
      const msg =
        `${r.match ? '✓' : '≠'} ${devAddr} — ${scopes.join('; ')}` +
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
        `[${new Date().toLocaleTimeString()}] ✗ ${devAddr} — verify failed: ${err.message}`,
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

  const programmAll = () =>
    devices
      .filter((d: any) => d.status !== 'programmed')
      .forEach((d: any) => programDevice(d.id, d.individual_address));

  return (
    <div className={styles.root}>
      <div className={styles.main}>
        <SectionHeader
          title="Programming"
          actions={[
            <Btn key="all" onClick={programmAll} color="var(--amber)">
              ▷ Program All Modified
            </Btn>,
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
                <TH className={styles.thProgress}>PROGRESS</TH>
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
                        />
                        <PinAddr
                          address={d.individual_address}
                          wtype="device"
                          className={styles.addrBadge}
                        />
                        {d.name}
                        {d.manufacturer && (
                          <span className={styles.mfrLabel}>
                            {d.manufacturer}
                          </span>
                        )}
                      </span>
                    </TD>
                    <TD>
                      {prog?.state === 'done' ? (
                        <Badge label="PROGRAMMED" color="var(--green)" />
                      ) : (
                        <Badge
                          label={d.status.toUpperCase()}
                          color={STATUS_COLOR[d.status] || 'var(--dim)'}
                        />
                      )}
                    </TD>
                    <TD>
                      {prog ? (
                        <div
                          className={styles.progressWrap}
                          title={liveProgramProgress?.msg}
                        >
                          <div className={styles.progressTrack}>
                            <div
                              className={styles.progressBar}
                              style={{
                                width: `${programPct}%`,
                                background:
                                  prog.state === 'done'
                                    ? 'var(--green)'
                                    : prog.state === 'error'
                                      ? 'var(--red)'
                                      : 'var(--accent)',
                              }}
                            />
                          </div>
                          {prog.state !== 'error' && (
                            <span className={styles.progressPct}>
                              {Math.round(programPct)}%
                            </span>
                          )}
                          {prog.state === 'error' && (
                            <span className={styles.progressErr}>ERR</span>
                          )}
                        </div>
                      ) : (
                        <span className={styles.progressDash}>—</span>
                      )}
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
                            className={styles.actionBtn}
                            onClick={() =>
                              verifyDevice(d.id, d.individual_address)
                            }
                            disabled={prog?.state === 'running' || verifying}
                            title={
                              verifyCache[d.id]
                                ? 'Read the device again and compare to the computed image — no writes'
                                : 'Read the device and compare to the computed image — no writes'
                            }
                          >
                            {verifying ? (
                              <Spinner />
                            ) : verifyCache[d.id] ? (
                              'Re-verify'
                            ) : (
                              'Verify'
                            )}
                          </Btn>
                          {verifying && (
                            <div className={styles.verifyPopover}>
                              {liveVerifyProgress ? (
                                <>
                                  <div className={styles.progressTrack}>
                                    <div
                                      className={styles.progressBar}
                                      style={{
                                        width: `${liveVerifyProgress.pct}%`,
                                        background: 'var(--accent)',
                                      }}
                                    />
                                  </div>
                                  <span className={styles.verifyPopoverText}>
                                    {liveVerifyProgress.bytesRead}/
                                    {liveVerifyProgress.totalBytes} bytes (
                                    {liveVerifyProgress.pct}%)
                                  </span>
                                </>
                              ) : (
                                <span className={styles.verifyPopoverText}>
                                  Reading device…
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                        <Btn
                          className={styles.actionBtn}
                          onClick={() =>
                            programDevice(d.id, d.individual_address)
                          }
                          disabled={prog?.state === 'running'}
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
                        >
                          {prog?.state === 'running' ? (
                            <Spinner />
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
            className={styles.resizer}
            onMouseDown={onResizerMouseDown}
            title="Drag to resize"
          />
          <div
            className={`${styles.sidebar} ${resizing ? styles.sidebarResizing : ''}`}
            style={{ width: sidebarWidth }}
          >
            <div className={styles.logHeader}>
              LOG
              <button
                type="button"
                className={styles.logCollapseBtn}
                onClick={() => setLogOpen(false)}
                title="Collapse log"
              >
                ▸
              </button>
            </div>
            <div className={styles.logBody}>
              {log.length === 0 ? (
                <span className={styles.logEmpty}>No operations yet</span>
              ) : (
                log.map((l, i) => (
                  <div
                    key={i}
                    className={
                      l.includes('✓')
                        ? styles.logEntrySuccess
                        : styles.logEntryNormal
                    }
                  >
                    {l}
                  </div>
                ))
              )}
            </div>
            <div className={styles.logFooter}>
              <Btn
                onClick={() => clearLog()}
                color="var(--dim)"
                bg="var(--bg)"
                className={styles.logFooterBtn}
              >
                Clear Log
              </Btn>
            </div>
          </div>
        </>
      ) : (
        <button
          type="button"
          className={styles.logCollapsedStrip}
          onClick={() => setLogOpen(true)}
          title="Open log"
        >
          <span className={styles.logCollapsedLabel}>LOG</span>
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
            ? {
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
                />
                {slideOverDevice.individual_address} — {slideOverDevice.name}
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
          style={{ right: logPanelWidth }}
          onClick={() => setSlideOverDevice(null)}
        />
      )}
    </div>
  );
}
