import { useState } from 'react';
import { Btn, Spinner } from './primitives.tsx';
import { api } from './api.ts';
import { useProjectActions } from './contexts.ts';
import type { Device } from '../../shared/types.ts';
import styles from './AddressDeviceModal.module.css';

/**
 * Guided flow for writing a real KNX individual address onto a physical
 * device - either a device currently in programming mode (pressed once to
 * enter it, not held down) or one identified purely by its serial number.
 * Opened inline on
 * the Programming page (see ProgrammingView.tsx's "Address New Device"
 * button), not a separate view - the operator needs to see this alongside
 * the same device list/log they're already working from.
 *
 * Two real, independently-tested write mechanisms are available, and this
 * UI is deliberately upfront about which is which (see docs/knx-device-
 * write-protocol.md §9, koolenex repo):
 *  - programIA() (`api.busProgramIA`) - broadcasts the new address to
 *    whichever device is CURRENTLY holding its programming button. Real-
 *    hardware confirmed. Only safe when exactly one device answers a
 *    programming-mode scan - broadcasting to "whoever's listening" is
 *    inherently ambiguous with more than one.
 *  - assignIndividualAddressBySerial() (`api.busAssignAddressBySerial`) -
 *    targets one specific device by its serial number, no button-press
 *    needed, safe even with several devices in programming mode at once.
 *    Sourced from the Falcon SDK's own docs + Calimero's implementation,
 *    but (unlike every other write path this app exposes) has no real-
 *    hardware confirmation yet - flagged in the UI as experimental, not
 *    presented as equally proven.
 *
 * Matching a detected serial to a specific project device: an exact match
 * against the project's own recorded `serial_number` (imported from the
 * .knxproj, or set here by a previous real addressing run) is offered as
 * the default pick; the operator can always override via the dropdown.
 * There's no reliable device-type signal available from either detection
 * service (neither returns a mask/device-descriptor read), so this is the
 * strongest auto-match available without adding a further real-hardware-
 * unconfirmed read to the flow.
 */
