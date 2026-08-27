import { useState } from 'react';
import { Btn, Spinner } from '../primitives.tsx';
import { api } from '../api.ts';
import { useAppData, useLiveData, useVerifyCache } from '../contexts.ts';
import { DeviceCompareResults, timeAgo } from './DeviceCompareResults.tsx';
import styles from './DeviceComparisonView.module.css';

/**
 * Standalone "Device vs Project" page: pick any device, read it over the
 * bus, and see every value it's able to decode side-by-side with what the
 * loaded project expects. The actual results display is
 * DeviceCompareResults - the same component Programming's Verify
 * slide-over uses, so both stay in sync automatically.
 *
 * Verify results are cached per device (shared with the Programming view's
 * own Verify button via VerifyCacheCtx) — selecting a device shows its last
 * known result instantly; "Read Device & Compare" always forces a fresh
 * bus read and updates the shared cache.
 */
export function DeviceComparisonView() {
  const { projectData: data } = useAppData();
  const { busStatus } = useLiveData();
  const { cache, setResult } = useVerifyCache();
  const { devices = [] } = data || {};

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected =
    devices.find((d: any) => d.id === selectedId) || devices[0] || null;
  const cacheEntry = selected ? cache[selected.id] : undefined;

  const runCompare = async () => {
    if (!selected) return;
    setLoading(true);
    setError(null);
    try {
      const pid = data?.project?.id;
      const r = await api.busVerifyDevice(
        selected.individual_address,
        pid!,
        selected.id,
      );
      setResult(selected.id, r);
    } catch (err: any) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <div className={styles.toolbarRow}>
          <div className={styles.toolbarTitle}>Device vs Project</div>
          <select
            value={selected?.id ?? ''}
            onChange={(e) => setSelectedId(Number(e.target.value))}
            className={styles.select}
          >
            {devices.map((d: any) => (
              <option key={d.id} value={d.id}>
                {d.individual_address} — {d.name}
              </option>
            ))}
          </select>
          <Btn
            onClick={runCompare}
            disabled={loading || !selected || busStatus?.connected === false}
            color="var(--accent)"
            title="Read the device over the bus and decode every value it has — no writes"
          >
            {loading ? (
              <Spinner />
            ) : cacheEntry ? (
              'Re-read Device'
            ) : (
              'Read Device & Compare'
            )}
          </Btn>
          {cacheEntry && !loading && (
            <span
              className={styles.cacheNote}
              title={new Date(cacheEntry.fetchedAt).toLocaleString()}
            >
              cached · read {timeAgo(cacheEntry.fetchedAt)}
            </span>
          )}
        </div>
      </div>
      {error && <div className={styles.errorBanner}>✗ {error}</div>}
      <DeviceCompareResults device={selected} />
    </div>
  );
}
