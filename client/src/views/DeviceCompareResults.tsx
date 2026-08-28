import { useState, useMemo, useRef, useEffect } from 'react';
import { Btn, Badge, SearchBox, Empty } from '../primitives.tsx';
import { DeviceTypeIcon } from '../icons.tsx';
import type { VerifyDecodedParam } from '../api.ts';
import { useLiveData, useVerifyCache } from '../contexts.ts';
import styles from './DeviceComparisonView.module.css';

/** Deterministic hue (0-359) from a section name, for the per-section tint. */
function hueForSection(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}

function sectionId(name: string): string {
  return 'sec-' + name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
}

/** Compact match/differ glyph for the per-row MATCH column - a text Badge
 * ("MATCH"/"DIFFERS") has a fixed minimum width from its own padding, which
 * overflowed its cell once the MATCH column's percentage width shrank below
 * that on a narrow panel. A small fixed-size icon has no such floor. */
function MatchIcon({ match }: { match: boolean | null }) {
  if (match === true)
    return (
      <span className={styles.matchIcon} style={{ color: 'var(--green)' }} title="Match">
        ✓
      </span>
    );
  if (match === false)
    return (
      <span className={styles.matchIcon} style={{ color: 'var(--red)' }} title="Differs">
        ✕
      </span>
    );
  return (
    <span className={styles.matchIcon} style={{ color: 'var(--dim)' }} title="Not applicable">
      –
    </span>
  );
}

export function timeAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

interface DeviceLike {
  id: number;
  individual_address: string;
  name: string;
  device_type: string;
}

/**
 * Displays a device's cached verify-device result (decoded parameters or
 * raw properties) side-by-side with what the project expects, plus the
 * live in-progress read state if one is running. Pure display + filtering -
 * does NOT trigger a bus read itself; the host (the standalone Device vs
 * Project page, or Programming's slide-over) is responsible for that via
 * the shared VerifyCacheCtx, so this component works identically embedded
 * either way.
 */