export function AddressDeviceModal({
  devices: allDevices,
  initialDeviceId,
  initialTab,
  initialSerial,
  lockDevice,
  onClose,
  addLog,
}: {
  devices: Device[];
  // Pre-selects a specific device (the row the modal was opened from) in
  // both tabs' "ASSIGN TO" dropdowns, instead of leaving them blank/
  // auto-matched-by-serial only. Still changeable - opening from one row
  // doesn't prevent addressing a different device if the scan turns up
  // something else - UNLESS lockDevice is also set (see below).
  initialDeviceId?: number;
  // Opens directly on the given tab instead of always defaulting to
  // 'detect' - added 2026-08-30 for the serial icon's "already has a
  // known serial" case (ProgrammingView.tsx), which makes more sense to
  // open straight on the serial tab with that value pre-filled than to
  // make the operator re-scan/re-enter something already on record.
  initialTab?: 'detect' | 'serial';
  // Pre-fills the manual serial-entry field (serial tab only).
  initialSerial?: string;
  // The target device is already fully known (a real serial is already
  // recorded against it) - hides the "ASSIGN TO" picker entirely rather
  // than offering a choice that doesn't apply. Only meaningful together
  // with initialDeviceId.
  lockDevice?: boolean;
  onClose: () => void;
  addLog: (line: string) => void;
}) {
  const { updateDevice } = useProjectActions();
  const [tab, setTab] = useState<'detect' | 'serial'>(initialTab ?? 'detect');
  const [showAllDevices, setShowAllDevices] = useState(false);

  // A device with no real project address at all (has_address=0, a
  // synthetic placeholder - see ets-parser.ts) is never offered here.
  // Writing that placeholder onto a physical unit via programIA/
  // assignIndividualAddressBySerial would be as hazardous as letting
  // Program/Verify touch it - it needs a real address assigned first
  // (AssignProjectAddressModal), a separate, required prior step.
  const devices = allDevices.filter((d) => d.has_address);

  // Candidate pool for the "assign to" dropdown. `status` here is the
  // download/program status (see server/ets-parser.ts's deriveStatus), not
  // a dedicated "has this physical unit been addressed yet" field - this
  // app has no such field. Used as a proxy instead: a device can only ever
  // have been successfully Programmed or found Modified if a real unit
  // already answered at its planned individual_address, so 'unassigned'
  // (never downloaded) is a reasonable stand-in for "still needs a real
  // device addressed to it". showAllDevices overrides this for the real
  // edge case (a working device gets factory-reset again).
  const candidates = showAllDevices
    ? devices
    : devices.filter((d) => d.status === 'unassigned');

  const matchBySerial = (serial: string): Device | null =>
    devices.find(
      (d) =>
        d.serial_number &&
        d.serial_number.toLowerCase() === serial.toLowerCase(),
    ) ?? null;

  // ── Detect tab (programming-mode scan) ──────────────────────────────────
  const [scanning, setScanning] = useState(false);
  const [detected, setDetected] = useState<
    Array<{ serial: string; src: string }> | null
  >(null);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [detectSelection, setDetectSelection] = useState<
    Record<string, number | ''>
  >({});
  const [detectBusy, setDetectBusy] = useState<Record<string, boolean>>({});
  const [detectResult, setDetectResult] = useState<
    Record<string, { ok: boolean; msg: string }>
  >({});

  const scan = async () => {
    setScanning(true);
    setDetectError(null);
    setDetected(null);
    addLog(`[${new Date().toLocaleTimeString()}] Scanning for devices in programming mode…`);
    try {
      const r = await api.busReadSerialsInProgrammingMode(3000);
      setDetected(r.devices);
      const sel: Record<string, number | ''> = {};
      for (const d of r.devices) {
        const m = matchBySerial(d.serial);
        sel[d.serial] = m ? m.id : (initialDeviceId ?? '');
      }
      setDetectSelection(sel);
      addLog(
        `[${new Date().toLocaleTimeString()}] Scan complete — ${r.devices.length} device(s) found in programming mode`,
      );
    } catch (e: any) {
      setDetectError(e.message);
    }
    setScanning(false);
  };

  const writeDetected = async (
    serial: string,
    viaProgIA: boolean,
    explicitTarget?: Device,
  ) => {
    const target =
      explicitTarget ?? devices.find((d) => d.id === detectSelection[serial]);
    if (!target) return;
    setDetectBusy((b) => ({ ...b, [serial]: true }));
    setDetectResult((r) => {
      const next = { ...r };
      delete next[serial];
      return next;
    });
    addLog(
      `[${new Date().toLocaleTimeString()}] Addressing ${serial} → ${target.individual_address} (${target.name})`,
    );
    try {
      if (viaProgIA) {
        await api.busProgramIA(target.individual_address);
      } else {
        const r = await api.busAssignAddressBySerial(
          serial,
          target.individual_address,
        );
        if (!r.verified) {
          throw new Error(
            r.address
              ? `Device reported ${r.address}, not ${target.individual_address}`
              : 'No read-back confirmation from the device',
          );
        }
      }
      await updateDevice(target.id, { serial_number: serial });
      setDetectResult((r) => ({
        ...r,
        [serial]: { ok: true, msg: `✓ Addressed as ${target.individual_address}` },
      }));
      addLog(
        `[${new Date().toLocaleTimeString()}] Addressed ${serial} → ${target.individual_address}`,
      );
    } catch (e: any) {
      setDetectResult((r) => ({ ...r, [serial]: { ok: false, msg: e.message } }));
      addLog(
        `[${new Date().toLocaleTimeString()}] Addressing failed → ${serial} — ${e.message}`,
      );
    }
    setDetectBusy((b) => ({ ...b, [serial]: false }));
  };

  // ── lockDevice-only: confirm a detected serial with no bus write ────────
  // Real request 2026-08-31: when the modal was opened for a specific,
  // already-addressed device, a scan that finds it already reporting the
  // EXPECTED address has nothing to write - programIA/assignAddressBySerial
  // would just be re-asserting an address the device already has. This
  // just records the serial (`updateDevice`), the same bookkeeping every
  // real write already does at the end, without touching the bus at all.
  const [confirmBusy, setConfirmBusy] = useState(false);
  const confirmSerial = async (serial: string) => {
    if (!lockedTarget) return;
    setConfirmBusy(true);
    try {
      await updateDevice(lockedTarget.id, { serial_number: serial });
      addLog(
        `[${new Date().toLocaleTimeString()}] Confirmed serial ${serial} for ${lockedTarget.individual_address}`,
      );
    } catch (e: any) {
      addLog(
        `[${new Date().toLocaleTimeString()}] Confirming serial failed → ${e.message}`,
      );
    }
    setConfirmBusy(false);
  };

  // ── Serial-entry tab ─────────────────────────────────────────────────────
  const [manualSerial, setManualSerial] = useState(initialSerial ?? '');
  const [manualDeviceId, setManualDeviceId] = useState<number | ''>(
    initialDeviceId ?? '',
  );
  const [manualBusy, setManualBusy] = useState(false);
  const [manualResult, setManualResult] = useState<
    { ok: boolean; msg: string } | null
  >(null);

  const manualSerialValid = /^[0-9a-fA-F]{12}$/.test(manualSerial);
  const manualMatch = manualSerialValid ? matchBySerial(manualSerial) : null;
  // Resolved from allDevices, not the has_address-filtered `devices` above
  // - real request 2026-08-31: opening this modal from the serial icon of
  // an unaddressed device (has_address=0) was inconsistent, popping the
  // "assign a project address" modal instead of this one. A locked target
  // can legitimately have no real address yet; what changes is which
  // actions are offered below (lockedNoAddress), not whether the target
  // itself can be found.
  const lockedTarget = lockDevice
    ? (allDevices.find((d) => d.id === initialDeviceId) ?? null)
    : null;
  // No real address to write to at all - only serial CAPTURE is safe here
  // (updateDevice, no bus write), same reasoning as the has_address guard
  // on `devices` above: writing to a synthetic placeholder address would
  // be hazardous, so no write path is offered for this case at all, not
  // even the normally-safe programIA/assignAddressBySerial ones.
  const lockedNoAddress = !!lockedTarget && !lockedTarget.has_address;
  const manualTarget = devices.find(
    (d) => d.id === (manualDeviceId || manualMatch?.id),
  );
  // Nothing to write - the entered serial already matches what's on
  // record for this device (real request 2026-08-31: don't offer a write
  // that would just be re-recording the same value).
  const manualNoChange =
    !!manualTarget &&
    !!manualTarget.serial_number &&
    manualTarget.serial_number.toLowerCase() === manualSerial.toLowerCase();

  const writeManual = async () => {
    const deviceId = manualDeviceId || manualMatch?.id;
    const target = devices.find((d) => d.id === deviceId);
    if (!target || !manualSerialValid) return;
    setManualBusy(true);
    setManualResult(null);
    addLog(
      `[${new Date().toLocaleTimeString()}] Addressing (by serial) ${manualSerial} → ${target.individual_address} (${target.name})`,
    );
    try {
      const r = await api.busAssignAddressBySerial(
        manualSerial,
        target.individual_address,
      );
      if (!r.verified) {
        throw new Error(
          r.address
            ? `Device reported ${r.address}, not ${target.individual_address}`
            : 'No read-back confirmation from the device',
        );
      }
      await updateDevice(target.id, { serial_number: manualSerial });
      setManualResult({ ok: true, msg: `✓ Addressed as ${target.individual_address}` });
      addLog(
        `[${new Date().toLocaleTimeString()}] Addressed ${manualSerial} → ${target.individual_address}`,
      );
    } catch (e: any) {
      setManualResult({ ok: false, msg: e.message });
      addLog(
        `[${new Date().toLocaleTimeString()}] Addressing failed → ${manualSerial} — ${e.message}`,
      );
    }
    setManualBusy(false);
  };

  return (
    <div className={styles.scrim} onClick={onClose}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <span className={styles.title}>
            {lockDevice
              ? lockedNoAddress
                ? 'Capture Device Serial Number'
                : 'Edit/Update Device Serial Number'
              : 'Address New Device'}
          </span>
          <button className={styles.closeBtn} onClick={onClose} title="Close">
            ✕
          </button>
        </div>
        <div className={styles.body}>
          <div className={styles.intro}>
            {lockDevice ? (
              lockedNoAddress ? (
                <>
                  Capture this device's serial number, either by pressing
                  its programming button to detect it, or by entering the
                  serial directly. No project address is assigned yet, so
                  nothing is written to the device - it just records the
                  serial.
                </>
              ) : (
                <>
                  Re-confirm or update the recorded serial number for this
                  device, either by pressing its programming button to
                  detect it, or by entering the serial directly.
                </>
              )
            ) : (
              <>
                Write a real KNX individual address onto a physical device,
                either by pressing its programming button to detect it, or by
                entering its serial number directly.
              </>
            )}
          </div>

          {lockDevice ? (
            // ── Known-device layout: no tabs, no candidate picker at all -
            // the target is already fixed (lockedTarget), so there is
            // nothing to choose between. Real request 2026-08-31: what
            // "press the programming button" should actually DO here is
            // different from the general new-device flow too - the device
            // already has its address, so a matching scan result has
            // nothing to write, only a serial to confirm (see
            // confirmSerial above). Only a scan result reporting a
            // DIFFERENT address than expected still offers a real write
            // (that physical unit isn't this project slot yet).
            <>
              <Btn onClick={scan} disabled={scanning}>
                {scanning ? (
                  <>
                    <Spinner /> Scanning…
                  </>
                ) : (
                  '⟲ Press Programming Button & Scan'
                )}
              </Btn>
              {detectError && (
                <div className={styles.errorMsg}>&#x2717; {detectError}</div>
              )}
              {detected && detected.length === 0 && (
                <div className={styles.emptyState}>
                  No devices answered. Press the physical programming button
                  on this device, then scan again.
                </div>
              )}
              {detected && detected.length > 0 && (
                <div className={styles.detectedList}>
                  {detected.map((d) => {
                    const busy = detectBusy[d.serial];
                    const result = detectResult[d.serial];
                    const canUseProgIA = detected.length === 1;
                    // No real project address to compare against at all -
                    // capture-only regardless of what this device
                    // currently reports (see lockedNoAddress above).
                    const isMatch =
                      lockedNoAddress ||
                      (!!lockedTarget &&
                        d.src === lockedTarget.individual_address);
                    return (
                      <div key={d.serial} className={styles.detectedRow}>
                        <div className={styles.detectedSerial}>
                          Serial {d.serial}
                        </div>
                        {isMatch ? (
                          <>
                            <div className={styles.matchedTag}>
                              {lockedNoAddress
                                ? 'No project address assigned yet — nothing to write, just capture the serial.'
                                : `Already reports ${lockedTarget!.individual_address} — nothing to write, just confirm the serial.`}
                            </div>
                            <Btn
                              onClick={() => confirmSerial(d.serial)}
                              disabled={confirmBusy}
                            >
                              {confirmBusy ? (
                                <Spinner />
                              ) : lockedNoAddress ? (
                                'Use This Serial'
                              ) : (
                                'Confirm Serial'
                              )}
                            </Btn>
                          </>
                        ) : (
                          <>
                            <div className={styles.unmatchedTag}>
                              Reports {d.src || 'no address'}, not{' '}
                              {lockedTarget?.individual_address} — writing
                              will re-address this physical unit.
                            </div>
                            <div className={styles.row}>
                              {canUseProgIA && (
                                <Btn
                                  onClick={() =>
                                    writeDetected(
                                      d.serial,
                                      true,
                                      lockedTarget ?? undefined,
                                    )
                                  }
                                  disabled={busy || !lockedTarget}
                                  title="Write via the programming-mode broadcast — real-hardware confirmed, safe here since exactly one device answered"
                                >
                                  {busy ? <Spinner /> : '⚡ Write Address'}
                                </Btn>
                              )}
                              <Btn
                                onClick={() =>
                                  writeDetected(
                                    d.serial,
                                    false,
                                    lockedTarget ?? undefined,
                                  )
                                }
                                disabled={busy || !lockedTarget}
                                color="var(--amber)"
                                title="Write by targeting this exact serial number — not yet confirmed on real hardware"
                              >
                                {busy ? (
                                  <Spinner />
                                ) : (
                                  <>
                                    Write by Serial{' '}
                                    <span className={styles.experimentalBadge}>
                                      Experimental
                                    </span>
                                  </>
                                )}
                              </Btn>
                            </div>
                          </>
                        )}
                        {result && (
                          <div
                            className={
                              result.ok ? styles.successMsg : styles.errorMsg
                            }
                          >
                            {result.msg}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              <div className={styles.orDivider}>OR</div>

              <div className={styles.row}>
                <div className={styles.col}>
                  <div className={styles.fieldLabel}>SERIAL NUMBER (12 hex chars)</div>
                  <input
                    className={styles.textInput}
                    value={manualSerial}
                    onChange={(e) => setManualSerial(e.target.value.trim())}
                    placeholder="e.g. 00fa1234abcd"
                  />
                </div>
              </div>
              {manualSerial && !manualSerialValid && (
                <div className={styles.errorMsg}>
                  Serial must be exactly 12 hex characters (6 bytes).
                </div>
              )}
              {lockedTarget && (
                <div className={styles.matchedTag}>
                  {lockedNoAddress
                    ? `Recording serial for: ${lockedTarget.name}`
                    : `Addressing: ${lockedTarget.individual_address} — ${lockedTarget.name}`}
                </div>
              )}
              {lockedNoAddress ? (
                <Btn
                  onClick={() => confirmSerial(manualSerial)}
                  disabled={
                    confirmBusy || !manualSerialValid || manualNoChange
                  }
                  title={
                    manualNoChange
                      ? 'No change — this is already the recorded serial for this device'
                      : 'Record this serial number — no bus write, there is no project address yet to write it to'
                  }
                >
                  {confirmBusy ? <Spinner /> : 'Use This Serial'}
                </Btn>
              ) : (
                <Btn
                  onClick={writeManual}
                  disabled={
                    manualBusy ||
                    !manualSerialValid ||
                    !(manualDeviceId || manualMatch) ||
                    manualNoChange
                  }
                  color="var(--amber)"
                  title={
                    manualNoChange
                      ? 'No change — this is already the recorded serial for this device'
                      : 'Write by targeting this exact serial number — not yet confirmed on real hardware'
                  }
                >
                  {manualBusy ? (
                    <Spinner />
                  ) : (
                    <>
                      Write Address{' '}
                      <span className={styles.experimentalBadge}>
                        Experimental
                      </span>
                    </>
                  )}
                </Btn>
              )}
              {manualResult && (
                <div
                  className={
                    manualResult.ok ? styles.successMsg : styles.errorMsg
                  }
                >
                  {manualResult.msg}
                </div>
              )}
            </>
          ) : (
            <>
          <div className={styles.tabRow}>
            <button
              className={`${styles.tabBtn} ${tab === 'detect' ? styles.tabBtnActive : ''}`}
              onClick={() => setTab('detect')}
            >
              Press Programming Button
            </button>
            <button
              className={`${styles.tabBtn} ${tab === 'serial' ? styles.tabBtnActive : ''}`}
              onClick={() => setTab('serial')}
            >
              Enter Serial Number
            </button>
          </div>

          <label className={styles.checkboxRow}>
            <input
              type="checkbox"
              checked={showAllDevices}
              onChange={(e) => setShowAllDevices(e.target.checked)}
            />
            Show already-programmed devices too (re-addressing a factory-reset unit)
          </label>

          {tab === 'detect' ? (
            <>
              <Btn onClick={scan} disabled={scanning}>
                {scanning ? (
                  <>
                    <Spinner /> Scanning…
                  </>
                ) : (
                  '⟲ Scan for devices in programming mode'
                )}
              </Btn>
              {detectError && (
                <div className={styles.errorMsg}>&#x2717; {detectError}</div>
              )}
              {detected && detected.length === 0 && (
                <div className={styles.emptyState}>
                  No devices answered. Press the physical programming button
                  on the target device, then scan again.
                </div>
              )}
              {detected && detected.length > 0 && (
                <div className={styles.detectedList}>
                  {detected.map((d) => {
                    const matched = matchBySerial(d.serial);
                    const busy = detectBusy[d.serial];
                    const result = detectResult[d.serial];
                    const canUseProgIA = detected.length === 1;
                    const selectedTarget = devices.find(
                      (dev) => dev.id === detectSelection[d.serial],
                    );
                    // d.src is the device's real, currently-reported
                    // individual address (A_IndividualAddress_Read, read
                    // live during the scan) - nothing to write if the
                    // selected target's own address already matches it
                    // (real request 2026-08-31, same reasoning as the
                    // manual tab's no-change guard below).
                    const noChange =
                      !!selectedTarget &&
                      selectedTarget.individual_address === d.src;
                    return (
                      <div key={d.serial} className={styles.detectedRow}>
                        <div className={styles.detectedSerial}>
                          Serial {d.serial}
                        </div>
                        {matched ? (
                          <div className={styles.matchedTag}>
                            Matched project record: {matched.name}
                          </div>
                        ) : (
                          <div className={styles.unmatchedTag}>
                            No matching serial in the project — pick manually
                          </div>
                        )}
                        <div className={styles.row}>
                          <div className={styles.col}>
                            <div className={styles.fieldLabel}>ASSIGN TO</div>
                            <select
                              className={styles.select}
                              value={detectSelection[d.serial] ?? ''}
                              onChange={(e) =>
                                setDetectSelection((s) => ({
                                  ...s,
                                  [d.serial]: e.target.value
                                    ? Number(e.target.value)
                                    : '',
                                }))
                              }
                            >
                              <option value="">— select a device —</option>
                              {candidates.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.individual_address} — {c.name}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>
                        <div className={styles.row}>
                          {canUseProgIA && (
                            <Btn
                              onClick={() => writeDetected(d.serial, true)}
                              disabled={
                                busy || !detectSelection[d.serial] || noChange
                              }
                              title={
                                noChange
                                  ? 'No change — this device already reports this address'
                                  : 'Write via the programming-mode broadcast — real-hardware confirmed, safe here since exactly one device answered'
                              }
                            >
                              {busy ? <Spinner /> : '⚡ Write Address'}
                            </Btn>
                          )}
                          <Btn
                            onClick={() => writeDetected(d.serial, false)}
                            disabled={
                              busy || !detectSelection[d.serial] || noChange
                            }
                            color="var(--amber)"
                            title={
                              noChange
                                ? 'No change — this device already reports this address'
                                : 'Write by targeting this exact serial number — not yet confirmed on real hardware'
                            }
                          >
                            {busy ? (
                              <Spinner />
                            ) : (
                              <>
                                Write by Serial{' '}
                                <span className={styles.experimentalBadge}>
                                  Experimental
                                </span>
                              </>
                            )}
                          </Btn>
                        </div>
                        {result && (
                          <div
                            className={
                              result.ok ? styles.successMsg : styles.errorMsg
                            }
                          >
                            {result.msg}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            <>
              <div className={styles.row}>
                <div className={styles.col}>
                  <div className={styles.fieldLabel}>SERIAL NUMBER (12 hex chars)</div>
                  <input
                    className={styles.textInput}
                    value={manualSerial}
                    onChange={(e) => setManualSerial(e.target.value.trim())}
                    placeholder="e.g. 00fa1234abcd"
                  />
                </div>
              </div>
              {manualSerial && !manualSerialValid && (
                <div className={styles.errorMsg}>
                  Serial must be exactly 12 hex characters (6 bytes).
                </div>
              )}
              {lockDevice ? (
                lockedTarget && (
                  <div className={styles.matchedTag}>
                    Addressing: {lockedTarget.individual_address} —{' '}
                    {lockedTarget.name}
                  </div>
                )
              ) : (
                <>
                  <div className={styles.row}>
                    <div className={styles.col}>
                      <div className={styles.fieldLabel}>ASSIGN TO</div>
                      <select
                        className={styles.select}
                        value={manualDeviceId || manualMatch?.id || ''}
                        onChange={(e) =>
                          setManualDeviceId(
                            e.target.value ? Number(e.target.value) : '',
                          )
                        }
                      >
                        <option value="">— select a device —</option>
                        {candidates.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.individual_address} — {c.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {manualMatch && !manualDeviceId && (
                    <div className={styles.matchedTag}>
                      Matched project record: {manualMatch.name}
                    </div>
                  )}
                </>
              )}
              <Btn
                onClick={writeManual}
                disabled={
                  manualBusy ||
                  !manualSerialValid ||
                  !(manualDeviceId || manualMatch) ||
                  manualNoChange
                }
                color="var(--amber)"
                title={
                  manualNoChange
                    ? 'No change — this is already the recorded serial for this device'
                    : 'Write by targeting this exact serial number — not yet confirmed on real hardware'
                }
              >
                {manualBusy ? (
                  <Spinner />
                ) : (
                  <>
                    Write Address{' '}
                    <span className={styles.experimentalBadge}>
                      Experimental
                    </span>
                  </>
                )}
              </Btn>
              {manualResult && (
                <div
                  className={
                    manualResult.ok ? styles.successMsg : styles.errorMsg
                  }
                >
                  {manualResult.msg}
                </div>
              )}
            </>
          )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
