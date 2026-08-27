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
import { DeviceCompareResults } from './DeviceCompareResults.tsx';
import styles from './ProgrammingView.module.css';

export function ProgrammingView() {
  const { projectData: data } = useAppData();
  const { deviceStatus: onDeviceStatus } = useBusActions();
  const {
    cache: verifyCache,
    setResult: setVerifyResult,
    progress: verifyProgress,
  } = useVerifyCache();
  const COLMAP: Record<string, string> = {
    actuator: 'var(--actuator)',
    sensor: 'var(--sensor)',
    router: 'var(--router)',
    generic: 'var(--muted)',
  };
  const [progress, setProgress] = useState<
    Record<string, { state: string; pct: number }>
  >({});
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
    setProgress((p) => ({ ...p, [deviceId]: { state: 'running', pct: 5 } }));
    addLog(`[${new Date().toLocaleTimeString()}] Downloading → ${devAddr}`);
    let pct = 5;
    const iv = setInterval(() => {
      pct = Math.min(pct + (Math.random() * 6 + 2), 90);
      setProgress((p) => ({ ...p, [deviceId]: { state: 'running', pct } }));
    }, 300);
    try {
      const pid = data?.project?.id;
      await api.busProgramDevice(devAddr, pid!, deviceId);
      clearInterval(iv);
      setProgress((p) => ({ ...p, [deviceId]: { state: 'done', pct: 100 } }));
      addLog(
        `[${new Date().toLocaleTimeString()}] ✓ ${devAddr} — programmed`,
      );
      onDeviceStatus(deviceId, 'programmed');
    } catch (err: any) {
      clearInterval(iv);
      setProgress((p) => ({ ...p, [deviceId]: { state: 'error', pct: 0 } }));
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
      const msg = r.match
        ? `✓ ${devAddr} — matches computed image (${r.totalBytes} bytes)`
        : `≠ ${devAddr} — ${r.totalDiffering}/${r.totalBytes} bytes differ from computed image`;
      addLog(`[${new Date().toLocaleTimeString()}] ${msg}`);
      // Slide over to show the full comparison as soon as the read completes.
      const dev = devices.find((d: any) => d.id === deviceId) ?? null;
      setSlideOverDevice(dev);
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
          <div className={styles.statGrid}>
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
              <div key={label as string} className={styles.statCard}>
                <div
                  className={styles.statNumber}
                  style={{ color: col as string }}
                >
                  {count}
                </div>
                <div className={styles.statLabel}>{label}</div>
              </div>
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
                        <div className={styles.progressWrap}>
                          <div className={styles.progressTrack}>
                            <div
                              className={styles.progressBar}
                              style={{
                                width: `${prog.pct}%`,
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
                              {Math.round(prog.pct)}%
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
                            cached result. */}
                        <div className={styles.viewSlot}>
                          {verifyCache[d.id] && (
                            <button
                              type="button"
                              className={styles.viewChipBtn}
                              onClick={() => openComparison(d.id)}
                              disabled={verifying}
                              title="View the last comparison result — no bus read"
                            >
                              View
                            </button>
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
                        >
                          {prog?.state === 'running' ? (
                            <Spinner />
                          ) : prog?.state === 'done' ? (
                            'Re-program'
                          ) : prog?.state === 'error' ? (
                            'Retry'
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