export function DeviceCompareResults({
  device,
  showDeviceLabel = true,
}: {
  device: DeviceLike | null;
  /** Hide the device name/icon row when the host already shows it
   * elsewhere (e.g. the slide-over's own header). */
  showDeviceLabel?: boolean;
}) {
  const { busStatus } = useLiveData();
  const { cache, progress } = useVerifyCache();

  const [search, setSearch] = useState('');
  // Row filter driven by the summary chips above the table ("N match" / "N
  // differ") instead of a separate checkbox - clicking a chip filters to
  // that outcome, clicking it again (or the same state) returns to 'all'.
  const [rowFilter, setRowFilter] = useState<'all' | 'differ' | 'match'>(
    'all',
  );
  const [onlyNamed, setOnlyNamed] = useState(true);
  const [showGroupCol, setShowGroupCol] = useState(false);
  const [sectionsOpen, setSectionsOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const sectionsPopoverRef = useRef<HTMLDivElement | null>(null);

  const cacheEntry = device ? cache[device.id] : undefined;
  const result = cacheEntry?.result ?? null;
  const liveProgress = device ? progress[device.individual_address] : undefined;
  const loading = !!liveProgress && !cacheEntry;

  const decoded = result?.decoded ?? null;

  // Smart default: when a fresh result comes in (new device selected, or a
  // re-verify completes) with any differing parameter, default to showing
  // ALL differences including unnamed ones - that's almost certainly what
  // you want to see first. With no differences, default back to the
  // original "only named" view instead of an empty differing-only table.
  // Only applies once per distinct result (tracked by device+fetchedAt) so
  // it never fights a filter toggle you made by hand.
  const appliedDefaultKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!decoded || !device) return;
    const key = `${device.id}:${cacheEntry?.fetchedAt ?? ''}`;
    if (appliedDefaultKeyRef.current === key) return;
    appliedDefaultKeyRef.current = key;
    const hasMismatch = decoded.some((d) => d.match === false);
    setRowFilter(hasMismatch ? 'differ' : 'all');
    setOnlyNamed(!hasMismatch);
  }, [decoded, device, cacheEntry]);
  const q = search.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      (decoded ?? []).filter((d) => {
        if (rowFilter === 'differ' && d.match !== false) return false;
        if (rowFilter === 'match' && d.match !== true) return false;
        if (onlyNamed && d.label === d.key) return false;
        if (!q) return true;
        return (
          d.label.toLowerCase().includes(q) ||
          d.section.toLowerCase().includes(q) ||
          d.group.toLowerCase().includes(q)
        );
      }),
    [decoded, rowFilter, onlyNamed, q],
  );

  const bySection = useMemo(() => {
    const m = new Map<string, VerifyDecodedParam[]>();
    for (const row of filtered) {
      const key = row.section || '(Ungrouped)';
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(row);
    }
    return m;
  }, [filtered]);

  const sections = Array.from(bySection.keys()).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }),
  );

  const matchCount = decoded
    ? decoded.filter((d) => d.match === true).length
    : 0;
  const mismatchCount = decoded
    ? decoded.filter((d) => d.match === false).length
    : 0;
  // How many of those mismatches the current filters (search / only-named)
  // are hiding from the table below - the summary badges below count every
  // decoded parameter, not just the filtered/visible ones, so this makes
  // that gap visible instead of leaving "4 differ" looking wrong next to a
  // 3-row table.
  const shownMismatchCount = filtered.filter((d) => d.match === false).length;
  const hiddenMismatchCount = mismatchCount - shownMismatchCount;

  const jumpTo = (name: string) => {
    const el = bodyRef.current?.querySelector(
      `#${CSS.escape(sectionId(name))}`,
    );
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setSectionsOpen(false);
  };

  // Close the sections popover on outside click.
  useEffect(() => {
    if (!sectionsOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!sectionsPopoverRef.current?.contains(e.target as Node)) {
        setSectionsOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [sectionsOpen]);

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        {result && (
          <div className={styles.toolbarRow}>
            {showDeviceLabel && device && (
              <span className={styles.devLabel}>
                <DeviceTypeIcon type={device.device_type} />
                {device.individual_address} — {device.name}
              </span>
            )}
            {cacheEntry && (
              <span
                className={styles.cacheNote}
                title={new Date(cacheEntry.fetchedAt).toLocaleString()}
              >
                cached · read {timeAgo(cacheEntry.fetchedAt)}
              </span>
            )}

            {decoded && decoded.length > 0 && sections.length > 1 && (
              <div className={styles.sectionsNav} ref={sectionsPopoverRef}>
                <Btn
                  onClick={() => setSectionsOpen((o) => !o)}
                  color="var(--muted)"
                  bg="var(--surface)"
                >
                  Sections ({sections.length}) {sectionsOpen ? '▴' : '▾'}
                </Btn>
                {sectionsOpen && (
                  <div className={styles.sectionsPopover}>
                    {sections.map((s) => {
                      const hue = hueForSection(s);
                      return (
                        <button
                          key={s}
                          onClick={() => jumpTo(s)}
                          className={styles.jumpChip}
                          style={{ '--chip-hue': hue } as React.CSSProperties}
                        >
                          {s}
                          <span className={styles.jumpChipCount}>
                            {bySection.get(s)!.length}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            <div className={styles.summaryBadges}>
              {/* Two different scopes shown side by side, which reads as
                  contradictory without knowing the difference (e.g. "5201
                  match / 2 differ" as parameters next to "8448/10433 bytes
                  match" as raw memory) - a visible "(raw memory)" /
                  "(named parameters)" label on each cluster, plus a fuller
                  tooltip, so that's clear without already knowing it.

                  Named parameters first, raw memory second (was the other
                  way round): named parameters are the scope actually under
                  project control, where a mismatch means something real -
                  raw memory legitimately includes padding/gap bytes ETS
                  itself never writes to (see the 2026-08-27 relmem
                  write-scope investigation), so its mismatch count is
                  structurally noisy and shouldn't be the first, most
                  prominent thing shown. The raw-memory chip's color is
                  muted to --dim for the same reason - amber/green there
                  reads as "this matters" when usually it doesn't. */}
              {decoded && (
                <div className={styles.summaryGroup}>
                  <button
                    type="button"
                    className={`${styles.filterChipBtn} ${rowFilter === 'match' ? styles.filterChipBtnActive : ''}`}
                    style={{ '--chip-ring': 'var(--green)' } as React.CSSProperties}
                    onClick={() =>
                      setRowFilter(rowFilter === 'match' ? 'all' : 'match')
                    }
                    title={
                      (rowFilter === 'match'
                        ? 'Showing only matching parameters — click to show all. '
                        : 'Show only matching parameters. ') +
                      'Named, project-configurable parameters only - a smaller, more ' +
                      'precise scope than the raw byte count to the right, which also ' +
                      'includes unmapped/padding bytes.'
                    }
                  >
                    <Badge
                      label={
                        mismatchCount === 0
                          ? `All ${matchCount} matched`
                          : `${matchCount} match`
                      }
                      color="var(--green)"
                    />
                  </button>
                  {mismatchCount > 0 && (
                    <button
                      type="button"
                      className={`${styles.filterChipBtn} ${rowFilter === 'differ' ? styles.filterChipBtnActive : ''}`}
                      style={{ '--chip-ring': 'var(--red)' } as React.CSSProperties}
                      onClick={() => {
                        const next = rowFilter === 'differ' ? 'all' : 'differ';
                        setRowFilter(next);
                        if (next === 'differ' && hiddenMismatchCount > 0)
                          setOnlyNamed(false);
                      }}
                      title={
                        rowFilter === 'differ'
                          ? 'Showing only differing parameters — click to show all'
                          : hiddenMismatchCount > 0
                            ? `Show only differing parameters (including ${hiddenMismatchCount} unnamed one${hiddenMismatchCount === 1 ? '' : 's'} normally hidden by "Only named parameters")`
                            : 'Show only differing parameters'
                      }
                    >
                      <Badge
                        label={
                          hiddenMismatchCount > 0
                            ? `${mismatchCount} differ (${hiddenMismatchCount} hidden)`
                            : `${mismatchCount} differ`
                        }
                        color="var(--red)"
                      />
                    </button>
                  )}
                  <span
                    className={styles.summaryGroupLabel}
                    title={
                      'Only bytes ETS maps to a named, project-configurable parameter - excludes ' +
                      'padding/reserved bytes, so this is usually a much smaller, more precise ' +
                      'count than the raw memory total to the right.'
                    }
                  >
                    named parameters
                  </span>
                </div>
              )}
              <div className={styles.summaryGroup}>
                {decoded ? (
                  <button
                    type="button"
                    className={`${styles.filterChipBtn} ${rowFilter === 'all' ? styles.filterChipBtnActive : ''}`}
                    style={{ '--chip-ring': 'var(--dim)' } as React.CSSProperties}
                    onClick={() => setRowFilter('all')}
                    title={
                      (rowFilter === 'all'
                        ? 'Showing all parameters (matching and differing). '
                        : 'Show all parameters — clears the match/differ filter. ') +
                      'This count is the raw byte-level comparison across the full ' +
                      `${result.totalBytes}-byte parameter memory segment, including ` +
                      'padding/reserved bytes not tied to any named parameter - a ' +
                      'different (larger) scope than the match/differ counts to the ' +
                      'left. Muted deliberately: ETS itself never writes to most of ' +
                      "this padding region, so a mismatch here usually isn't " +
                      'meaningful the way a named-parameter mismatch is.'
                    }
                  >
                    <Badge
                      label={`${result.totalBytes - result.totalDiffering}/${result.totalBytes} bytes match`}
                      color="var(--dim)"
                    />
                  </button>
                ) : (
                  <Badge
                    label={`${result.totalBytes - result.totalDiffering}/${result.totalBytes} bytes match`}
                    color="var(--dim)"
                  />
                )}
                <span
                  className={styles.summaryGroupLabel}
                  title={
                    'Every byte of the raw parameter memory segment, including padding/reserved ' +
                    'bytes with no named parameter behind them - usually a much larger, coarser ' +
                    'number than the parameter-level counts to the left.'
                  }
                >
                  raw memory
                </span>
              </div>
            </div>
          </div>
        )}

        {result && decoded && decoded.length > 0 && (
          <div className={styles.toolbarRow}>
            <div className={styles.filterBar}>
              <SearchBox
                value={search}
                onChange={setSearch}
                placeholder="Filter parameters…"
              />
              <label className={styles.checkToggle}>
                <input
                  type="checkbox"
                  checked={onlyNamed}
                  onChange={(e) => setOnlyNamed(e.target.checked)}
                />
                Only named parameters
              </label>
              <label
                className={styles.checkToggle}
                title={
                  'Raw per-instance label from the product database (e.g. "Dimming channel 2 ({{0:...}})"). ' +
                  'The {{0:...}} is a template placeholder real ETS substitutes at render time - koolenex ' +
                  "doesn't resolve it yet, so it's shown exactly as parsed."
                }
              >
                <input
                  type="checkbox"
                  checked={showGroupCol}
                  onChange={(e) => setShowGroupCol(e.target.checked)}
                />
                Show group column ⓘ
              </label>
            </div>
          </div>
        )}
      </div>

      <div className={styles.body} ref={bodyRef}>
        {busStatus?.connected === false && (
          <div className={styles.warnBanner}>
            Bus not connected — connect to a router/interface first.
          </div>
        )}

        {!result && !loading && (
          <Empty
            icon="⇄"
            msg="No verify result for this device yet — run Verify to read it over the bus."
          />
        )}

        {loading && liveProgress && (
          <div className={styles.loadingBanner}>
            <div className={styles.progressRow}>
              <div className={styles.progressTrack}>
                <div
                  className={styles.progressFill}
                  style={{ width: `${liveProgress.pct}%` }}
                />
              </div>
              <span className={styles.progressPct}>{liveProgress.pct}%</span>
            </div>
            <span className={styles.loadingText}>
              Reading device memory over the bus — {liveProgress.bytesRead}/
              {liveProgress.totalBytes} bytes
            </span>
          </div>
        )}

        {result && decoded && decoded.length > 0 && (
          <>
            {filtered.length === 0 ? (
              <Empty msg="No parameters match the current filter." />
            ) : (
              Array.from(bySection.entries()).map(([section, rows]) => {
                const hue = hueForSection(section);
                return (
                  <div
                    key={section}
                    id={sectionId(section)}
                    className={styles.sectionBlock}
                    style={{ '--section-hue': hue } as React.CSSProperties}
                  >
                    <div className={styles.sectionTitle}>
                      {section}
                      <span className={styles.sectionCount}>{rows.length}</span>
                    </div>
                    <table className={styles.table}>
                      <colgroup>
                        <col style={{ width: showGroupCol ? '42%' : '52%' }} />
                        {showGroupCol && <col style={{ width: '22%' }} />}
                        <col style={{ width: showGroupCol ? '16%' : '19%' }} />
                        <col style={{ width: showGroupCol ? '16%' : '19%' }} />
                        <col style={{ width: '4%' }} />
                      </colgroup>
                      <thead>
                        <tr>
                          <th className={styles.th}>Parameter</th>
                          {showGroupCol && (
                            <th className={styles.th}>Group (raw)</th>
                          )}
                          <th className={styles.th}>Project</th>
                          <th className={styles.th}>Device</th>
                          <th className={styles.th} title="Match">
                            ✓
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr
                            key={r.key}
                            className={
                              r.match === false ? styles.rowDiffer : styles.row
                            }
                          >
                            <td className={styles.td}>
                              <span className={styles.tip} data-tip={r.key}>
                                <span className={styles.tipText}>
                                  {r.label}
                                </span>
                              </span>
                            </td>
                            {showGroupCol && (
                              <td
                                className={`${styles.td} ${styles.groupCell}`}
                              >
                                <span
                                  className={styles.tip}
                                  data-tip={r.group || undefined}
                                >
                                  <span className={styles.tipText}>
                                    {r.group || '—'}
                                  </span>
                                </span>
                              </td>
                            )}
                            <td className={`${styles.td} ${styles.mono}`}>
                              <span
                                className={styles.tip}
                                data-tip={r.expectedValue}
                              >
                                <span className={styles.tipText}>
                                  {r.expectedValue}
                                </span>
                              </span>
                            </td>
                            <td className={`${styles.td} ${styles.mono}`}>
                              <span
                                className={styles.tip}
                                data-tip={r.actualValue ?? undefined}
                              >
                                <span className={styles.tipText}>
                                  {r.actualValue ?? '—'}
                                </span>
                              </span>
                            </td>
                            <td className={styles.td}>
                              <MatchIcon match={r.match} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })
            )}
          </>
        )}

        {result && !decoded && result.props && result.props.length > 0 && (
          <div
            className={styles.sectionBlock}
            style={{ '--section-hue': 210 } as React.CSSProperties}
          >
            <div className={styles.sectionTitle}>
              Properties ({result.family} — no decodable parameter memory for
              this device family)
            </div>
            <table className={styles.table}>
              <colgroup>
                <col style={{ width: '52%' }} />
                <col style={{ width: '19%' }} />
                <col style={{ width: '19%' }} />
                <col style={{ width: '4%' }} />
              </colgroup>
              <thead>
                <tr>
                  <th className={styles.th}>Property</th>
                  <th className={styles.th}>Project (hex)</th>
                  <th className={styles.th}>Device (hex)</th>
                  <th className={styles.th}>Match</th>
                </tr>
              </thead>
              <tbody>
                {result.props.map((p, i) => (
                  <tr
                    key={i}
                    className={!p.match ? styles.rowDiffer : styles.row}
                  >
                    <td className={styles.td}>
                      obj={p.obj} pid={p.pid}
                    </td>
                    <td className={`${styles.td} ${styles.mono}`}>
                      <span className={styles.tip} data-tip={p.expectedHex}>
                        <span className={styles.tipText}>{p.expectedHex}</span>
                      </span>
                    </td>
                    <td className={`${styles.td} ${styles.mono}`}>
                      <span className={styles.tip} data-tip={p.actualHex}>
                        <span className={styles.tipText}>{p.actualHex}</span>
                      </span>
                    </td>
                    <td className={styles.td}>
                      <MatchIcon match={p.match} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {result && !decoded && (!result.props || result.props.length === 0) && (
          <Empty msg="No decodable parameters or properties were returned for this device." />
        )}
      </div>
    </div>
  );
}
