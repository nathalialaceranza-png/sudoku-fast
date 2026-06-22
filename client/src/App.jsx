import React, { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import confetti from "canvas-confetti";

const DIFFICULTIES = ["Easy", "Medium", "Hard", "Expert", "Master"];
const SERVER_URL = ``;
const SOCKET_URL = ``;

function peersOf(index) {
  const r = Math.floor(index / 9);
  const c = index % 9;
  const set = new Set();
  for (let i = 0; i < 9; i++) {
    set.add(r * 9 + i);
    set.add(i * 9 + c);
  }
  const br = Math.floor(r / 3) * 3;
  const bc = Math.floor(c / 3) * 3;
  for (let rr = br; rr < br + 3; rr++)
    for (let cc = bc; cc < bc + 3; cc++)
      set.add(rr * 9 + cc);
  set.delete(index);
  return [...set];
}

function cloneNotes(notes) {
  return notes.map(s => new Set(s));
}

function rowIndices(r) {
  return Array.from({ length: 9 }, (_, c) => r * 9 + c);
}

function colIndices(c) {
  return Array.from({ length: 9 }, (_, r) => r * 9 + c);
}

function boxIndices(box) {
  const br = Math.floor(box / 3) * 3;
  const bc = (box % 3) * 3;
  const out = [];
  for (let r = br; r < br + 3; r++)
    for (let c = bc; c < bc + 3; c++)
      out.push(r * 9 + c);
  return out;
}

function isGroupComplete(indices, board) {
  const vals = indices.map(i => board[i]);
  if (vals.some(v => v < 1 || v > 9)) return false;
  return new Set(vals).size === 9;
}

function cellRow(index) { return Math.floor(index / 9); }
function cellCol(index) { return index % 9; }
function cellBox(index) { return Math.floor(cellRow(index) / 3) * 3 + Math.floor(cellCol(index) / 3); }
function manhattan(a, b) { return Math.abs(cellRow(a) - cellRow(b)) + Math.abs(cellCol(a) - cellCol(b)); }

function formatTime(ms) {
  if (!ms && ms !== 0) return "—";
  const total = Math.floor(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function randomId() {
  try { return crypto.randomUUID(); } catch { return `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
}
function getPlayerId() {
  let id = localStorage.getItem("sf_player_id");
  if (!id) { id = randomId(); localStorage.setItem("sf_player_id", id); }
  return id;
}

function getPlayerName() {
  return localStorage.getItem("sf_player_name") || "";
}

function setPlayerName(name) {
  localStorage.setItem("sf_player_name", name);
}

export default function App() {
  const [tab, setTab] = useState("practice");
  const [playerName, setPlayerNameState] = useState(() => getPlayerName());
  const [playerId] = useState(() => getPlayerId());
  const [nameInput, setNameInput] = useState(playerName || "");
  const [showNamePrompt, setShowNamePrompt] = useState(!playerName);
  const [practiceStats, setPracticeStats] = useState({});
  const [competeStats, setCompeteStats] = useState({});
  const [difficulty, setDifficulty] = useState("Medium");
  const isAdmin = useMemo(() => new URLSearchParams(window.location.search).has("admin"), []);

  useEffect(() => {
    fetch(`${SERVER_URL}/stats/${playerId}`).then(r => r.json()).then(d => {
      setPracticeStats(d.practice || {});
      setCompeteStats(d.compete || {});
    }).catch(() => {});
  }, [playerId]);

  const handleSaveName = () => {
    const n = nameInput.trim() || "Player";
    setPlayerName(n);
    setPlayerNameState(n);
    setShowNamePrompt(false);
  };

  if (showNamePrompt) {
    return (
      <div style={s.page}>
        <div style={{ ...s.card, maxWidth: 400, margin: "40px auto", textAlign: "center" }}>
          <div style={{ fontSize: 28, fontWeight: 900, marginBottom: 12 }}>Sudoku Fast</div>
          <div style={{ marginBottom: 16, color: "rgba(232,239,255,0.7)" }}>What's your name?</div>
          <input value={nameInput} onChange={e => setNameInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleSaveName()}
            style={s.nameInput} placeholder="Your name" autoFocus />
          <button style={s.primaryBtn} onClick={handleSaveName}>Start</button>
        </div>
      </div>
    );
  }

  return (
    <div style={s.page}>
      {tab === "practice" ? (
        <PracticeView playerId={playerId} practiceStats={practiceStats}
          difficulty={difficulty} onDifficultyChange={setDifficulty}
          onStatsUpdate={s => setPracticeStats(s)}
          tab={tab} onTabChange={setTab}
          isAdmin={isAdmin} />
      ) : tab === "compete" ? (
        <CompeteView playerId={playerId} playerName={playerName}
          competeStats={competeStats} onStatsUpdate={s => setCompeteStats(s)}
          tab={tab} onTabChange={setTab} />
      ) : (
        <MetricsView onTabChange={setTab} />
      )}
      <footer style={{ fontSize: 12, color: "rgba(232,239,255,0.35)", textAlign: "center", marginTop: 24, paddingBottom: 16 }}>
        Sudoku Fast — built for one-handed speed. Practice, compete in real-time PvP, or challenge the adaptive CPU.
      </footer>
    </div>
  );
}

function PracticeView({ playerId, practiceStats, onStatsUpdate, difficulty, onDifficultyChange, tab, onTabChange, isAdmin }) {
  const [board, setBoard] = useState(Array(81).fill(0));
  const [given, setGiven] = useState(new Set());
  const [solution, setSolution] = useState(null);
  const [notes, setNotes] = useState(() => Array.from({ length: 81 }, () => new Set()));
  const [selectedNumber, setSelectedNumber] = useState(null);
  const [locked, setLocked] = useState(false);
  const [noteMode, setNoteMode] = useState(false);
  const [eraseArmed, setEraseArmed] = useState(false);
  const [startMs, setStartMs] = useState(null);
  const [stopMs, setStopMs] = useState(null);
  const [nowMs, setNowMs] = useState(Date.now());
  const [showWinModal, setShowWinModal] = useState(false);
  const [errorFlash, setErrorFlash] = useState(null);
  const [errorCount, setErrorCount] = useState(0);
  const [freezeUntilMs, setFreezeUntilMs] = useState(0);
  const [noteConflictFlash, setNoteConflictFlash] = useState(null);
  const [completedFlash, setCompletedFlash] = useState({ rows: [], cols: [], boxes: [], untilMs: 0, originIndex: null });
  const [leaveTarget, setLeaveTarget] = useState(null);
  const [hasInteracted, setHasInteracted] = useState(false);

  const undoRef = useRef([]);
  const longPressRef = useRef(null);
  const longPressFiredRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const dragVisitedRef = useRef(new Set());
  const gridRef = useRef(null);
  const confettiCanvasRef = useRef(null);
  const leaveSessionRef = useRef(null);

  const LOCK_PRESS_MS = 180;
  const COMPLETE_FLASH_MS = 520;

  const elapsedMs = useMemo(() => {
    if (!startMs) return 0;
    return Math.max(0, (stopMs ?? nowMs) - startMs);
  }, [startMs, stopMs, nowMs]);

  const usedCount = useMemo(() => {
    const c = Array(10).fill(0);
    for (const v of board) { if (v >= 1 && v <= 9) c[v]++; }
    return c;
  }, [board]);

  const remainingOf = (n) => Math.max(0, 9 - usedCount[n]);
  const isFrozen = freezeUntilMs > nowMs;
  const freezeRemaining = isFrozen ? Math.ceil((freezeUntilMs - nowMs) / 1000) : 0;

  useEffect(() => {
    let raf;
    const tick = () => { setNowMs(Date.now()); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const stop = () => { setDragging(false); dragVisitedRef.current = new Set(); };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, []);

  useEffect(() => {
    if (selectedNumber == null) return;
    if (remainingOf(selectedNumber) === 0) {
      setSelectedNumber(null);
      try { if (navigator?.vibrate) navigator.vibrate([15]); } catch (_) {}
    }
  }, [usedCount, selectedNumber]);

  useEffect(() => {
    const onKey = (e) => {
      if (showWinModal) return;
      if (e.key >= "1" && e.key <= "9") {
        const n = Number(e.key);
        if (remainingOf(n) === 0) return;
        setSelectedNumber(n); setEraseArmed(false); return;
      }
      if (e.key === "Backspace" || e.key === "Delete") { setEraseArmed(true); setSelectedNumber(null); return; }
      if (e.key.toLowerCase() === "n") setNoteMode(v => !v);
      if (e.key.toLowerCase() === "l") setLocked(v => !v);
      if (e.key.toLowerCase() === "u") handleUndo();
      if (e.key === "Escape") { setSelectedNumber(null); setEraseArmed(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [usedCount, showWinModal, noteMode]);

  const newGame = async (diff) => {
    setHasInteracted(false);
    setStartMs(null);
    setStopMs(null);
    setShowWinModal(false);
    setSelectedNumber(null);
    setLocked(false);
    setNoteMode(false);
    setEraseArmed(false);
    setErrorFlash(null);
    setCompletedFlash({ rows: [], cols: [], boxes: [], untilMs: 0, originIndex: null });
    setErrorCount(0);
    setFreezeUntilMs(0);
    undoRef.current = [];

    const res = await fetch(`${SERVER_URL}/puzzle?difficulty=${encodeURIComponent(diff)}`);
    const data = await res.json();
    const g = new Set();
    const b = data.puzzle.map((v, i) => { if (v !== 0) g.add(i); return v; });
    setGiven(g);
    setBoard(b);
    setSolution(data.solution);
    setNotes(Array.from({ length: 81 }, () => new Set()));
    setStartMs(Date.now());
  };

  useEffect(() => { newGame(difficulty); }, [difficulty]);

  const pushUndo = (prevBoard, prevNotes) => {
    undoRef.current.push({ prevBoard, prevNotes });
    if (undoRef.current.length > 300) undoRef.current.shift();
  };

  const bestMs = practiceStats?.[difficulty] || null;
  const isNewRecord = bestMs === null || (stopMs !== null && stopMs - startMs <= bestMs);

  useEffect(() => {
    if (showWinModal && isNewRecord && confettiCanvasRef.current) {
      const myConfetti = confetti.create(confettiCanvasRef.current, { resize: true });
      myConfetti({ particleCount: 120, spread: 100, origin: { y: 0.6 }, colors: ["#4da3ff", "#40d39c", "#ffd700"] });
    }
  }, [showWinModal, isNewRecord]);

  const handleUndo = () => {
    const last = undoRef.current.pop();
    if (!last || showWinModal) return;
    setBoard(last.prevBoard);
    setNotes(last.prevNotes);
    setErrorFlash(null);
    setCompletedFlash({ rows: [], cols: [], boxes: [], untilMs: 0, originIndex: null });
    setStopMs(null);
    setShowWinModal(false);
  };

  const startTimerIfNeeded = () => { if (!startMs) setStartMs(Date.now()); };

  const pickNumber = (n, { lock = false, toggleUnlockIfActive = true } = {}) => {
    if (remainingOf(n) === 0) return;
    if (toggleUnlockIfActive && locked && selectedNumber === n && !lock) { setLocked(false); setSelectedNumber(n); setEraseArmed(false); return; }
    setSelectedNumber(n); setEraseArmed(false);
    if (lock) setLocked(true);
  };

  const onNumberPointerDown = (n) => {
    if (remainingOf(n) === 0 || showWinModal) return;
    setHasInteracted(true);
    longPressFiredRef.current = false;
    longPressRef.current = setTimeout(() => { longPressFiredRef.current = true; pickNumber(n, { lock: true, toggleUnlockIfActive: false }); }, LOCK_PRESS_MS);
  };

  const onNumberPointerUp = (n) => {
    if (remainingOf(n) === 0 || showWinModal) return;
    if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = null; }
    if (longPressFiredRef.current) return;
    pickNumber(n, { lock: false, toggleUnlockIfActive: true });
  };

  const getConflictIndices = (index, value) => {
    if (value === 0) return [];
    const conflict = [];
    for (const pi of peersOf(index)) { if (board[pi] === value) conflict.push(pi); }
    return conflict;
  };

  const triggerErrorFeedback = (index, value, conflictIndices = []) => {
    try { if (navigator?.vibrate) navigator.vibrate([25, 30, 25]); } catch (_) {}
    setErrorFlash({ index, value, untilMs: Date.now() + 260, conflictIndices });
  };

  const removeCandidateFromPeers = (index, value, notesDraft) => {
    if (value === 0) return;
    for (const pi of peersOf(index)) notesDraft[pi].delete(value);
  };

  const addNoteCandidate = (index, n) => {
    if (given.has(index) || board[index] !== 0 || showWinModal || isFrozen) return;
    const prevBoard = board.slice();
    const prevNotes = cloneNotes(notes);
    const nextNotes = cloneNotes(notes);
    if (nextNotes[index].has(n)) { nextNotes[index].delete(n); }
    else {
      for (const pi of peersOf(index)) { if (board[pi] === n) { setNoteConflictFlash({ index: pi, untilMs: Date.now() + 300 }); return; } }
      nextNotes[index].add(n);
    }
    pushUndo(prevBoard, prevNotes);
    setNotes(nextNotes);
  };

  const toggleNote = (index, n) => {
    if (given.has(index) || board[index] !== 0 || showWinModal || isFrozen) return;
    setHasInteracted(true);
    startTimerIfNeeded();
    const prevBoard = board.slice();
    const prevNotes = cloneNotes(notes);
    const nextNotes = cloneNotes(notes);
    if (nextNotes[index].has(n)) { nextNotes[index].delete(n); }
    else {
      for (const pi of peersOf(index)) { if (board[pi] === n) { setNoteConflictFlash({ index: pi, untilMs: Date.now() + 300 }); return; } }
      nextNotes[index].add(n);
    }
    pushUndo(prevBoard, prevNotes);
    setNotes(nextNotes);
    if (!locked) setSelectedNumber(null);
  };

  const detectNewCompletions = (prevBoard, nextBoard, changedIndex) => {
    const r = cellRow(changedIndex), c = cellCol(changedIndex), b = cellBox(changedIndex);
    const newRows = [], newCols = [], newBoxes = [];
    if (!isGroupComplete(rowIndices(r), prevBoard) && isGroupComplete(rowIndices(r), nextBoard)) newRows.push(r);
    if (!isGroupComplete(colIndices(c), prevBoard) && isGroupComplete(colIndices(c), nextBoard)) newCols.push(c);
    if (!isGroupComplete(boxIndices(b), prevBoard) && isGroupComplete(boxIndices(b), nextBoard)) newBoxes.push(b);
    if (newRows.length || newCols.length || newBoxes.length) setCompletedFlash({ rows: newRows, cols: newCols, boxes: newBoxes, untilMs: Date.now() + COMPLETE_FLASH_MS, originIndex: changedIndex });
  };

  function boardSolved(board, solution) {
    if (!solution || solution.length !== 81) return false;
    for (let i = 0; i < 81; i++) {
      if (board[i] !== solution[i]) return false;
    }
    return true;
  }

  const placeValue = (index, value) => {
    if (showWinModal || isFrozen) return;
    if (given.has(index)) return;
    setHasInteracted(true);
    startTimerIfNeeded();
    if (board[index] === value) { if (!locked) setSelectedNumber(null); return; }
    const conflictIndices = getConflictIndices(index, value);
    if (conflictIndices.length > 0) {
      triggerErrorFeedback(index, value, conflictIndices);
      const nextCount = errorCount + 1; setErrorCount(nextCount); setFreezeUntilMs(Date.now() + 4000 + nextCount * 1000);
      return;
    }
    if (solution && solution[index] !== value) {
      triggerErrorFeedback(index, value, []);
      const nextCount = errorCount + 1; setErrorCount(nextCount); setFreezeUntilMs(Date.now() + 4000 + nextCount * 1000);
      return;
    }
    const prevBoard = board.slice();
    const prevNotes = cloneNotes(notes);
    const nextBoard = board.slice();
    nextBoard[index] = value;
    const nextNotes = cloneNotes(notes);
    nextNotes[index].clear();
    removeCandidateFromPeers(index, value, nextNotes);
    pushUndo(prevBoard, prevNotes);
    setBoard(nextBoard);
    setNotes(nextNotes);
    detectNewCompletions(prevBoard, nextBoard, index);
    if (boardSolved(nextBoard, solution)) {
      const end = Date.now();
      setStopMs(end);
      setShowWinModal(true);
      try { if (navigator?.vibrate) navigator.vibrate([40, 50, 40, 50, 80]); } catch (_) {}
      fetch(`${SERVER_URL}/stats/practice`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playerId, difficulty, elapsedMs: end - startMs })
      }).then(r => r.json()).then(d => {
        if (d.bestMs) onStatsUpdate(prev => ({ ...prev, [difficulty]: d.bestMs }));
      }).catch(() => {});
    }
    if (!locked) setSelectedNumber(null);
  };

  const eraseOneShot = (index) => {
    if (given.has(index) || showWinModal || isFrozen) return;
    setHasInteracted(true);
    startTimerIfNeeded();
    const prevBoard = board.slice();
    const prevNotes = cloneNotes(notes);
    const nextBoard = board.slice();
    const nextNotes = cloneNotes(notes);
    if (nextBoard[index] !== 0) { nextBoard[index] = 0; }
    else if (nextNotes[index].size > 0) { nextNotes[index].clear(); }
    else { setEraseArmed(false); return; }
    pushUndo(prevBoard, prevNotes);
    setBoard(nextBoard);
    setNotes(nextNotes);
    setEraseArmed(false);
    setErrorFlash(null);
    setCompletedFlash({ rows: [], cols: [], boxes: [], untilMs: 0, originIndex: null });
    setStopMs(null);
    setShowWinModal(false);
  };

  const canSwipeNotes = () => noteMode && locked && selectedNumber != null;
  const canSwipeValues = () => !noteMode && locked && selectedNumber != null && !eraseArmed;

  const applySwipeOnCell = (i) => {
    if (showWinModal || isFrozen) return;
    if (dragVisitedRef.current.has(i)) return;
    dragVisitedRef.current.add(i);
    if (canSwipeNotes()) {
      if (given.has(i) || board[i] !== 0) {
        if (board[i] === selectedNumber) {
          setNotes(prev => { const next = cloneNotes(prev); removeCandidateFromPeers(i, selectedNumber, next); return next; });
        }
        return;
      }
      addNoteCandidate(i, selectedNumber);
      return;
    }
    if (canSwipeValues()) {
      if (given.has(i)) return;
      placeValue(i, selectedNumber);
    }
  };

  const onCellPointerDown = (i, e) => {
    if (showWinModal) return;
    if (canSwipeNotes() || canSwipeValues()) {
      setDragging(true); dragVisitedRef.current = new Set(); applySwipeOnCell(i);
      if (gridRef.current) gridRef.current.setPointerCapture(e.pointerId);
      return;
    }
    onCellTap(i);
  };

  const onGridPointerMove = (e) => {
    if (!dragging) return;
    if (!(canSwipeNotes() || canSwipeValues())) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || !el.dataset || el.dataset.cellIndex === undefined) return;
    applySwipeOnCell(parseInt(el.dataset.cellIndex, 10));
  };

  const onCellTap = (i) => {
    if (showWinModal || isFrozen) return;
    if (eraseArmed) { eraseOneShot(i); return; }
    if (selectedNumber == null) return;
    if (noteMode) {
      if (given.has(i) || board[i] !== 0) {
        if (board[i] === selectedNumber) {
          setNotes(prev => { const next = cloneNotes(prev); removeCandidateFromPeers(i, selectedNumber, next); return next; });
        }
        return;
      }
      toggleNote(i, selectedNumber);
    } else { placeValue(i, selectedNumber); }
  };

  const completedWaveProgress = completedFlash.untilMs > nowMs
    ? 1 - (completedFlash.untilMs - nowMs) / COMPLETE_FLASH_MS : 1;

  const confirmLeave = (targetTab) => {
    if (startMs != null && !showWinModal && hasInteracted) {
      if (!leaveSessionRef.current) leaveSessionRef.current = { noClicks: 0, tabClicks: 0 };
      leaveSessionRef.current.tabClicks++;
      setLeaveTarget(targetTab);
    } else {
      onTabChange(targetTab);
    }
  };

  return (
    <div>
      <div style={s.tabArea}>
        <div style={s.tabRow}>
          <button style={{ ...s.tabBtnActive, marginRight: -1 }}>Practice</button>
          {isAdmin && <button style={{ ...s.tabBtn, marginLeft: -1, marginRight: -1 }} onClick={() => onTabChange("metrics")}>Metrics</button>}
          <button style={{ ...s.tabBtn, marginLeft: -1 }} onClick={() => confirmLeave("compete")}>Compete</button>
        </div>
        <div style={s.headerContent}>
          <div style={s.row}>
            <div>
              <div style={s.sub}>
                Difficulty:&nbsp;
                <select value={difficulty} onChange={e => onDifficultyChange(e.target.value)} style={s.select}>
                  {DIFFICULTIES.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
                <button style={s.btn} onClick={() => newGame(difficulty)}>New game</button>
              </div>
            </div>
            <div style={s.timer}>⏱ {formatTime(elapsedMs)}</div>
          </div>
          <div style={s.statRow}>
            Best: <strong>{bestMs ? formatTime(bestMs) : "—"}</strong>
          </div>
        </div>
      </div>

      <div style={s.card}>
        <div ref={gridRef} style={s.grid} onPointerMove={onGridPointerMove}>
          {Array.from({ length: 81 }, (_, i) => {
            const v = board[i];
            const isGiven = given.has(i);
            const cellNotes = notes[i];
            const thickR = i % 9 === 2 || i % 9 === 5 ? "2px solid rgba(255,255,255,0.18)" : "1px solid rgba(255,255,255,0.10)";
            const thickB = Math.floor(i / 9) === 2 || Math.floor(i / 9) === 5 ? "2px solid rgba(255,255,255,0.18)" : "1px solid rgba(255,255,255,0.10)";
            const isError = errorFlash && errorFlash.index === i && nowMs <= errorFlash.untilMs;
            const isConflictCell = errorFlash && errorFlash.conflictIndices?.includes(i) && nowMs <= errorFlash.untilMs;
            const errorOpacity = isError ? Math.max(0, (errorFlash.untilMs - nowMs) / 260) : 0;
            const r = cellRow(i), c = cellCol(i), b = cellBox(i);
            const inCompletedWave = completedFlash.untilMs > nowMs && (completedFlash.rows.includes(r) || completedFlash.cols.includes(c) || completedFlash.boxes.includes(b));
            let waveOpacity = 0;
            if (inCompletedWave && completedFlash.originIndex != null) {
              const distance = manhattan(i, completedFlash.originIndex);
              const waveFront = completedWaveProgress * 5.5;
              waveOpacity = Math.max(0, 1 - Math.abs(waveFront - distance) / 1.15) * 0.9;
            }
            const isNoteConflict = noteConflictFlash && noteConflictFlash.index === i && nowMs <= noteConflictFlash.untilMs;
            const noteConflictOpacity = isNoteConflict ? Math.max(0, (noteConflictFlash.untilMs - nowMs) / 300) : 0;
            const isSelectedMatch = selectedNumber != null && v === selectedNumber;

            return (
              <div key={i} onPointerDown={(e) => onCellPointerDown(i, e)} data-cell-index={i}
                style={{ ...s.cell, borderRight: thickR, borderBottom: thickB,
                  background: isConflictCell ? "rgba(255,77,109,0.20)"
                    : isSelectedMatch ? "rgba(30, 65, 130, 0.58)"
                    : isGiven ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.02)",
                  color: isGiven ? "#fff" : "#d9e6ff", fontWeight: isGiven ? 900 : 700 }}
              >
                {inCompletedWave && waveOpacity > 0 && (<div style={{ ...s.completedWave, opacity: waveOpacity }} />)}
                {isNoteConflict && (<div style={{ ...s.noteConflictOverlay, opacity: noteConflictOpacity }} />)}
                {isError ? (<div style={{ ...s.errorOverlay, opacity: errorOpacity, transform: `scale(${1 + (1 - errorOpacity) * 0.08})` }}>{errorFlash.value}</div>)
                : v !== 0 ? v
                : cellNotes.size > 0 ? (<div style={s.notes}>{Array.from({ length: 9 }, (_, k) => { const n = k + 1; return <div key={n} style={s.noteItem}>{cellNotes.has(n) ? n : ""}</div>; })}</div>)
                : ""}
              </div>
            );
          })}
          {isFrozen && (<div style={s.freezeOverlay}><div style={s.freezeCountdown}>🧊 {freezeRemaining}s</div></div>)}
        </div>

        <div style={s.actionBar}>
          <button type="button" style={s.actionBtn} onClick={handleUndo}><div style={s.actionIcon}>↶</div><div style={s.actionLabel}>Undo</div></button>
          <button type="button" style={{ ...s.actionBtn, ...(eraseArmed ? s.actionBtnActiveDanger : null) }} onClick={() => { setEraseArmed(true); setSelectedNumber(null); setHasInteracted(true); }}><div style={s.actionIcon}>⌫</div><div style={s.actionLabel}>Erase</div></button>
          <button type="button" style={{ ...s.actionBtn, ...(noteMode ? s.actionBtnActive : null) }} onClick={() => { setHasInteracted(true); setNoteMode(v => !v); }}>
            <div style={s.actionIconWrap}><div style={s.actionIcon}>✎</div><div style={s.miniPill}>{noteMode ? "ON" : "OFF"}</div></div>
            <div style={s.actionLabel}>Notes</div>
          </button>
        </div>

        <div style={s.numberRow}>
          {Array.from({ length: 9 }, (_, idx) => {
            const n = idx + 1;
            const disabled = remainingOf(n) === 0;
            const isActive = selectedNumber === n;
            const lockVisualOn = locked && selectedNumber != null;
            const isFaded = lockVisualOn && !isActive;
            return (
              <button key={n} type="button" disabled={disabled}
                onPointerDown={() => onNumberPointerDown(n)} onPointerUp={() => onNumberPointerUp(n)}
                onPointerCancel={() => { if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = null; } }}
                onContextMenu={(e) => e.preventDefault()}
                style={{ ...s.numberBtn, opacity: disabled ? 0.15 : isFaded ? 0.35 : 1, background: isActive ? "rgba(47,127,255,0.20)" : "transparent", pointerEvents: disabled ? "none" : "auto" }}
              >
                {locked && isActive && <span style={s.lockDot} />}
                <span>{n}</span>
              </button>
            );
          })}
        </div>
      </div>

      {showWinModal && (
        <>
          <canvas ref={confettiCanvasRef} style={{
            position: "fixed", inset: 0, pointerEvents: "none",
            zIndex: 10001, width: "100%", height: "100%"
          }} />
          <div style={s.modalBackdrop}>
            <div style={s.modalCard}>
              <div style={s.trophy}>🏆</div>
              <div style={s.modalTitle}>{isNewRecord ? "New record!" : "Good job!"}</div>
              <div style={s.modalText}>Your time was {formatTime(elapsedMs)}!</div>
              {isNewRecord && <div style={s.modalSub}>Personal best</div>}
              <button type="button" style={s.primaryBtn} onClick={() => newGame(difficulty)}>Play again</button>
            </div>
          </div>
        </>
      )}
      {leaveTarget && (
        <div style={s.modalBackdrop}>
          <div style={s.modalCard}>
            <div style={s.modalTitle}>Leaving a game in progress</div>
            <div style={s.modalText}>Are you sure?</div>
            <div style={s.leaveRow}>
              <button type="button" style={s.leaveBtnYes} onClick={() => {
                const s = leaveSessionRef.current;
                fetch("/analytics/leave", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "yes", view: "practice", elapsedMs, difficulty, noClicksAntes: s?.noClicks || 0, tabClicksAntes: s?.tabClicks || 0 }) }).catch(() => {});
                onTabChange(leaveTarget); setLeaveTarget(null);
              }}>YES</button>
              <button type="button" style={s.leaveBtnNo} onClick={() => {
                if (leaveSessionRef.current) leaveSessionRef.current.noClicks++;
                fetch("/analytics/leave", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "no", view: "practice", elapsedMs, difficulty, noClicksAntes: leaveSessionRef.current?.noClicks || 0, tabClicksAntes: leaveSessionRef.current?.tabClicks || 0 }) }).catch(() => {});
                setLeaveTarget(null);
              }}>NO!</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CompeteView({ playerId, playerName, competeStats, onStatsUpdate, tab, onTabChange }) {
  const [phase, setPhase] = useState("lobby");
  const [onlineCount, setOnlineCount] = useState(0);
  const [socket, setSocket] = useState(null);
  const [matchData, setMatchData] = useState(null);
  const [opponentName, setOpponentName] = useState("");
  const [board, setBoard] = useState(Array(81).fill(0));
  const [given, setGiven] = useState(new Set());
  const [notes, setNotes] = useState(() => Array.from({ length: 81 }, () => new Set()));
  const [selectedNumber, setSelectedNumber] = useState(null);
  const [locked, setLocked] = useState(false);
  const [noteMode, setNoteMode] = useState(false);
  const [eraseArmed, setEraseArmed] = useState(false);
  const [startMs, setStartMs] = useState(null);
  const [stopMs, setStopMs] = useState(null);
  const [nowMs, setNowMs] = useState(Date.now());
  const [countdownSec, setCountdownSec] = useState(0);
  const [duelResult, setDuelResult] = useState(null);
  const [showResult, setShowResult] = useState(false);
  const [errorFlash, setErrorFlash] = useState(null);
  const [errorCount, setErrorCount] = useState(0);
  const [freezeUntilMs, setFreezeUntilMs] = useState(0);
  const [noteConflictFlash, setNoteConflictFlash] = useState(null);
  const [completedFlash, setCompletedFlash] = useState({ rows: [], cols: [], boxes: [], untilMs: 0, originIndex: null });
  const [leaveTarget, setLeaveTarget] = useState(null);
  const [playerSide, setPlayerSide] = useState(1);
  const [duelSolution, setDuelSolution] = useState(null);
  const [queueCounts, setQueueCounts] = useState({ Easy: 0, Medium: 0, Hard: 0, Expert: 0, Master: 0 });
  const [searchDiff, setSearchDiff] = useState(null);
  const [opponentIsBot, setOpponentIsBot] = useState(false);
  const [showCpuOption, setShowCpuOption] = useState(false);
  const COMPETE_LABELS = ["Compete in Easy", "Compete in Medium", "Compete in Hard", "Compete in Expert", "Compete in Master"];
  const UNLOCK_REQS = ["", "3 wins in Easy", "3 wins in Medium", "3 wins in Hard", "3 wins in Expert"];

  const unlockedLevel = useMemo(() => {
    if (!competeStats) return 0;
    if ((competeStats.Expert?.wins || 0) >= 3) return 4;
    if ((competeStats.Hard?.wins || 0) >= 3) return 3;
    if ((competeStats.Medium?.wins || 0) >= 3) return 2;
    if ((competeStats.Easy?.wins || 0) >= 3) return 1;
    return 0;
  }, [competeStats]);

  const undoRef = useRef([]);
  const longPressRef = useRef(null);
  const longPressFiredRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const dragVisitedRef = useRef(new Set());
  const gridRef = useRef(null);
  const socketRef = useRef(null);
  const confettiCanvasRef = useRef(null);
  const boardRef = useRef(board);
  const leaveSessionRef = useRef(null);

  const LOCK_PRESS_MS = 180;
  const COMPLETE_FLASH_MS = 520;

  const elapsedMs = useMemo(() => {
    if (!startMs) return 0;
    return Math.max(0, (stopMs ?? nowMs) - startMs);
  }, [startMs, stopMs, nowMs]);

  const usedCount = useMemo(() => {
    const c = Array(10).fill(0);
    for (const v of board) { if (v >= 1 && v <= 9) c[v]++; }
    return c;
  }, [board]);

  const remainingOf = (n) => Math.max(0, 9 - usedCount[n]);
  const isFrozen = freezeUntilMs > nowMs;
  const freezeRemaining = isFrozen ? Math.ceil((freezeUntilMs - nowMs) / 1000) : 0;

  useEffect(() => {
    const s = io(SOCKET_URL);
    socketRef.current = s;
    setSocket(s);

    s.on("lobby:count", setOnlineCount);
    s.on("queue:counts", setQueueCounts);
    s.on("matchmaking:unlocked", ({ level }) => setUnlockedLevel(level));
    s.on("matchmaking:rejected", () => { setPhase("lobby"); setSearchDiff(null); });
    s.on("matchmaking:queued", () => {});
    s.on("matchmaking:cancelled", () => { setPhase("lobby"); setSearchDiff(null); });
    s.on("matchmaking:found", (data) => {
      setSearchDiff(null);
      setShowCpuOption(false);
      setOpponentIsBot(!!data.opponentIsBot);
      setMatchData(data);
      setOpponentName(data.opponentName);
      setPlayerSide(data.playerSide);
      const g = new Set();
      const b = data.puzzle.map((v, i) => { if (v !== 0) g.add(i); return v; });
      setGiven(g);
      setBoard(b);
      if (data.solution) setDuelSolution(data.solution);
      setNotes(Array.from({ length: 81 }, () => new Set()));
      setSelectedNumber(null);
      setLocked(false);
      setNoteMode(false);
      setEraseArmed(false);
      setErrorFlash(null);
      setErrorCount(0);
      setFreezeUntilMs(0);
      setCompletedFlash({ rows: [], cols: [], boxes: [], untilMs: 0, originIndex: null });
      undoRef.current = [];
      setShowResult(false);
      setStopMs(null);
      setDuelResult(null);
      setPhase("countdown");
    });
    s.on("duel:start", ({ startAtMs }) => {
      const iv = setInterval(() => {
        const remaining = Math.max(0, Math.ceil((startAtMs - Date.now()) / 1000));
        setCountdownSec(remaining);
        if (remaining <= 0) {
          clearInterval(iv);
          setStartMs(startAtMs);
          setPhase("duel");
        }
      }, 100);
    });
    s.on("duel:finishRejected", () => {});
    s.on("duel:result", (data) => {
      setDuelResult(data);
      setStopMs(Date.now());
      setTimeout(() => setShowResult(true), 500);
      if (!data.won && data.bot && boardRef.current) {
        s.emit("duel:boardForStats", { board: boardRef.current });
      }
      fetch(`${SERVER_URL}/stats/${playerId}`).then(r => r.json()).then(d => {
        onStatsUpdate(d.compete || {});
      }).catch(() => {});
    });
    s.on("duel:opponentDisconnected", () => {
      setDuelResult({ won: true, myTime: null, opponentTime: null, winnerName: playerName, opponentName: "Opponent", disconnected: true });
      setStopMs(Date.now());
      setTimeout(() => setShowResult(true), 500);
    });
    s.on("duel:youWereDisconnected", (data) => {
      setDuelResult(data);
      setStopMs(Date.now());
      setTimeout(() => setShowResult(true), 500);
    });

    s.emit("lobby:enter", { playerId, playerName });

    return () => { s.emit("lobby:leave"); s.disconnect(); };
  }, [playerId, playerName]);

  useEffect(() => {
    const iv = setInterval(() => {
      if (socketRef.current?.connected) socketRef.current.emit("presence:heartbeat");
    }, 5000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    if (showResult && duelResult?.won && !duelResult?.disconnected && confettiCanvasRef.current) {
      const myConfetti = confetti.create(confettiCanvasRef.current, { resize: true });
      myConfetti({ particleCount: 120, spread: 100, origin: { y: 0.6 }, colors: ["#4da3ff", "#40d39c", "#ffd700"] });
    }
  }, [showResult, duelResult]);

  // Show Play vs CPU option after 5s of searching
  useEffect(() => {
    if (phase !== "searching") { setShowCpuOption(false); return; }
    const t = setTimeout(() => setShowCpuOption(true), 5000);
    return () => clearTimeout(t);
  }, [phase, searchDiff]);

  useEffect(() => { boardRef.current = board; }, [board]);

  useEffect(() => {
    let raf;
    const tick = () => { setNowMs(Date.now()); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const stop = () => { setDragging(false); dragVisitedRef.current = new Set(); };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, []);

  useEffect(() => {
    if (selectedNumber == null) return;
    if (remainingOf(selectedNumber) === 0) {
      setSelectedNumber(null);
      try { if (navigator?.vibrate) navigator.vibrate([15]); } catch (_) {}
    }
  }, [usedCount, selectedNumber]);

  useEffect(() => {
    const onKey = (e) => {
      if (showResult || phase !== "duel") return;
      if (e.key >= "1" && e.key <= "9") {
        const n = Number(e.key);
        if (remainingOf(n) === 0) return;
        setSelectedNumber(n); setEraseArmed(false); return;
      }
      if (e.key === "Backspace" || e.key === "Delete") { setEraseArmed(true); setSelectedNumber(null); return; }
      if (e.key.toLowerCase() === "n") setNoteMode(v => !v);
      if (e.key.toLowerCase() === "l") setLocked(v => !v);
      if (e.key.toLowerCase() === "u") handleUndo();
      if (e.key === "Escape") { setSelectedNumber(null); setEraseArmed(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [usedCount, showResult, noteMode, phase]);

  const pushUndo = (prevBoard, prevNotes) => {
    undoRef.current.push({ prevBoard, prevNotes });
    if (undoRef.current.length > 300) undoRef.current.shift();
  };

  const handleUndo = () => {
    const last = undoRef.current.pop();
    if (!last || showResult || phase !== "duel") return;
    setBoard(last.prevBoard);
    setNotes(last.prevNotes);
    setErrorFlash(null);
    setCompletedFlash({ rows: [], cols: [], boxes: [], untilMs: 0, originIndex: null });
  };

  const pickNumber = (n, { lock = false, toggleUnlockIfActive = true } = {}) => {
    if (remainingOf(n) === 0) return;
    if (toggleUnlockIfActive && locked && selectedNumber === n && !lock) { setLocked(false); setSelectedNumber(n); setEraseArmed(false); return; }
    setSelectedNumber(n); setEraseArmed(false);
    if (lock) setLocked(true);
  };

  const onNumberPointerDown = (n) => {
    if (remainingOf(n) === 0 || showResult || phase !== "duel") return;
    longPressFiredRef.current = false;
    longPressRef.current = setTimeout(() => { longPressFiredRef.current = true; pickNumber(n, { lock: true, toggleUnlockIfActive: false }); }, LOCK_PRESS_MS);
  };

  const onNumberPointerUp = (n) => {
    if (remainingOf(n) === 0 || showResult || phase !== "duel") return;
    if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = null; }
    if (longPressFiredRef.current) return;
    pickNumber(n, { lock: false, toggleUnlockIfActive: true });
  };

  const getConflictIndices = (index, value) => {
    if (value === 0) return [];
    const conflict = [];
    for (const pi of peersOf(index)) { if (board[pi] === value) conflict.push(pi); }
    return conflict;
  };

  const triggerErrorFeedback = (index, value, conflictIndices = []) => {
    try { if (navigator?.vibrate) navigator.vibrate([25, 30, 25]); } catch (_) {}
    setErrorFlash({ index, value, untilMs: Date.now() + 260, conflictIndices });
  };

  const removeCandidateFromPeers = (index, value, notesDraft) => {
    if (value === 0) return;
    for (const pi of peersOf(index)) notesDraft[pi].delete(value);
  };

  const toggleNote = (index, n) => {
    if (given.has(index) || board[index] !== 0 || showResult || isFrozen || phase !== "duel") return;
    const prevBoard = board.slice();
    const prevNotes = cloneNotes(notes);
    const nextNotes = cloneNotes(notes);
    if (nextNotes[index].has(n)) { nextNotes[index].delete(n); }
    else {
      for (const pi of peersOf(index)) { if (board[pi] === n) { setNoteConflictFlash({ index: pi, untilMs: Date.now() + 300 }); return; } }
      nextNotes[index].add(n);
    }
    pushUndo(prevBoard, prevNotes);
    setNotes(nextNotes);
    if (!locked) setSelectedNumber(null);
  };

  const detectNewCompletions = (prevBoard, nextBoard, changedIndex) => {
    const r = cellRow(changedIndex), c = cellCol(changedIndex), b = cellBox(changedIndex);
    const newRows = [], newCols = [], newBoxes = [];
    if (!isGroupComplete(rowIndices(r), prevBoard) && isGroupComplete(rowIndices(r), nextBoard)) newRows.push(r);
    if (!isGroupComplete(colIndices(c), prevBoard) && isGroupComplete(colIndices(c), nextBoard)) newCols.push(c);
    if (!isGroupComplete(boxIndices(b), prevBoard) && isGroupComplete(boxIndices(b), nextBoard)) newBoxes.push(b);
    if (newRows.length || newCols.length || newBoxes.length) setCompletedFlash({ rows: newRows, cols: newCols, boxes: newBoxes, untilMs: Date.now() + COMPLETE_FLASH_MS, originIndex: changedIndex });
  };

  const placeValue = (index, value) => {
    if (showResult || isFrozen || phase !== "duel") return;
    if (given.has(index)) return;
    if (board[index] === value) { if (!locked) setSelectedNumber(null); return; }
    const conflictIndices = getConflictIndices(index, value);
    if (conflictIndices.length > 0) {
      triggerErrorFeedback(index, value, conflictIndices);
      const nextCount = errorCount + 1; setErrorCount(nextCount); setFreezeUntilMs(Date.now() + 4000 + nextCount * 1000);
      return;
    }
    if (duelSolution && duelSolution[index] !== value) {
      triggerErrorFeedback(index, value, []);
      const nextCount = errorCount + 1; setErrorCount(nextCount); setFreezeUntilMs(Date.now() + 4000 + nextCount * 1000);
      return;
    }
    const prevBoard = board.slice();
    const prevNotes = cloneNotes(notes);
    const nextBoard = board.slice();
    nextBoard[index] = value;
    const nextNotes = cloneNotes(notes);
    nextNotes[index].clear();
    removeCandidateFromPeers(index, value, nextNotes);
    pushUndo(prevBoard, prevNotes);
    setBoard(nextBoard);
    setNotes(nextNotes);
    detectNewCompletions(prevBoard, nextBoard, index);
    if (duelSolution && nextBoard.every(v => v !== 0) && nextBoard.every((v, i) => v === duelSolution[i])) {
      setStopMs(Date.now());
      handleFinish(nextBoard);
    }
    if (!locked) setSelectedNumber(null);
  };

  const eraseOneShot = (index) => {
    if (given.has(index) || showResult || isFrozen || phase !== "duel") return;
    const prevBoard = board.slice();
    const prevNotes = cloneNotes(notes);
    const nextBoard = board.slice();
    const nextNotes = cloneNotes(notes);
    if (nextBoard[index] !== 0) { nextBoard[index] = 0; }
    else if (nextNotes[index].size > 0) { nextNotes[index].clear(); }
    else { setEraseArmed(false); return; }
    pushUndo(prevBoard, prevNotes);
    setBoard(nextBoard);
    setNotes(nextNotes);
    setEraseArmed(false);
    setErrorFlash(null);
    setCompletedFlash({ rows: [], cols: [], boxes: [], untilMs: 0, originIndex: null });
  };

  const canSwipeNotes = () => noteMode && locked && selectedNumber != null;
  const canSwipeValues = () => !noteMode && locked && selectedNumber != null && !eraseArmed;

  const applySwipeOnCell = (i) => {
    if (showResult || isFrozen || phase !== "duel") return;
    if (dragVisitedRef.current.has(i)) return;
    dragVisitedRef.current.add(i);
    if (canSwipeNotes()) {
      if (given.has(i) || board[i] !== 0) {
        if (board[i] === selectedNumber) {
          setNotes(prev => { const next = cloneNotes(prev); removeCandidateFromPeers(i, selectedNumber, next); return next; });
        }
        return;
      }
      const prevBoard = board.slice();
      const prevNotes = cloneNotes(notes);
      const nextNotes = cloneNotes(notes);
      if (nextNotes[i].has(selectedNumber)) { nextNotes[i].delete(selectedNumber); }
      else {
        for (const pi of peersOf(i)) { if (board[pi] === selectedNumber) { setNoteConflictFlash({ index: pi, untilMs: Date.now() + 300 }); return; } }
        nextNotes[i].add(selectedNumber);
      }
      pushUndo(prevBoard, prevNotes);
      setNotes(nextNotes);
      return;
    }
    if (canSwipeValues()) {
      if (given.has(i)) return;
      placeValue(i, selectedNumber);
    }
  };

  const onCellPointerDown = (i, e) => {
    if (showResult || phase !== "duel") return;
    if (canSwipeNotes() || canSwipeValues()) {
      setDragging(true); dragVisitedRef.current = new Set(); applySwipeOnCell(i);
      if (gridRef.current) gridRef.current.setPointerCapture(e.pointerId);
      return;
    }
    onCellTap(i);
  };

  const onGridPointerMove = (e) => {
    if (!dragging || phase !== "duel") return;
    if (!(canSwipeNotes() || canSwipeValues())) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || !el.dataset || el.dataset.cellIndex === undefined) return;
    applySwipeOnCell(parseInt(el.dataset.cellIndex, 10));
  };

  const onCellTap = (i) => {
    if (showResult || isFrozen || phase !== "duel") return;
    if (eraseArmed) { eraseOneShot(i); return; }
    if (selectedNumber == null) return;
    if (noteMode) {
      if (given.has(i) || board[i] !== 0) {
        if (board[i] === selectedNumber) {
          setNotes(prev => { const next = cloneNotes(prev); removeCandidateFromPeers(i, selectedNumber, next); return next; });
        }
        return;
      }
      toggleNote(i, selectedNumber);
    } else { placeValue(i, selectedNumber); }
  };

  const completedWaveProgress = completedFlash.untilMs > nowMs
    ? 1 - (completedFlash.untilMs - nowMs) / COMPLETE_FLASH_MS : 1;

  const handleFindMatch = (diff) => {
    if (!socketRef.current) return;
    setSearchDiff(diff);
    setPhase("searching");
    socketRef.current.emit("matchmaking:search", { difficulty: diff, playerId, playerName });
  };

  const handleCancelSearch = () => {
    if (!socketRef.current) return;
    socketRef.current.emit("matchmaking:cancel");
    setPhase("lobby");
  };

  const handlePlayCPU = () => {
    if (!socketRef.current || !searchDiff) return;
    socketRef.current.emit("matchmaking:playCPU", { difficulty: searchDiff, playerId, playerName });
    setShowCpuOption(false);
  };

  const handleFinish = (optBoard) => {
    if (!socketRef.current || phase !== "duel") return;
    socketRef.current.emit("duel:finish", { board: optBoard || board });
  };

  const handleBackToLobby = () => {
    setPhase("lobby");
    setShowResult(false);
    setDuelResult(null);
    setStartMs(null);
    setStopMs(null);
    setSearchDiff(null);
    setOpponentIsBot(false);
    setShowCpuOption(false);
  };

  if (phase === "lobby") {
    return (
      <div style={s.tabArea}>
        <div style={s.tabRow}>
          <button style={{ ...s.tabBtn, marginRight: -1 }} onClick={() => onTabChange("practice")}>Practice</button>
          <button style={{ ...s.tabBtnActive, marginLeft: -1 }}>Compete</button>
        </div>
        <div style={s.headerContent}>
          <div style={{ marginBottom: 16, color: "rgba(232,239,255,0.65)" }}>
            🟢 {onlineCount} player{onlineCount !== 1 ? "s" : ""} online
          </div>
          {DIFFICULTIES.map((d, i) => {
            const unlocked = i <= unlockedLevel;
            const wins = competeStats?.[d]?.wins || 0;
            const best = competeStats?.[d]?.bestMs;
            return (
              <div key={d} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ fontSize: 15, fontWeight: 700, color: unlocked ? "inherit" : "rgba(232,239,255,0.3)" }}>
                    {COMPETE_LABELS[i]}
                  </span>
                  {unlocked && (
                    <span style={{ fontSize: 12, color: "rgba(232,239,255,0.45)" }}>
                      🏆 {wins} · Best: {best ? formatTime(best) : "—"}
                    </span>
                  )}
                </div>
                {unlocked ? (
                  <button style={{ padding: "8px 20px", borderRadius: 12, border: "1px solid rgba(255,255,255,0.14)", background: "linear-gradient(180deg, #3c8dff, #2268ff)", color: "white", fontWeight: 700, fontSize: 13, cursor: "pointer", width: 80, textAlign: "center" }} onClick={() => handleFindMatch(d)} disabled={!socket}>
                    Play
                  </button>
                ) : (
                  <span style={{ fontSize: 12, color: "rgba(232,239,255,0.35)", whiteSpace: "nowrap" }}>
                    {UNLOCK_REQS[i]} 🔒
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  if (phase === "searching") {
    return (
      <div style={s.tabArea}>
        <div style={s.tabRow}>
          <button style={{ ...s.tabBtn, marginRight: -1 }} onClick={() => onTabChange("practice")}>Practice</button>
          <button style={{ ...s.tabBtnActive, marginLeft: -1 }}>Compete</button>
        </div>
        <div style={{ ...s.headerContent, textAlign: "center", padding: "40px 20px" }}>
          <div style={{ fontSize: 18, marginBottom: 20, color: "rgba(232,239,255,0.8)" }}>
            Searching for {searchDiff} opponent...
          </div>
          <div style={{ fontSize: 40, marginBottom: 20 }}>⏳</div>
          <div style={{ fontSize: 14, color: "rgba(232,239,255,0.5)", marginBottom: 24 }}>
            {onlineCount} online
          </div>
          {showCpuOption && (
            <>
              <button style={{ ...s.primaryBtn, background: "linear-gradient(180deg, #40d39c, #2aa67a)", marginBottom: 8 }} onClick={handlePlayCPU}>
                Play vs CPU 🤖
              </button>
              <div style={{ fontSize: 12, color: "rgba(232,239,255,0.45)", marginBottom: 12 }}>
                CPU trained on real match times
              </div>
            </>
          )}
          <button style={{ ...s.primaryBtn, background: "linear-gradient(180deg, #ff4d6d, #cc2450)" }} onClick={handleCancelSearch}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (phase === "countdown") {
    return (
      <div style={s.tabArea}>
        <div style={s.tabRow}>
          <button style={{ ...s.tabBtn, marginRight: -1 }} onClick={() => onTabChange("practice")}>Practice</button>
          <button style={{ ...s.tabBtnActive, marginLeft: -1 }}>Compete</button>
        </div>
        <div style={{ ...s.headerContent, textAlign: "center", padding: "40px 20px" }}>
          <div style={{ fontSize: 14, color: "rgba(232,239,255,0.6)", marginBottom: 8 }}>Match found!</div>
          <div style={{ fontSize: 16, marginBottom: 20 }}>vs <strong>{opponentName}</strong></div>
          <div style={{ fontSize: 64, fontWeight: 900, color: countdownSec <= 1 ? "#ff4d6d" : "#d4e8ff" }}>{countdownSec > 0 ? countdownSec : "Go!"}</div>
        </div>
      </div>
    );
  }

  if (showResult && duelResult) {
    return (
      <>
        <canvas ref={confettiCanvasRef} style={{
          position: "fixed", inset: 0, pointerEvents: "none",
          zIndex: 10001, width: "100%", height: "100%"
        }} />
        <div style={s.tabArea}>
        <div style={s.tabRow}>
          <button style={{ ...s.tabBtn, marginRight: -1 }} onClick={() => onTabChange("practice")}>Practice</button>
          <button style={{ ...s.tabBtnActive, marginLeft: -1 }}>Compete</button>
        </div>
        <div style={{ ...s.headerContent, textAlign: "center", animation: "resultFadeIn 0.5s ease-out" }}>
          {duelResult.disconnected && duelResult.won ? (
            <>
              <div style={{ fontSize: 46, marginBottom: 8 }}>🏆</div>
              <div style={{ fontSize: 18, fontWeight: 900, marginBottom: 12 }}>
                Your opponent was disconnected.<br />Start another match!
              </div>
            </>
          ) : duelResult.disconnected ? (
            <>
              <div style={{ fontSize: 46, marginBottom: 8 }}>😔</div>
              <div style={{ fontSize: 20, fontWeight: 900, marginBottom: 12 }}>
                You were disconnected — game is over!
              </div>
            </>
          ) : duelResult.won ? (
            <>
              <div style={{ fontSize: 46, marginBottom: 8 }}>🏆</div>
              <div style={{ fontSize: 22, fontWeight: 900, marginBottom: 12 }}>
                {duelResult.bot ? `You beat the computer! Your time was ${formatTime(duelResult.myTime)}!` : `Congratulations, your time is ${formatTime(duelResult.myTime)}!`}
              </div>
              <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 20, color: "#40d39c" }}>
                You won!
              </div>
            </>
          ) : duelResult.bot ? (
            <>
              <div style={{ fontSize: 46, marginBottom: 8 }}>😔</div>
              <div style={{ fontSize: 22, fontWeight: 900, marginBottom: 12 }}>
                The computer was faster!
              </div>
              <div style={{ fontSize: 16, marginBottom: 20, color: "rgba(232,239,255,0.7)" }}>
                Your time was {formatTime(duelResult.myTime)}
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 46, marginBottom: 8 }}>😔</div>
              <div style={{ fontSize: 22, fontWeight: 900, marginBottom: 12 }}>
                You lost!
              </div>
              <div style={{ fontSize: 16, marginBottom: 20, color: "rgba(232,239,255,0.7)" }}>
                Your opponent finished in {formatTime(duelResult.opponentTime)}
              </div>
            </>
          )}
          <button style={s.primaryBtn} onClick={handleBackToLobby}>Play again</button>
        </div>
      </div>
      </>
    );
  }

  const confirmLeave = (targetTab) => {
    if (phase === "duel") {
      if (!leaveSessionRef.current) leaveSessionRef.current = { noClicks: 0, tabClicks: 0 };
      leaveSessionRef.current.tabClicks++;
      setLeaveTarget(targetTab);
    } else {
      onTabChange(targetTab);
    }
  };

  return (
    <div style={s.tabArea}>
      <div style={s.tabRow}>
        <button style={{ ...s.tabBtn, marginRight: -1 }} onClick={() => confirmLeave("practice")}>Practice</button>
        <button style={{ ...s.tabBtnActive, marginLeft: -1 }}>Compete</button>
      </div>
      <div style={s.headerContent}>
        <div style={s.row}>
          <div>
            <div style={s.sub}>
              vs <strong>{opponentName}</strong>
              <span style={{ marginLeft: 8, fontSize: 12, color: "rgba(232,239,255,0.4)" }}>{matchData?.difficulty}</span>
            </div>
          </div>
          <div style={s.timer}>⏱ {formatTime(elapsedMs)}</div>
        </div>
        <div style={s.muted}>First to finish correctly wins!</div>
      </div>

      <div style={s.card}>
        <div ref={gridRef} style={s.grid} onPointerMove={onGridPointerMove}>
          {Array.from({ length: 81 }, (_, i) => {
            const v = board[i];
            const isGiven = given.has(i);
            const cellNotes = notes[i];
            const thickR = i % 9 === 2 || i % 9 === 5 ? "2px solid rgba(255,255,255,0.18)" : "1px solid rgba(255,255,255,0.10)";
            const thickB = Math.floor(i / 9) === 2 || Math.floor(i / 9) === 5 ? "2px solid rgba(255,255,255,0.18)" : "1px solid rgba(255,255,255,0.10)";
            const isError = errorFlash && errorFlash.index === i && nowMs <= errorFlash.untilMs;
            const isConflictCell = errorFlash && errorFlash.conflictIndices?.includes(i) && nowMs <= errorFlash.untilMs;
            const errorOpacity = isError ? Math.max(0, (errorFlash.untilMs - nowMs) / 260) : 0;
            const r = cellRow(i), c = cellCol(i), b = cellBox(i);
            const inCompletedWave = completedFlash.untilMs > nowMs && (completedFlash.rows.includes(r) || completedFlash.cols.includes(c) || completedFlash.boxes.includes(b));
            let waveOpacity = 0;
            if (inCompletedWave && completedFlash.originIndex != null) {
              const distance = manhattan(i, completedFlash.originIndex);
              const waveFront = completedWaveProgress * 5.5;
              waveOpacity = Math.max(0, 1 - Math.abs(waveFront - distance) / 1.15) * 0.9;
            }
            const isNoteConflict = noteConflictFlash && noteConflictFlash.index === i && nowMs <= noteConflictFlash.untilMs;
            const noteConflictOpacity = isNoteConflict ? Math.max(0, (noteConflictFlash.untilMs - nowMs) / 300) : 0;
            const isSelectedMatch = selectedNumber != null && v === selectedNumber;

            return (
              <div key={i} onPointerDown={(e) => onCellPointerDown(i, e)} data-cell-index={i}
                style={{ ...s.cell, borderRight: thickR, borderBottom: thickB,
                  background: isConflictCell ? "rgba(255,77,109,0.20)"
                    : isSelectedMatch ? "rgba(30, 65, 130, 0.58)"
                    : isGiven ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.02)",
                  color: isGiven ? "#fff" : "#d9e6ff", fontWeight: isGiven ? 900 : 700 }}
              >
                {inCompletedWave && waveOpacity > 0 && (<div style={{ ...s.completedWave, opacity: waveOpacity }} />)}
                {isNoteConflict && (<div style={{ ...s.noteConflictOverlay, opacity: noteConflictOpacity }} />)}
                {isError ? (<div style={{ ...s.errorOverlay, opacity: errorOpacity, transform: `scale(${1 + (1 - errorOpacity) * 0.08})` }}>{errorFlash.value}</div>)
                : v !== 0 ? v
                : cellNotes.size > 0 ? (<div style={s.notes}>{Array.from({ length: 9 }, (_, k) => { const n = k + 1; return <div key={n} style={s.noteItem}>{cellNotes.has(n) ? n : ""}</div>; })}</div>)
                : ""}
              </div>
            );
          })}
          {isFrozen && (<div style={s.freezeOverlay}><div style={s.freezeCountdown}>🧊 {freezeRemaining}s</div></div>)}
        </div>

        <div style={s.actionBar}>
          <button type="button" style={s.actionBtn} onClick={handleUndo}><div style={s.actionIcon}>↶</div><div style={s.actionLabel}>Undo</div></button>
          <button type="button" style={{ ...s.actionBtn, ...(eraseArmed ? s.actionBtnActiveDanger : null) }} onClick={() => { setEraseArmed(true); setSelectedNumber(null); }}><div style={s.actionIcon}>⌫</div><div style={s.actionLabel}>Erase</div></button>
          <button type="button" style={{ ...s.actionBtn, ...(noteMode ? s.actionBtnActive : null) }} onClick={() => setNoteMode(v => !v)}>
            <div style={s.actionIconWrap}><div style={s.actionIcon}>✎</div><div style={s.miniPill}>{noteMode ? "ON" : "OFF"}</div></div>
            <div style={s.actionLabel}>Notes</div>
          </button>
        </div>

        <div style={s.numberRow}>
          {Array.from({ length: 9 }, (_, idx) => {
            const n = idx + 1;
            const disabled = remainingOf(n) === 0;
            const isActive = selectedNumber === n;
            const lockVisualOn = locked && selectedNumber != null;
            const isFaded = lockVisualOn && !isActive;
            return (
              <button key={n} type="button" disabled={disabled}
                onPointerDown={() => onNumberPointerDown(n)} onPointerUp={() => onNumberPointerUp(n)}
                onPointerCancel={() => { if (longPressRef.current) { clearTimeout(longPressRef.current); longPressRef.current = null; } }}
                onContextMenu={(e) => e.preventDefault()}
                style={{ ...s.numberBtn, opacity: disabled ? 0.15 : isFaded ? 0.35 : 1, background: isActive ? "rgba(47,127,255,0.20)" : "transparent", pointerEvents: disabled ? "none" : "auto" }}
              >
                {locked && isActive && <span style={s.lockDot} />}
                <span>{n}</span>
              </button>
            );
          })}
        </div>
      </div>
      {leaveTarget && (
        <div style={s.modalBackdrop}>
          <div style={s.modalCard}>
            <div style={s.modalTitle}>Leaving an active match</div>
            <div style={s.modalText}>Are you sure?</div>
            <div style={s.leaveRow}>
              <button type="button" style={s.leaveBtnYes} onClick={() => {
                const s = leaveSessionRef.current;
                fetch("/analytics/leave", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "yes", view: "compete", elapsedMs, difficulty: matchData?.difficulty || "Unknown", noClicksAntes: s?.noClicks || 0, tabClicksAntes: s?.tabClicks || 0 }) }).catch(() => {});
                onTabChange(leaveTarget); setLeaveTarget(null);
              }}>YES</button>
              <button type="button" style={s.leaveBtnNo} onClick={() => {
                if (leaveSessionRef.current) leaveSessionRef.current.noClicks++;
                fetch("/analytics/leave", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "no", view: "compete", elapsedMs, difficulty: matchData?.difficulty || "Unknown", noClicksAntes: leaveSessionRef.current?.noClicks || 0, tabClicksAntes: leaveSessionRef.current?.tabClicks || 0 }) }).catch(() => {});
                setLeaveTarget(null);
              }}>NO!</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MetricsView({ onTabChange }) {
  const [data, setData] = useState([]);
  const [sessions, setSessions] = useState({ practice: 0, compete: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch("/analytics/leave").then(r => r.json()),
      fetch("/analytics/sessions").then(r => r.json())
    ]).then(([d, s]) => { setData(d); setSessions(s); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  const total = data.length;
  const totalGames = (sessions.practice || 0) + (sessions.compete || 0);
  const modalRate = totalGames ? Math.round(total / totalGames * 100) : 0;
  const yes = data.filter(d => d.action === "yes").length;
  const no = data.filter(d => d.action === "no").length;
  const yesPct = total ? Math.round(yes / total * 100) : 0;
  const yesAfterNo = data.filter(d => d.action === "yes" && d.noClicksAntes > 0).length;
  const yesAfterNoPct = yes ? Math.round(yesAfterNo / yes * 100) : 0;
  const avgTabClicks = yes ? (data.filter(d => d.action === "yes").reduce((s, d) => s + (d.tabClicksAntes || 0), 0) / yes) : 0;
  const pData = data.filter(d => d.view === "practice");
  const cData = data.filter(d => d.view === "compete");
  const pYes = pData.filter(d => d.action === "yes").length;
  const cYes = cData.filter(d => d.action === "yes").length;
  const pRate = sessions.practice ? Math.round(pData.length / sessions.practice * 100) : 0;
  const cRate = sessions.compete ? Math.round(cData.length / sessions.compete * 100) : 0;

  const row = (label, value, ok) => (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
      <span style={{ color: "rgba(232,239,255,0.7)" }}>{label}</span>
      <span style={{ fontWeight: 700, color: ok != null ? (ok ? "#40d39c" : "#ff4d6d") : "inherit" }}>{value}</span>
    </div>
  );

  return (
    <div>
      <div style={s.tabArea}>
        <div style={s.tabRow}>
          <button style={{ ...s.tabBtn, marginRight: -1 }} onClick={() => onTabChange("practice")}>Practice</button>
          <button style={{ ...s.tabBtnActive, marginLeft: -1 }}>Metrics</button>
        </div>
      </div>
      {loading ? (
        <div style={s.card}><div style={s.modalText}>Loading...</div></div>
      ) : (
        <div style={s.card}>
          <div style={s.modalTitle}>Leave Decision Analytics</div>
          <div style={{ ...s.modalSub, marginBottom: 16, fontSize: 14 }}>{total} registros em {totalGames} jogos</div>
          {row("Modal acionado", `${total} / ${totalGames} (${modalRate}%)`, modalRate < 20)}
          {row("YES", `${yes} (${yesPct}%)`, yesPct < 20)}
          {row("NO!", `${no} (${100 - yesPct}%)`, yesPct < 20)}
          {row("YES após NO! (falso positivo)", `${yesAfterNo} (${yesAfterNoPct}% dos YES)`, yesAfterNoPct < 30)}
          {row("Média re-cliques na aba", avgTabClicks.toFixed(1) + "x", avgTabClicks < 1.5)}
          <div style={{ fontSize: 14, color: "rgba(232,239,255,0.45)", marginTop: 16, marginBottom: 8 }}>Por view</div>
          {row("Practice", `${pYes}/${pData.length} YES · ${pData.length}/${sessions.practice} jogos (${pRate}%)`)}
          {row("Compete", `${cYes}/${cData.length} YES · ${cData.length}/${sessions.compete} jogos (${cRate}%)`)}
          <div style={{ fontSize: 14, color: "rgba(232,239,255,0.45)", marginTop: 16, marginBottom: 8 }}>Últimos registros</div>
          {data.slice(-10).reverse().map((d, i) => (
            <div key={i} style={{ fontSize: 12, color: "rgba(232,239,255,0.6)", padding: "4px 0", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
              {d.action === "yes" ? "✅ YES" : "❌ NO!"} | {d.view} | {d.difficulty} | {formatTime(d.elapsedMs)} | noClicks={d.noClicksAntes} tabClicks={d.tabClicksAntes}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


const s = {
  page: {
    minHeight: "100vh",
    background: "linear-gradient(#070c16, #0b1220)",
    color: "#e8efff",
    padding: "14px",
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial",
    maxWidth: 520,
    margin: "0 auto",
  },
  tabArea: {
    marginBottom: 12,
  },
  tabRow: {
    display: "flex",
  },
  tabBtn: {
    flex: 1, padding: "11px 0", textAlign: "center", fontSize: 14,
    fontWeight: 700, color: "rgba(232,239,255,0.35)",
    background: "rgba(10,18,34,0.6)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderBottom: "1px solid rgba(255,255,255,0.12)",
    borderRadius: "9px 9px 5px 5px",
    cursor: "pointer",
    position: "relative",
    zIndex: 1,
  },
  tabBtnActive: {
    flex: 1, padding: "11px 0", textAlign: "center", fontSize: 14,
    fontWeight: 700, color: "#4da3ff",
    background: "rgba(18,28,48,0.78)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderBottom: "none",
    borderRadius: "9px 9px 0 0",
    cursor: "pointer",
    position: "relative",
    zIndex: 3,
  },
  headerContent: {
    padding: 14,
    background: "rgba(18,28,48,0.78)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderTop: "none",
    borderRadius: "0 0 18px 18px",
    position: "relative",
    zIndex: 2,
  },
  card: {
    background: "rgba(18,28,48,0.78)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: 18, padding: 14,
    boxShadow: "0 14px 40px rgba(0,0,0,0.35)", marginBottom: 12,
  },
  row: { display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" },
  title: { fontSize: 22, fontWeight: 800, marginBottom: 6 },
  sub: { color: "rgba(232,239,255,0.75)", fontSize: 13, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" },
  select: { background: "rgba(255,255,255,0.06)", color: "#e8efff", border: "1px solid rgba(255,255,255,0.14)", padding: "8px 10px", borderRadius: 12 },
  btn: { background: "rgba(255,255,255,0.08)", color: "#e8efff", border: "1px solid rgba(255,255,255,0.14)", padding: "8px 10px", borderRadius: 12, fontWeight: 700 },
  timer: { fontWeight: 900, background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.12)", padding: "8px 10px", borderRadius: 999, height: "fit-content" },
  statRow: { marginTop: 8, fontSize: 14, color: "rgba(232,239,255,0.6)" },
  muted: { marginTop: 10, fontSize: 12, color: "rgba(232,239,255,0.65)" },
  grid: { display: "grid", gridTemplateColumns: "repeat(9, 1fr)", gridTemplateRows: "repeat(9, 1fr)", border: "2px solid rgba(255,255,255,0.20)", borderRadius: 16, overflow: "hidden", width: "100%", aspectRatio: "1 / 1", touchAction: "none", overscrollBehavior: "contain", position: "relative" },
  cell: { position: "relative", display: "grid", placeItems: "center", userSelect: "none", touchAction: "none", fontSize: 18, minHeight: 0, overflow: "hidden" },
  completedWave: { position: "absolute", inset: 0, background: "radial-gradient(circle, rgba(69, 214, 206, 0.58) 0%, rgba(69, 214, 206, 0.26) 52%, rgba(69, 214, 206, 0.0) 100%)", pointerEvents: "none", mixBlendMode: "screen" },
  noteConflictOverlay: { position: "absolute", inset: 0, boxShadow: "inset 0 0 14px rgba(69, 214, 206, 0.7), 0 0 20px rgba(69, 214, 206, 0.3)", borderRadius: 4, pointerEvents: "none" },
  notes: { position: "absolute", inset: 6, display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 2, fontSize: 10, color: "rgba(232,239,255,0.72)", alignContent: "center", justifyItems: "center", lineHeight: 1 },
  noteItem: { lineHeight: 1 },
  freezeOverlay: { position: "absolute", inset: 0, zIndex: 10, background: "linear-gradient(180deg, rgba(180,210,255,0.25) 0%, rgba(140,180,240,0.30) 50%, rgba(180,210,255,0.25) 100%)", backdropFilter: "blur(3px) brightness(1.3)", WebkitBackdropFilter: "blur(3px) brightness(1.3)", display: "grid", placeItems: "center", animation: "frostShimmer 4s ease-in-out infinite", pointerEvents: "auto" },
  freezeCountdown: { fontSize: 36, fontWeight: 900, color: "#d4e8ff", textShadow: "0 0 30px rgba(100,180,255,0.6), 0 0 60px rgba(100,180,255,0.3)", zIndex: 11, pointerEvents: "none" },
  errorOverlay: { color: "#ff4d6d", fontWeight: 900, fontSize: 20, textShadow: "0 0 14px rgba(255,77,109,0.35)" },
  actionBar: { display: "flex", justifyContent: "space-around", alignItems: "center", gap: 10, padding: "10px 6px", marginTop: 10, borderTop: "1px solid rgba(255,255,255,0.10)" },
  actionBtn: { flex: 1, background: "transparent", border: 0, color: "rgba(232,239,255,0.85)", padding: "10px 6px", borderRadius: 14, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 },
  actionBtnActive: { background: "rgba(77,163,255,0.10)", outline: "1px solid rgba(77,163,255,0.35)" },
  actionBtnActiveDanger: { background: "rgba(255,77,109,0.12)", outline: "1px solid rgba(255,77,109,0.35)" },
  actionIconWrap: { position: "relative", display: "grid", placeItems: "center" },
  actionIcon: { fontSize: 20, lineHeight: 1, opacity: 0.9 },
  actionLabel: { fontSize: 12, fontWeight: 700, opacity: 0.85 },
  miniPill: { position: "absolute", top: -10, right: -12, fontSize: 10, fontWeight: 900, padding: "3px 7px", borderRadius: 999, background: "rgba(255,255,255,0.10)", border: "1px solid rgba(255,255,255,0.12)", color: "rgba(232,239,255,0.85)" },
  numberRow: { display: "grid", gridTemplateColumns: "repeat(9, 1fr)", gap: 10, marginTop: 12 },
  numberBtn: { position: "relative", padding: "14px 0", borderRadius: 14, border: "1px solid rgba(255,255,255,0.16)", background: "transparent", color: "rgba(120, 170, 255, 0.95)", fontSize: 20, fontWeight: 900 },
  lockDot: { position: "absolute", top: 6, left: "50%", transform: "translateX(-50%)", width: 6, height: 6, borderRadius: 999, background: "rgba(120, 170, 255, 0.95)", boxShadow: "0 0 10px rgba(120,170,255,0.55)" },
  nameInput: { width: "100%", padding: "12px 14px", borderRadius: 14, border: "1px solid rgba(255,255,255,0.16)", background: "rgba(255,255,255,0.06)", color: "#e8efff", fontSize: 16, marginBottom: 16, outline: "none" },
  primaryBtn: { width: "100%", padding: "14px 16px", borderRadius: 16, border: "1px solid rgba(255,255,255,0.14)", background: "linear-gradient(180deg, #3c8dff, #2268ff)", color: "white", fontWeight: 900, fontSize: 16, boxShadow: "0 12px 28px rgba(34,104,255,0.28)", cursor: "pointer" },
  modalBackdrop: { position: "fixed", inset: 0, background: "rgba(3, 7, 18, 0.72)", backdropFilter: "blur(4px)", display: "grid", placeItems: "center", zIndex: 999, padding: 20 },
  modalCard: { width: "min(92vw, 380px)", background: "linear-gradient(180deg, rgba(28,39,64,0.98), rgba(14,22,38,0.98))", border: "1px solid rgba(255,255,255,0.14)", borderRadius: 24, padding: "24px 20px 20px", boxShadow: "0 28px 90px rgba(0,0,0,0.48)", textAlign: "center", overflow: "hidden" },
  trophy: { fontSize: 46, marginBottom: 8, animation: "trophyBounce 1.2s ease-in-out infinite" },
  modalTitle: { fontSize: 26, fontWeight: 900, marginBottom: 8, color: "#ffffff" },
  modalText: { fontSize: 18, fontWeight: 800, color: "#dfe8ff", marginBottom: 6 },
  modalSub: { fontSize: 14, color: "rgba(232,239,255,0.78)", marginBottom: 18 },
  leaveRow: { display: "flex", gap: 10, marginTop: 18 },
  leaveBtnYes: { flex: 1, padding: "12px 0", borderRadius: 14, border: "1px solid rgba(255,255,255,0.14)", background: "rgba(255,255,255,0.08)", color: "#e8efff", fontWeight: 700, fontSize: 15, cursor: "pointer" },
  leaveBtnNo: { flex: 1, padding: "12px 0", borderRadius: 14, border: "none", background: "linear-gradient(180deg, #ff4d6d, #cc2450)", color: "white", fontWeight: 900, fontSize: 15, cursor: "pointer", boxShadow: "0 8px 20px rgba(204,36,80,0.35)" },
};
