import React, { useEffect, useMemo, useRef, useState } from "react";

const roomId =
  new URLSearchParams(window.location.search).get("instance_id") || "local";

const wsUrl = (() => {
  const isDev = typeof import.meta !== "undefined" && import.meta.env && import.meta.env.DEV;
  const host = isDev ? "localhost:8787" : window.location.host;
  const proto = isDev ? "ws" : window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${host}/ws?instance_id=${encodeURIComponent(roomId)}`;
})();

const SYNC_SAMPLE_COUNT = 6;
const SYNC_INTERVAL_MS = 10000; // every 10 seconds

function navigateToRoom(id) {
  const url = new URL(window.location.href);
  url.searchParams.set("instance_id", id);
  window.location.href = url.toString();
}

function createRandomRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatMs(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${pad2(m)}:${pad2(s)}`;
}

function formatTimeOfDay(ts) {
  const d = new Date(ts);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(
    d.getUTCSeconds()
  )} UTC`;
}

/* ------------------ Local Settings Hook ------------------ */

const SETTINGS_KEY = "wos-rally-local-settings-v1";

function useLocalSettings() {
  const [beepLevel, setBeepLevel] = useState(70); // 0–100
  const [ttsLevel, setTtsLevel] = useState(80);   // 0–100
  const [selectedIds, setSelectedIds] = useState([]);

  // Load once
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (typeof parsed.beepLevel === "number") setBeepLevel(parsed.beepLevel);
      if (typeof parsed.ttsLevel === "number") setTtsLevel(parsed.ttsLevel);
      if (Array.isArray(parsed.selectedIds))
        setSelectedIds(parsed.selectedIds);
    } catch (e) {
      console.warn("Failed to read local settings", e);
    }
  }, []);

  // Save when something changes
  useEffect(() => {
    try {
      const data = {
        beepLevel,
        ttsLevel,
        selectedIds,
      };
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn("Failed to write local settings", e);
    }
  }, [beepLevel, ttsLevel, selectedIds]);

  return {
    beepLevel,
    setBeepLevel,
    ttsLevel,
    setTtsLevel,
    selectedIds,
    setSelectedIds,
  };
}

/** ---------------------------
 *  Hybrid Audio: TTS name + WebAudio beeps (overlap-safe)
 *  ---------------------------
 */

let audioCtx = null;

function ensureAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!audioCtx) audioCtx = new Ctx();
  if (audioCtx.state === "suspended") {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

function beepAt(
  timeSec,
  { freq = 800, duration = 0.085, gain = 0.06 } = {}
) {
  const ctx = ensureAudio();
  if (!ctx) return;

  const osc = ctx.createOscillator();
  const g = ctx.createGain();

  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, timeSec);

  g.gain.setValueAtTime(0.0001, timeSec);
  g.gain.linearRampToValueAtTime(gain, timeSec + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, timeSec + duration);

  osc.connect(g).connect(ctx.destination);
  osc.start(timeSec);
  osc.stop(timeSec + duration + 0.03);
}

function unlockAudio() {
  try {
    const ctx = ensureAudio();
    if (!ctx) return;
    const t = ctx.currentTime + 0.01;
    beepAt(t, { freq: 30, duration: 0.03, gain: 0.0002 });
  } catch {}
}

// TTS name only
function speakName(
  name,
  { rate = 1.05, pitch = 1.0, volume = 1.0, lang = "en-US" } = {}
) {
  try {
    if (!("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(`${name}, get ready`);
    u.rate = rate;
    u.pitch = pitch;
    u.volume = volume;
    u.lang = lang;
    window.speechSynthesis.speak(u);
  } catch {}
}

function unlockTTS() {
  try {
    if (!("speechSynthesis" in window)) return;
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    window.speechSynthesis.speak(u);
  } catch {}
}

function scheduleBeepsToTarget(
  targetTs,
  nowTs,
  {
    spacingSec = 0.75,
    leadSec = 5 * 0.75,
    freqCount = 720,
    freqGo = 1100,
    gain = 0.065,
    gainFactor = 1.0,
  } = {}
) {
  const ctx = ensureAudio();
  if (!ctx) return;

  const secUntilTarget = Math.max(0, (targetTs - nowTs) / 1000);
  const base = ctx.currentTime + secUntilTarget;

  const first = base - leadSec;
  const startTime = Math.max(ctx.currentTime + 0.02, first);
  const goTime = Math.max(ctx.currentTime + 0.02, base);

  const times = [];
  for (let i = 5; i >= 1; i--) {
    const t = goTime - (6 - i) * spacingSec;
    times.push({ n: i, t });
  }

  const filtered = times
    .filter((x) => x.t >= startTime && x.t <= goTime - 0.01)
    .sort((a, b) => a.t - b.t);

  for (const x of filtered) {
    beepAt(x.t, {
      freq: freqCount,
      duration: 0.085,
      gain: gain * gainFactor,
    });
  }
  beepAt(goTime, {
    freq: freqGo,
    duration: 0.12,
    gain: gain * 1.1 * gainFactor,
  });
}

function callNameWithBeeps(
  name,
  targetTs,
  nowTs,
  { ttsVolume = 1.0, beepGainFactor = 1.0 } = {}
) {
  speakName(name, { lang: "en-US", rate: 1.05, volume: ttsVolume });
  scheduleBeepsToTarget(targetTs, nowTs, { gainFactor: beepGainFactor });
}

/* ------------------ RallyApp ------------------ */
export function RallyApp() {
  const [ws, setWs] = useState(null);
  const [state, setState] = useState({ players: [], rally: null });
  const [now, setNow] = useState(Date.now());
  const [timeOffsetMs, setTimeOffsetMs] = useState(0);
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [bestRttMs, setBestRttMs] = useState(null);
  const offsetRef = useRef(0);
  const syncSamplesRef = useRef([]);  

  // Player input
  const [name, setName] = useState("");
  const [seconds, setSeconds] = useState(32);

  // Rally input
  const [starterId, setStarterId] = useState("");
  const [delay, setDelay] = useState(5);

  // Pre-start countdown
  const [preDelaySec, setPreDelaySec] = useState(10);

  // TTS on/off
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [ttsRallyCalls, setTtsRallyCalls] = useState(true);
  const [ttsMarchCalls, setTtsMarchCalls] = useState(false);

  // Local settings (volume + player selection)
  const {
    beepLevel,
    setBeepLevel,
    ttsLevel,
    setTtsLevel,
    selectedIds,
    setSelectedIds,
  } = useLocalSettings();

  const announcedRef = useRef(new Set());

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const beepGainFactor = Math.max(0, Math.min(1, beepLevel / 100));
  const ttsVolume = Math.max(0, Math.min(1, ttsLevel / 100));

  function toggleNotifyPlayer(playerId) {
    setSelectedIds((prev) => {
      const set = new Set(prev);
      if (set.has(playerId)) {
        set.delete(playerId);
      } else {
        set.add(playerId);
      }
      return Array.from(set);
    });
  }

  function setOffsetSample(offsetMs, rttMs, atTs) {
    const samples = syncSamplesRef.current.slice(-SYNC_SAMPLE_COUNT + 1);
    samples.push({ offsetMs, rttMs, atTs });
    const best = samples.reduce((min, next) => (next.rttMs < min.rttMs ? next : min), samples[0]);
    syncSamplesRef.current = samples;
    if (best) {
      offsetRef.current = best.offsetMs;
      setTimeOffsetMs(best.offsetMs);
      setBestRttMs(best.rttMs);
      setLastSyncAt(atTs);
    }
  }

  function handleTimeSyncResponse(payload) {
    if (!payload) return;
    const { t0, t1, t2 } = payload;
    if (![t0, t1, t2].every((v) => Number.isFinite(v))) return;
    const t3 = Date.now();
    const rtt = Math.max(0, (t3 - t0) - (t2 - t1));
    const offset = ((t1 - t0) + (t2 - t3)) / 2;
    setOffsetSample(offset, rtt, t3);
  }

  function requestTimeSync(socket) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "TIME_SYNC_REQUEST", roomId, payload: { t0: Date.now() } }));
  }

  function runSyncBurst(socket) {
    for (let i = 0; i < SYNC_SAMPLE_COUNT; i += 1) {
      setTimeout(() => requestTimeSync(socket), i * 250);
    }
  }

  useEffect(() => {
    const socket = new WebSocket(wsUrl);
    let syncInterval = null;

    const handleOpen = () => {socket.send(JSON.stringify({ type: "STATE_REQUEST", roomId }));
      runSyncBurst(socket);
      syncInterval = window.setInterval(() => runSyncBurst(socket), SYNC_INTERVAL_MS);
    };

    const handleMessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg?.type === "STATE") {
        setState(msg.payload);
        return;
      }
      if (msg?.type === "TIME_SYNC_RESPONSE") {
        handleTimeSyncResponse(msg.payload);
      }
  };

    socket.addEventListener("open", handleOpen);
    socket.addEventListener("message", handleMessage);
    socket.addEventListener("error", () => {});
    setWs(socket);

    return () => {
      if (syncInterval) window.clearInterval(syncInterval);
      socket.removeEventListener("open", handleOpen);
      socket.removeEventListener("message", handleMessage);
      socket.close();
    };
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() + offsetRef.current), 200);
    return () => clearInterval(t);
  }, []);

  const canAdd =
    ws &&
    name.trim().length > 0 &&
    Number.isFinite(Number(seconds)) &&
    Number(seconds) > 0 &&
    Number(seconds) <= 24 * 60 * 60;

  const canStartRally =
    ws &&
    state.players.length > 0 &&
    starterId &&
    state.players.some((p) => p.id === starterId);

  function addPlayer() {
    if (!canAdd) return;
    const marchMs = Math.round(Number(seconds) * 1000);

    ws.send(
      JSON.stringify({
        roomId,
        type: "PLAYER_ADD",
        payload: {
          id: crypto.randomUUID(),
          name: name.trim(),
          marchMs,
        },
      })
    );

    setName("");
  }

  function removePlayer(id) {
    if (!ws) return;
    ws.send(JSON.stringify({ roomId, type: "PLAYER_REMOVE", payload: id }));
  }

  function sendRallyStart() {
    if (!canStartRally) return;

    const rallyDurationMs = delay * 60 * 1000;
    const preDelayMs = Math.max(0, preDelaySec) * 1000;

    ws.send(
      JSON.stringify({
        roomId,
        type: "RALLY_START",
        payload: { starterId, rallyDurationMs, preDelayMs },
      })
    );
  }


  function startRally() {
    if (!canStartRally) return;

    if (ttsEnabled) unlockTTS();
    unlockAudio();

    sendRallyStart();
  }

  function endRally() {
    if (!ws) return;
    ws.send(JSON.stringify({ roomId, type: "RALLY_END" }));
    announcedRef.current = new Set();
  }

  const rallyComputed = useMemo(() => {
    const activeRally = state.rally;
    if (!activeRally) return null;

    const starter = state.players.find((p) => p.id === activeRally.starterId);
    if (!starter) return null;

    const launchAt = activeRally.launchAt; // vom Server
    const rallyDurationMs = delay * 60 * 1000;
    const rallyStartAt = launchAt - rallyDurationMs;
    const arrivalAt = launchAt + starter.marchMs;

    const joinRemainingMs = launchAt - now;
    const phase = joinRemainingMs > 0 ? "JOIN" : "MARCH";

    const rows = state.players
      .map((p) => {
        const startAt = arrivalAt - p.marchMs;
        const playerRallyStartAt = startAt - rallyDurationMs;
        const diffMs = startAt - now;
        const diffToRallyStartMs = playerRallyStartAt - now;
        const diffFromLaunchMs = startAt - launchAt;
        const landInMs = arrivalAt - now;

        return {
          ...p,
          startAt,
          rallyStartAt: playerRallyStartAt,
          diffMs,
          diffToRallyStartMs,
          diffFromLaunchMs,
          landInMs,
        };
      })
      .sort((a, b) => a.startAt - b.startAt);

    return {
      starter,
      launchAt,
      rallyStartAt,
      arrivalAt,
      rows,
      joinRemainingMs,
      phase,
    };
  }, [state, now, delay]);

  // Hybrid scheduler: only local-selected players, local volumes
  const effectiveOnlySelected = selectedIds.length > 0;
  const syncFreshMs = 60000;
  const isSynced = lastSyncAt && Date.now() - lastSyncAt < syncFreshMs;
  const syncLabel = isSynced ? "Synced" : "Syncing";

  useEffect(() => {
    if (!ttsEnabled) return;
    if (!rallyComputed) return;

    const triggerMs = 4200;
    const toleranceMs = 350;

    const callFor = (playerName, targetTs) => {
      callNameWithBeeps(playerName, targetTs, now, {
        ttsVolume,
        beepGainFactor,
      });
    };

    for (const r of rallyComputed.rows) {
      // nur selektierte Spieler, wenn entweder Toggle an ist
      // ODER mindestens ein Spieler ausgewählt wurde
      if (effectiveOnlySelected && !selectedSet.has(r.id)) {
        continue;
      }

      let targetTs = null;
      let key = null;

      if (rallyComputed.phase === "JOIN" && ttsRallyCalls) {
        targetTs = r.rallyStartAt;
        key = `rally:${r.id}:${targetTs}`;
      } else if (rallyComputed.phase === "MARCH" && ttsMarchCalls) {
        targetTs = r.startAt;
        key = `march:${r.id}:${targetTs}`;
      } else {
        continue;
      }

      if (announcedRef.current.has(key)) continue;

      const msLeft = targetTs - now;

      if (msLeft <= triggerMs && msLeft >= triggerMs - toleranceMs) {
        announcedRef.current.add(key);
        callFor(r.name, targetTs);
      }

      if (msLeft < triggerMs - toleranceMs && msLeft > 600) {
        announcedRef.current.add(key);
        callFor(r.name, targetTs);
      }
    }
  }, [
    ttsEnabled,
    ttsRallyCalls,
    ttsMarchCalls,
    rallyComputed,
    now,
    ttsVolume,
    beepGainFactor,
    effectiveOnlySelected,
    selectedSet,
  ]);


  return (
    <div className="page">
      <style>{css}</style>

      <header className="header">
        <div>
          <div className="kicker">WOS Rally Sync</div>
          <h1 className="title">Time your rally</h1>
          <div className="sub">
            Room: <span className="mono">{roomId}</span>
          </div>
          <div style={{ marginTop: 6, color: "var(--muted)", fontSize: 13 }}>
            Time is shown in UTC
          </div>
        </div>
        <div className={`chip ${isSynced ? "ok" : "warn"}`} title={`Clock offset: ${Math.round(timeOffsetMs)} ms, RTT: ${bestRttMs ?? "?"} ms`}>
          <span className="dot" />
          Live. {syncLabel}
        </div>
      </header>

      <main className="grid">
        {/* Player list */}
        <section className="card">
          <div className="cardHead">
            <div>
              <h2>Player</h2>
              <p>Enter march time in seconds.</p>
            </div>
          </div>

          <div className="formRow">
            <div className="field">
              <label>Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Speed"
                onKeyDown={(e) => {
                  if (e.key === "Enter") addPlayer();
                }}
              />
            </div>

            <div className="field">
              <label>March (Sec.)</label>
              <input
                type="number"
                min={1}
                max={24 * 60 * 60}
                step={1}
                value={seconds}
                onChange={(e) => setSeconds(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addPlayer();
                }}
              />
            </div>

            <button className="btn primary" onClick={addPlayer} disabled={!canAdd}>
              + Add
            </button>
          </div>

          <div className="tableWrap">
            {state.players.length === 0 ? (
              <div className="empty">No Players added.</div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Player</th>
                    <th>March</th>
                    <th>Notify only for</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {state.players
                    .slice()
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((p) => {
                      const checked = selectedSet.has(p.id);
                      return (
                        <tr key={p.id}>
                          <td className="strong">{p.name}</td>
                          <td className="mono">{formatMs(p.marchMs)}</td>
                          <td>
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleNotifyPlayer(p.id)}
                              title="Local: receive calls for this player"
                            />
                          </td>
                          <td className="right">
                            <button
                              className="btn ghost"
                              onClick={() => removePlayer(p.id)}
                              title="Remove"
                            >
                              Remove
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            )}
          </div>
        </section>

        {/* Countdown */}
        <section className="card">
          <div className="cardHead">
            <div>
              <h2>Countdown</h2>
              <p>Starter is used as reference for march time. Select starter and delay.</p>
            </div>

            <div className="ttsRow">
              <label className="ttsToggle">
                <input
                  type="checkbox"
                  checked={ttsEnabled}
                  onChange={(e) => setTtsEnabled(e.target.checked)}
                />
                <span>Voice + Beeps</span>
              </label>

              <label className="ttsToggle">
                <input
                  type="checkbox"
                  checked={ttsRallyCalls}
                  disabled={!ttsEnabled}
                  onChange={(e) => setTtsRallyCalls(e.target.checked)}
                />
                <span>Call Rally Start</span>
              </label>

              <label className="ttsToggle">
                <input
                  type="checkbox"
                  checked={ttsMarchCalls}
                  disabled={!ttsEnabled}
                  onChange={(e) => setTtsMarchCalls(e.target.checked)}
                />
                <span>Call March Start</span>
              </label>

              <button
                className="btn ghost"
                type="button"
                onClick={() => {
                  unlockTTS();
                  unlockAudio();
                  const target = Date.now() + 5000;
                  callNameWithBeeps("Test", target, Date.now(), {
                    ttsVolume,
                    beepGainFactor,
                  });
                }}
              >
                Test Voice
              </button>
            </div>
          </div>

          {/* Local audio settings */}
          <div className="localSettings">
            <div className="localSettingsCol">
              <label className="localLabel">
                Beep volume ({beepLevel}%)
              </label>
              <input
                type="range"
                min={0}
                max={100}
                value={beepLevel}
                onChange={(e) => setBeepLevel(Number(e.target.value))}
              />
            </div>
            <div className="localSettingsCol">
              <label className="localLabel">
                Voice volume ({ttsLevel}%)
              </label>
              <input
                type="range"
                min={0}
                max={100}
                value={ttsLevel}
                onChange={(e) => setTtsLevel(Number(e.target.value))}
              />
            </div>
          </div>

          <div className="controls">
            <div className="field starterField">
              <label>Starter</label>
              <select value={starterId} onChange={(e) => setStarterId(e.target.value)}>
                <option value="">Choose Starter</option>
                {state.players
                  .slice()
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({formatMs(p.marchMs)})
                    </option>
                  ))}
              </select>
            </div>

            <div className="field">
              <label>Rally-Time (min)</label>
              <div className="field rallyTime">
                <button
                  className={`segBtn ${delay === 5 ? "active" : ""}`}
                  onClick={() => setDelay(5)}
                  type="button"
                >
                  5 min
                </button>
                <button
                  className={`segBtn ${delay === 10 ? "active" : ""}`}
                  onClick={() => setDelay(10)}
                  type="button"
                >
                  10 min
                </button>
              </div>
            </div>

            <div className="field">
              <label>Delay to start (Sec.)</label>
              <div className="delayInput">
                <input
                  type="number"
                  min={0}
                  step={1}
                  value={preDelaySec}
                  onChange={(e) => setPreDelaySec(Number(e.target.value))}
                />
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button
                className="btn primary"
                onClick={startRally}
                disabled={!canStartRally}
                title={!canStartRally ? "Choose Starter" : "Start Rally"}
              >
                Start Rally
              </button>
            </div>
          </div>

          {rallyComputed ? (
            <>
              <div className="metaRow">
                <div className="meta">
                  <div className="metaLabel">Starter</div>
                  <div className="metaValue">{rallyComputed.starter.name}</div>
                </div>

                <div className="meta">
                  <div className="metaLabel">Rally-Start at</div>
                  <div className="metaValue mono">
                    {formatTimeOfDay(rallyComputed.rallyStartAt)}
                  </div>
                </div>

                <div className="meta">
                  <div className="metaLabel">March-Start at</div>
                  <div className="metaValue mono">
                    {formatTimeOfDay(rallyComputed.launchAt)}
                  </div>
                </div>

                <div className="meta">
                  <div className="metaLabel">Hit at</div>
                  <div className="metaValue mono">
                    {formatTimeOfDay(rallyComputed.arrivalAt)}
                  </div>
                </div>
              </div>

              <div className="tableWrap" style={{ marginTop: 10 }}>
                <div style={{ padding: "12px 12px" }}>
                  {rallyComputed.phase === "JOIN" ? (
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 12,
                        alignItems: "center",
                      }}
                    >
                      <div>
                        <div className="metaLabel">Join Phase</div>
                        <div className="metaValue mono">
                          March starts in {formatMs(rallyComputed.joinRemainingMs)}
                        </div>
                      </div>
                      <span className="badge ok">JOIN</span>
                    </div>
                  ) : (
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 12,
                        alignItems: "center",
                      }}
                    >
                      <div>
                        <div className="metaLabel">March Phase</div>
                        <div className="metaValue mono">
                          March started at {formatTimeOfDay(rallyComputed.launchAt)}
                        </div>
                      </div>
                      <span className="badge warn">MARCH</span>
                    </div>
                  )}
                </div>
              </div>

              <div style={{ marginTop: 8, textAlign: "right" }}>
                <button className="btn ghost" onClick={endRally} title="End Rally">
                  End Rally
                </button>
              </div>

              <div className="tableWrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Player</th>
                      <th>Rally-Start</th>
                      <th>Countdown</th>
                      <th>Land in</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rallyComputed.rows.map((r) => {
                      const isJoin = rallyComputed.phase === "JOIN";
                      const landInText =
                        r.landInMs >= 0
                          ? formatMs(r.landInMs)
                          : `-${formatMs(-r.landInMs)}`;

                      let countdownText = "";
                      if (isJoin) {
                        if (r.diffToRallyStartMs > 0) {
                          countdownText = `in ${formatMs(r.diffToRallyStartMs)}`;
                        } else {
                          countdownText = `running ${formatMs(-r.diffToRallyStartMs)}`;
                        }
                        if (r.diffFromLaunchMs < 0) countdownText += ` (before March)`;
                      } else {
                        countdownText =
                          r.diffMs > 0
                            ? formatMs(r.diffMs)
                            : `since ${formatMs(-r.diffMs)}`;
                      }

                      let badgeClass = "ok";
                      let badgeText = "";

                      if (isJoin) {
                        if (r.diffToRallyStartMs > 0) {
                          badgeClass = "warn";
                          badgeText = "RALLY PENDING";
                        } else {
                          badgeClass = "ok";
                          badgeText = "RALLY RUNNING";
                        }
                      } else {
                        if (r.diffMs > 0) {
                          badgeClass = "ok";
                          badgeText = "WAIT";
                        } else {
                          badgeClass = "warn";
                          badgeText = "MARCHING";
                        }
                      }

                      return (
                        <tr key={r.id}>
                          <td className="strong">{r.name}</td>
                          <td className="mono">{formatTimeOfDay(r.rallyStartAt)}</td>
                          <td className="mono">{countdownText}</td>
                          <td className="mono">{landInText}</td>
                          <td>
                            <span className={`badge ${badgeClass}`}>{badgeText}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <div className="empty">
              No rally started yet. Select starter → "Start Rally".
            </div>
          )}
        </section>
      </main>

      <footer className="footer">
        <span className="mono">now (UTC): {formatTimeOfDay(now)}</span>
      </footer>
    </div>
  );
}

function Landing() {
  const [roomInput, setRoomInput] = useState("");

  const handleJoin = () => {
    const trimmed = roomInput.trim();
    if (!trimmed) return;
    navigateToRoom(trimmed);
  };

  const handleCreate = () => {
    const id = createRandomRoomId();
    navigateToRoom(id);
  };

  return (
    <div className="page">
      <style>{css}</style>

      <header className="header">
        <div>
          <div className="kicker">WOS Rally Sync</div>
          <h1 className="title">Coordinate your rallies</h1>
          <div className="sub">
            Create a room or join an existing one by ID.
          </div>
        </div>
      </header>

      <main style={{ maxWidth: 480, margin: "0 auto" }}>
        <section className="card">
          <div className="cardHead">
            <div>
              <h2>Start a session</h2>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <button
              type="button"
              className="btn primary"
              onClick={handleCreate}
            >
              Create random room
            </button>

            <div className="field">
              <label>Join by room ID</label>
              <input
                value={roomInput}
                onChange={(e) => setRoomInput(e.target.value)}
                placeholder="Paste or type room ID"
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleJoin();
                }}
              />
            </div>

            <button
              type="button"
              className="btn"
              onClick={handleJoin}
              disabled={!roomInput.trim()}
            >
              Join room
            </button>

            <div className="empty">
              Tip: Share the URL (including <span className="mono">?instance_id=…</span>)
              so others land in exactly the same room.
            </div>
          </div>
        </section>
      </main>

      <footer className="footer">
        <span className="mono">now (UTC): {formatTimeOfDay(Date.now())}</span>
      </footer>
    </div>
  );
}

export default function App() {
  const [instanceId] = useState(() => {
    return (
      new URLSearchParams(window.location.search).get("instance_id") || ""
    );
  });

  // if discord-activity with instance_id → directly to the session
  if (instanceId) {
    return <RallyApp />;
  }

  // without instance_id → Landing Page
  return <Landing />;
}

const css = `
  :root{
    --bg0:#0b1020;
    --bg1:#0f1730;
    --card:rgba(255,255,255,.06);
    --card2:rgba(255,255,255,.09);
    --border:rgba(255,255,255,.12);
    --text:rgba(255,255,255,.92);
    --muted:rgba(255,255,255,.64);
    --muted2:rgba(255,255,255,.46);
    --shadow:0 14px 40px rgba(0,0,0,.35);
    --radius:16px;
  }
  *{box-sizing:border-box}
  body{
    margin:0;
    color:var(--text);
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji";
    background:
      radial-gradient(1200px 800px at 10% 0%, rgba(86,119,255,.35), transparent 55%),
      radial-gradient(900px 700px at 90% 15%, rgba(61,212,255,.20), transparent 60%),
      linear-gradient(180deg, var(--bg0), var(--bg1));
    min-height:100vh;
  }
  .page{
    max-width:1100px;
    margin:0 auto;
    padding:24px 18px 36px;
  }
  .header{
    display:flex;
    align-items:flex-start;
    justify-content:space-between;
    gap:16px;
    margin-bottom:18px;
  }
  .kicker{
    font-size:12px;
    letter-spacing:.16em;
    color:var(--muted2);
    text-transform:uppercase;
    margin-bottom:6px;
  }
  .title{
    margin:0;
    font-size:28px;
    line-height:1.1;
  }
  .sub{
    margin-top:8px;
    color:var(--muted);
    font-size:13px;
  }
  .chip{
    display:flex;
    align-items:center;
    gap:8px;
    padding:10px 12px;
    border:1px solid var(--border);
    border-radius:999px;
    background:rgba(255,255,255,.06);
    box-shadow: var(--shadow);
    color:var(--muted);
    font-size:13px;
    user-select:none;
  }
  .dot{
    width:10px;height:10px;border-radius:999px;
    background:linear-gradient(180deg, rgba(77,255,167,1), rgba(0,184,92,1));
    box-shadow:0 0 0 4px rgba(0,184,92,.18);
  }

  .chip.warn .dot{
    background:linear-gradient(180deg, rgba(255,210,77,1), rgba(235,165,0,1));
    box-shadow:0 0 0 4px rgba(255,210,77,.18);
  }

  .grid{
    display:grid;
    grid-template-columns: 1fr 1fr;
    gap:16px;
  }
  @media (max-width: 980px){
    .grid{grid-template-columns:1fr}
  }

  .card{
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 16px;
    box-shadow: var(--shadow);
    backdrop-filter: blur(10px);
  }
  .cardHead{
    display:flex;
    align-items:flex-start;
    justify-content:space-between;
    gap:12px;
    margin-bottom:12px;
  }
  h2{
    margin:0;
    font-size:18px;
  }
  p{
    margin:6px 0 0;
    color: var(--muted);
    font-size:13px;
    line-height:1.35;
  }
  .formRow{
    display:grid;
    grid-template-columns: 1.2fr .9fr auto;
    gap:12px;
    align-items:end;
    margin-top:12px;
    margin-bottom:10px;
  }
  @media (max-width: 520px){
    .formRow{grid-template-columns:1fr}
  }

  .controls{
    display:grid;
    grid-template-columns: 1fr 1fr 1fr auto;
    gap:12px;
    align-items:end;
  }

  .starterField{
    grid-column: 1 / span 1;
  }

  .starterField select{
    width: 100%;
    min-width: 200px;
  }

  .rallyTime{
    grid-column: 1;
    display: flex;
  }

  .ttsRow{
    margin-top: 10px;
    display:flex;
    flex-wrap:wrap;
    gap:10px;
    align-items:center;
  }
  .ttsToggle{
    display:flex;
    align-items:center;
    gap:8px;
    padding:8px 10px;
    border-radius:12px;
    border:1px solid rgba(255,255,255,.12);
    background: rgba(0,0,0,.10);
    color: var(--muted);
    font-size:13px;
  }
  .ttsToggle input{
    width:16px;
    height:16px;
  }

  .localSettings{
    margin-top:10px;
    margin-bottom:8px;
    display:flex;
    gap:16px;
    flex-wrap:wrap;
  }
  .localSettingsCol{
    flex:1;
    min-width:200px;
  }
  .localLabel{
    display:block;
    font-size:12px;
    color:var(--muted2);
    margin-bottom:4px;
  }
  .localSettingsCol input[type="range"]{
    width:100%;
  }

  @media (max-width: 980px){
    .controls{ grid-template-columns:1fr; }
    .starterField{ grid-column: auto; }
    .starterField select{ min-width: 0; }
  }

  .field label{
    display:block;
    color: var(--muted2);
    font-size:12px;
    margin-bottom:6px;
  }
  input, select{
    color-scheme:dark;
    width:100%;
    border-radius: 12px;
    border: 1px solid rgba(255,255,255,.14);
    background: rgba(0,0,0,.18);
    color: var(--text);
    padding: 10px 12px;
    outline: none;
    box-shadow: inset 0 0 0 1px rgba(255,255,255,.04);
  }
  input:focus, select:focus{
    color-scheme:dark;
    border-color: rgba(140,170,255,.6);
    box-shadow: 0 0 0 4px rgba(120,160,255,.18);
  }

  .btn{
    border-radius: 12px;
    border: 1px solid rgba(255,255,255,.14);
    background: rgba(255,255,255,.07);
    color: var(--text);
    padding: 10px 12px;
    cursor:pointer;
    transition: transform .06s ease, background .15s ease, border-color .15s ease;
    white-space:nowrap;
  }
  .btn:hover{ background: rgba(255,255,255,.10); }
  .btn:active{ transform: translateY(1px); }
  .btn:disabled{
    opacity:.45; cursor:not-allowed;
  }
  .btn.primary{
    background: linear-gradient(180deg, rgba(120,160,255,.32), rgba(120,160,255,.18));
    border-color: rgba(140,170,255,.45);
  }
  .btn.primary:hover{
    background: linear-gradient(180deg, rgba(120,160,255,.40), rgba(120,160,255,.22));
  }
  .btn.ghost{
    background: transparent;
    border-color: rgba(255,255,255,.10);
    color: var(--muted);
  }

  .seg{
    display:flex;
    gap:8px;
    background: rgba(0,0,0,.14);
    border: 1px solid rgba(255,255,255,.12);
    padding: 6px;
    border-radius: 14px;
  }
  .segBtn{
    flex:1;
    border-radius: 10px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--muted);
    padding: 8px 10px;
    cursor:pointer;
  }
  .segBtn.active{
    background: rgba(255,255,255,.10);
    border-color: rgba(255,255,255,.14);
    color: var(--text);
  }

  .delayInput input{
    text-align:left;
  }

  .tableWrap{
    margin-top: 10px;
    border: 1px solid rgba(255,255,255,.10);
    border-radius: 14px;
    overflow:hidden;
    background: rgba(0,0,0,.10);
  }
  .table{
    width:100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  th, td{
    padding: 10px 12px;
    border-bottom: 1px solid rgba(255,255,255,.08);
    vertical-align: middle;
  }
  thead th{
    color: var(--muted2);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: .08em;
    font-size: 11px;
    background: rgba(255,255,255,.05);
  }
  tbody tr:hover td{
    background: rgba(255,255,255,.04);
  }
  tbody tr:last-child td{
    border-bottom: none;
  }
  .right{text-align:right}
  .strong{font-weight: 700}
  .mono{
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  }

  .empty{
    margin-top: 12px;
    padding: 14px;
    color: var(--muted);
    border: 1px dashed rgba(255,255,255,.18);
    border-radius: 14px;
    background: rgba(255,255,255,.04);
  }

  .metaRow{
    display:grid;
    grid-template-columns: 1fr 1fr 1fr 1fr;
    gap:10px;
    margin-top: 10px;
  }
  @media (max-width: 980px){
    .metaRow{grid-template-columns:1fr 1fr}
  }
  @media (max-width: 720px){
    .metaRow{grid-template-columns:1fr}
  }
  .meta{
    padding: 12px;
    border-radius: 14px;
    border: 1px solid rgba(255,255,255,.10);
    background: rgba(255,255,255,.04);
  }
  .metaLabel{
    font-size: 11px;
    color: var(--muted2);
    text-transform: uppercase;
    letter-spacing: .08em;
    margin-bottom: 6px;
  }
  .metaValue{
    font-size: 14px;
    font-weight: 700;
  }

  .badge{
    display:inline-flex;
    align-items:center;
    gap:8px;
    padding: 6px 10px;
    border-radius: 999px;
    font-weight: 700;
    font-size: 12px;
    border: 1px solid rgba(255,255,255,.12);
    background: rgba(255,255,255,.06);
    color: var(--text);
  }
  .badge.ok{
    background: rgba(77,255,167,.10);
    border-color: rgba(77,255,167,.22);
  }
  .badge.warn{
    background: rgba(255,210,77,.10);
    border-color: rgba(255,210,77,.22);
  }
  .badge.bad{
    background: rgba(255,92,92,.12);
    border-color: rgba(255,255,255,.22);
  }

  .footer{
    margin-top: 14px;
    color: var(--muted2);
    font-size: 12px;
  }
`;
