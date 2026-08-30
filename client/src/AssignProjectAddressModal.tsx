import { useMemo, useState } from 'react';
import { Btn, Spinner } from './primitives.tsx';
import { useProjectActions } from './contexts.ts';
import type { Device } from '../../shared/types.ts';
import styles from './AddressDeviceModal.module.css';

// Real KNX area/line numbers are 4-bit (0-15) - see ets-parser.ts's
// synthetic-address handling, added 2026-08-30. A device imported from
// <UnassignedDevices> (never placed on any real Line at all) gets area/
// line 99 specifically so it can never collide with a genuine topology
// entry; treat that sentinel as "no real area/line context" rather than
// pre-filling a nonsense 99.99 suggestion.
const REAL_MAX = 15;

/**
 * First step for a device imported with no individual address at all
 * (has_address=0). A real, unique project address (X.Y.Z) has to be
 * assigned here before the device is eligible for physical commissioning
 * (AddressDeviceModal) - writing our synthetic placeholder onto a
 * physical unit would be as hazardous as letting Program/Verify touch it
 * (see the has_address guards in server/routes/bus.ts), so this modal is
 * a required first step, not an alternative path.
 */
export function AssignProjectAddressModal({
  device,
  devices,
  onClose,
  addLog,
}: {
  device: Device;
  devices: Device[];
  onClose: () => void;
  addLog: (line: string) => void;
}) {
  const { updateDevice } = useProjectActions();

  const defaultArea = device.area <= REAL_MAX ? device.area : 1;
  const defaultLine = device.line <= REAL_MAX ? device.line : 1;

  const usedNumbers = (a: number, l: number): Set<number> =>
    new Set(
      devices
        .filter((d) => d.has_address && d.area === a && d.line === l)
        .map((d) => {
          const parts = d.individual_address.split('.');
          return Number(parts[2]);
        })
        .filter((n) => Number.isFinite(n)),
    );

  const suggest = (a: number, l: number): number => {
    const used = usedNumbers(a, l);
    for (let n = 1; n <= 255; n++) if (!used.has(n)) return n;
    return 1;
  };

  const [area, setArea] = useState(defaultArea);
  const [line, setLine] = useState(defaultLine);
  const [devNum, setDevNum] = useState(() => suggest(defaultArea, defaultLine));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const address = `${area}.${line}.${devNum}`;
  const conflict = useMemo(
    () =>
      devices.find(
        (d) => d.id !== device.id && d.has_address && d.individual_address === address,
      ),
    [devices, device.id, address],
  );

  const resuggest = (a: number, l: number) => {
    setArea(a);
    setLine(l);
    setDevNum(suggest(a, l));
  };

  const save = async () => {
    if (conflict) return;
    setBusy(true);
    setError(null);
    try {
      await updateDevice(device.id, { individual_address: address });
      addLog(
        `[${new Date().toLocaleTimeString()}] Assigned project address ${address} to ${device.name}`,
      );
      onClose();
    } catch (e: any) {
      setError(e.message || 'Failed to assign address');
    }
    setBusy(false);
  };

  return (
    <div className={styles.scrim} onClick={onClose}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <span className={styles.title}>Assign Project Address</span>
          <button className={styles.closeBtn} onClick={onClose} title="Close">
            ✕
          </button>
        </div>
        <div className={styles.body}>
          <div className={styles.intro}>
            {device.name} was imported with no individual address. Pick one
            before it can be physically commissioned — the next free address
            in its area/line is suggested below.
          </div>

          <div className={styles.row}>
            <div className={styles.col}>
              <div className={styles.fieldLabel}>AREA</div>
              <input
                type="number"
                min={0}
                max={15}
                className={styles.textInput}
                value={area}
                onChange={(e) => resuggest(Number(e.target.value) || 0, line)}
              />
            </div>
            <div className={styles.col}>
              <div className={styles.fieldLabel}>LINE</div>
              <input
                type="number"
                min={0}
                max={15}
                className={styles.textInput}
                value={line}
                onChange={(e) => resuggest(area, Number(e.target.value) || 0)}
              />
            </div>
            <div className={styles.col}>
              <div className={styles.fieldLabel}>DEVICE</div>
              <input
                type="number"
                min={0}
                max={255}
                className={styles.textInput}
                value={devNum}
                onChange={(e) => setDevNum(Number(e.target.value) || 0)}
              />
            </div>
          </div>

          <div className={styles.row}>
            <Btn onClick={() => resuggest(area, line)} disabled={busy}>
              ⟲ Suggest next free
            </Btn>
          </div>

          {conflict && (
            <div className={styles.errorMsg}>
              &#x2717; {address} is already used by {conflict.name}
            </div>
          )}
          {error && <div className={styles.errorMsg}>&#x2717; {error}</div>}

          <Btn onClick={save} disabled={busy || !!conflict}>
            {busy ? (
              <>
                <Spinner /> Assigning…
              </>
            ) : (
              `Assign ${address}`
            )}
          </Btn>
        </div>
      </div>
    </div>
  );
}
