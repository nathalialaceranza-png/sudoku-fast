import express from "express";
import http from "http";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Server } from "socket.io";
import { generatePuzzle } from "./sudoku.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const STATS_FILE = path.join(DATA_DIR, "stats.json");
const CLIENT_DIST = path.join(__dirname, "..", "client", "dist");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function loadStats() {
  try { return JSON.parse(fs.readFileSync(STATS_FILE, "utf8")); } catch { return {}; }
}

function saveStats(stats) {
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(CLIENT_DIST));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const DIFFICULTIES = ["Easy", "Medium", "Hard", "Expert", "Master"];
const BOT_SEED_MS = { Easy: 120000, Medium: 180000, Hard: 300000, Expert: 420000, Master: 600000 };
const matchQueue = [];
const lobbySockets = new Set();
const lastHeartbeat = new Map();
const pendingDisconnectResults = new Map();
const botTimers = new Map();

function getUnlockedLevel(stats, playerId) {
  const c = stats[playerId]?.compete || {};
  if ((c.Expert?.wins || 0) >= 3) return 4;
  if ((c.Hard?.wins || 0) >= 3) return 3;
  if ((c.Medium?.wins || 0) >= 3) return 2;
  if ((c.Easy?.wins || 0) >= 3) return 1;
  return 0;
}

function emitUnlocked(socket) {
  const stats = loadStats();
  const level = getUnlockedLevel(stats, socket.data.playerId);
  socket.emit("matchmaking:unlocked", { level });
}

function getBotTime(difficulty) {
  const stats = loadStats();
  const bt = stats.botTimes?.[difficulty];
  const avg = bt && bt.count > 0 ? bt.totalMs / bt.count : BOT_SEED_MS[difficulty] || 120000;
  return Math.round(avg * (0.85 + Math.random() * 0.40));
}

function recordHumanTime(difficulty, elapsedMs) {
  const stats = loadStats();
  if (!stats.botTimes) stats.botTimes = {};
  if (!stats.botTimes[difficulty]) stats.botTimes[difficulty] = { totalMs: 0, count: 0 };
  stats.botTimes[difficulty].totalMs += elapsedMs;
  stats.botTimes[difficulty].count++;
  saveStats(stats);
}

function addGameSession(view) {
  const stats = loadStats();
  if (!stats.gameSessions) stats.gameSessions = {};
  stats.gameSessions[view] = (stats.gameSessions[view] || 0) + 1;
  saveStats(stats);
}

function getQueueCounts() {
  const counts = { Easy: 0, Medium: 0, Hard: 0, Expert: 0, Master: 0 };
  for (const entry of matchQueue) {
    counts[entry.difficulty]++;
  }
  return counts;
}

function broadcastQueueCounts() {
  io.emit("queue:counts", getQueueCounts());
}

function cleanupSocketDuel(sock) {
  delete sock.data.duelRoom;
  delete sock.data.duelPlayers;
  delete sock.data.duelSolution;
  delete sock.data.duelStartAtMs;
}

setInterval(() => {
  const now = Date.now();
  for (const [sid, last] of lastHeartbeat) {
    if (now - last > 15000) {
      const sock = io.sockets.sockets.get(sid);
      if (sock) {
        const players = sock.data.duelPlayers;
        if (players && !sock.data.duelOver) {
          const opponentSocket = Object.keys(players).find(s => s !== sid);
          if (opponentSocket) {
            const oppSock = io.sockets.sockets.get(opponentSocket);
            // Notify the active player
            if (oppSock) {
              oppSock.emit("duel:opponentDisconnected");
              oppSock.data.duelOver = true;
              cleanupSocketDuel(oppSock);
            }
          }

          // Result for the inactive player
          const pName = sock.data.playerName || "Player";
          const oName = opponentSocket ? (players[opponentSocket]?.name || "Opponent") : "Opponent";
          const result = {
            won: false,
            myTime: null,
            opponentTime: null,
            winnerName: oName,
            opponentName: pName,
            disconnected: true
          };

          sock.emit("duel:youWereDisconnected", result);

          const pid = sock.data.playerId;
          if (pid) pendingDisconnectResults.set(pid, result);

          sock.data.duelOver = true;
          cleanupSocketDuel(sock);
        }
      }
      lastHeartbeat.delete(sid);
    }
  }
}, 5000);

function broadcastCount() {
  io.emit("lobby:count", lobbySockets.size);
}

const MATCH_FALLBACK = { Medium: "Easy", Hard: "Medium", Expert: "Hard", Master: "Expert" };

function searchRange(diff) {
  const r = [diff];
  const f = MATCH_FALLBACK[diff];
  if (f) r.push(f);
  return r;
}

function tryMatch(player) {
  const idx = matchQueue.findIndex(
    m => m.socketId !== player.socketId && searchRange(player.difficulty).includes(m.difficulty)
  );
  if (idx === -1) return null;
  const [opponent] = matchQueue.splice(idx, 1);
  return opponent;
}

function beginDuel(sockA, sockB, difficulty) {
  if (!sockA || !sockB) return;
  addGameSession("compete");
  const { puzzle, solution } = generatePuzzle(difficulty);
  const matchId = `${Date.now()}-${sockA.id}-${sockB.id}`;
  const startAtMs = Date.now() + 2000;

  sockA.join(matchId);
  sockB.join(matchId);

  sockA.data.duelRoom = matchId;
  sockA.data.duelDifficulty = difficulty;
  sockB.data.duelRoom = matchId;
  sockB.data.duelDifficulty = difficulty;

  const players = {
    [sockA.id]: { name: sockA.data.playerName || "Player 1", playerId: sockA.data.playerId, finishedAtMs: null, elapsedMs: null },
    [sockB.id]: { name: sockB.data.playerName || "Player 2", playerId: sockB.data.playerId, finishedAtMs: null, elapsedMs: null }
  };

  sockA.data.duelPlayers = players;
  sockB.data.duelPlayers = players;
  sockA.data.duelSolution = solution;
  sockB.data.duelSolution = solution;
  sockA.data.duelStartAtMs = startAtMs;
  sockB.data.duelStartAtMs = startAtMs;
  sockA.data.duelOver = false;
  sockB.data.duelOver = false;

  io.to(sockA.id).emit("matchmaking:found", {
    matchId, difficulty, puzzle, solution, startAtMs,
    opponentName: sockB.data.playerName || "Player 2",
    playerSide: 1
  });
  io.to(sockB.id).emit("matchmaking:found", {
    matchId, difficulty, puzzle, solution, startAtMs,
    opponentName: sockA.data.playerName || "Player 1",
    playerSide: 2
  });

  broadcastQueueCounts();

  setTimeout(() => {
    io.to(matchId).emit("duel:start", { startAtMs });
  }, 0);
}

function beginDuelCPU(sock, difficulty, botTargetMs) {
  if (!sock) return;
  addGameSession("compete");
  const { puzzle, solution } = generatePuzzle(difficulty);
  const givenCount = puzzle.filter(v => v !== 0).length;
  const matchId = `${Date.now()}-${sock.id}-cpu`;
  const startAtMs = Date.now() + 2000;

  sock.join(matchId);

  sock.data.duelRoom = matchId;
  sock.data.duelDifficulty = difficulty;
  sock.data.duelIsBot = true;
  sock.data.duelGivenCount = givenCount;
  sock.data.duelBotTargetMs = botTargetMs;

  const players = {
    [sock.id]: { name: sock.data.playerName || "Player", playerId: sock.data.playerId, finishedAtMs: null, elapsedMs: null },
    cpu: { name: "Computer", playerId: null, finishedAtMs: null, elapsedMs: null }
  };

  sock.data.duelPlayers = players;
  sock.data.duelSolution = solution;
  sock.data.duelStartAtMs = startAtMs;
  sock.data.duelOver = false;

  io.to(sock.id).emit("matchmaking:found", {
    matchId, difficulty, puzzle, solution, startAtMs,
    opponentName: "🤖 Computer",
    opponentIsBot: true,
    botTargetMs,
    playerSide: 1
  });

  // Bot timer — fires after botTargetMs from startAtMs
  const botTimeout = setTimeout(() => {
    const s = io.sockets.sockets.get(sock.id);
    if (!s || s.data.duelOver) return;
    if (!s.data.duelPlayers?.cpu?.finishedAtMs) {
      s.data.duelPlayers.cpu.finishedAtMs = startAtMs + botTargetMs;
      s.data.duelPlayers.cpu.elapsedMs = botTargetMs;
      s.data.duelOver = true;

      // Save stats (loss) for player
      const stats = loadStats();
      const pid = s.data.playerId;
      if (pid) {
        if (!stats[pid]) stats[pid] = { practice: {}, compete: {} };
        if (!stats[pid].compete) stats[pid].compete = {};
        if (!stats[pid].compete[difficulty]) stats[pid].compete[difficulty] = { wins: 0, losses: 0, bestMs: null };
        stats[pid].compete[difficulty].losses++;
        saveStats(stats);
      }
      emitUnlocked(s);

      s.emit("duel:result", {
        won: false,
        myTime: null,
        opponentTime: botTargetMs,
        opponentName: "🤖 Computer",
        winnerName: "🤖 Computer",
        loserName: s.data.playerName || "Player",
        bot: true
      });
      cleanupSocketDuel(s);
    }
    botTimers.delete(matchId);
  }, botTargetMs + 2000);

  botTimers.set(matchId, botTimeout);

  setTimeout(() => {
    io.to(matchId).emit("duel:start", { startAtMs });
  }, 0);
}

function verifySolution(board, solution) {
  if (!Array.isArray(board) || board.length !== 81) return false;
  if (board.some(v => v === 0 || v === null || v === undefined)) return false;
  for (let i = 0; i < 81; i++) {
    if (Number(board[i]) !== Number(solution[i])) return false;
  }
  return true;
}

io.on("connection", (socket) => {
  lastHeartbeat.set(socket.id, Date.now());

  socket.on("presence:heartbeat", () => {
    lastHeartbeat.set(socket.id, Date.now());
  });

  socket.on("lobby:enter", ({ playerId, playerName }) => {
    socket.data.playerId = playerId;
    socket.data.playerName = playerName;
    lobbySockets.add(socket.id);
    broadcastCount();
    emitUnlocked(socket);

    const pending = pendingDisconnectResults.get(playerId);
    if (pending) {
      pendingDisconnectResults.delete(playerId);
      socket.emit("duel:youWereDisconnected", pending);
    }
  });

  socket.on("lobby:leave", () => {
    lobbySockets.delete(socket.id);
    const idx = matchQueue.findIndex(m => m.socketId === socket.id);
    if (idx !== -1) matchQueue.splice(idx, 1);
    broadcastCount();
  });

  socket.on("matchmaking:search", ({ difficulty, playerId, playerName }) => {
    const stats = loadStats();
    const level = getUnlockedLevel(stats, playerId);
    if (DIFFICULTIES.indexOf(difficulty) > level) {
      socket.emit("matchmaking:rejected", { message: "Level not unlocked" });
      return;
    }

    // 1. Try to match with existing queuers
    const opponent = tryMatch({ socketId: socket.id, difficulty, playerId, playerName });
    if (opponent) {
      beginDuel(socket, io.sockets.sockets.get(opponent.socketId), difficulty);
      return;
    }

    // 2. Add to queue
    const entry = { socketId: socket.id, difficulty, playerId, playerName };
    matchQueue.push(entry);
    socket.emit("matchmaking:queued");
    broadcastQueueCounts();

    // 3. Reverse-check: any EXISTING queuer whose search range includes this entry?
    //    (handles case where a higher-level player is already waiting)
    for (let i = 0; i < matchQueue.length; i++) {
      const q = matchQueue[i];
      if (q.socketId === entry.socketId) continue;
      if (searchRange(q.difficulty).includes(entry.difficulty)) {
        matchQueue.splice(i, 1);
        const eIdx = matchQueue.indexOf(entry);
        if (eIdx !== -1) matchQueue.splice(eIdx, 1);
        beginDuel(socket, io.sockets.sockets.get(q.socketId), q.difficulty);
        return;
      }
    }
  });

  socket.on("matchmaking:cancel", () => {
    const idx = matchQueue.findIndex(m => m.socketId === socket.id);
    if (idx !== -1) {
      matchQueue.splice(idx, 1);
      broadcastQueueCounts();
    }
    socket.emit("matchmaking:cancelled");
  });

  socket.on("matchmaking:playCPU", ({ difficulty, playerId, playerName }) => {
    // Remove from human queue if present
    const idx = matchQueue.findIndex(m => m.socketId === socket.id);
    if (idx !== -1) matchQueue.splice(idx, 1);
    broadcastQueueCounts();

    const stats = loadStats();
    const level = getUnlockedLevel(stats, playerId);
    if (DIFFICULTIES.indexOf(difficulty) > level) {
      socket.emit("matchmaking:rejected", { message: "Level not unlocked" });
      return;
    }

    socket.data.playerId = playerId;
    socket.data.playerName = playerName;
    const botTargetMs = getBotTime(difficulty);
    beginDuelCPU(socket, difficulty, botTargetMs);
  });

  socket.on("duel:boardForStats", ({ board }) => {
    if (!socket.data.duelIsBot || !socket.data.duelGivenCount) return;
    const difficulty = socket.data.duelDifficulty;
    const botTargetMs = socket.data.duelBotTargetMs;
    const estimatedMs = Math.round(botTargetMs * 1.15);
    recordHumanTime(difficulty, estimatedMs);
  });

  socket.on("duel:finish", ({ board }) => {
    if (socket.data.duelOver) return;
    const roomCode = socket.data.duelRoom;
    const players = socket.data.duelPlayers;
    const solution = socket.data.duelSolution;
    const startAtMs = socket.data.duelStartAtMs;
    const difficulty = socket.data.duelDifficulty;
    const isBot = socket.data.duelIsBot;
    if (!roomCode || !players || !solution) return;

    const player = players[socket.id];
    if (!player || player.finishedAtMs) return;

    const ok = verifySolution(board, solution);
    if (!ok) {
      socket.emit("duel:finishRejected", { message: "Board not correct." });
      return;
    }

    const now = Date.now();
    player.finishedAtMs = now;
    player.elapsedMs = Math.max(0, now - startAtMs);

    socket.data.duelOver = true;

    if (isBot) {
      // Cancel bot timer
      const bt = botTimers.get(roomCode);
      if (bt) { clearTimeout(bt); botTimers.delete(roomCode); }

      const cpuElapsed = players.cpu?.elapsedMs || Infinity;

      if (player.elapsedMs <= cpuElapsed) {
        io.to(socket.id).emit("duel:result", {
          won: true,
          myTime: player.elapsedMs,
          opponentTime: cpuElapsed === Infinity ? null : cpuElapsed,
          opponentName: "🤖 Computer",
          winnerName: socket.data.playerName || "Player",
          loserName: "🤖 Computer",
          bot: true
        });
      } else {
        io.to(socket.id).emit("duel:result", {
          won: false,
          myTime: player.elapsedMs,
          opponentTime: cpuElapsed,
          opponentName: "🤖 Computer",
          winnerName: "🤖 Computer",
          loserName: socket.data.playerName || "Player",
          bot: true
        });
      }

      // Record human time to improve bot average
      recordHumanTime(difficulty, player.elapsedMs);

      // Save stats for the player (wins/losses)
      const stats = loadStats();
      const pid = socket.data.playerId;
      if (pid) {
        if (!stats[pid]) stats[pid] = { practice: {}, compete: {} };
        if (!stats[pid].compete) stats[pid].compete = {};
        if (!stats[pid].compete[difficulty]) stats[pid].compete[difficulty] = { wins: 0, losses: 0, bestMs: null };
        if (player.elapsedMs <= cpuElapsed) {
          stats[pid].compete[difficulty].wins++;
          if (stats[pid].compete[difficulty].bestMs === null || player.elapsedMs < stats[pid].compete[difficulty].bestMs) {
            stats[pid].compete[difficulty].bestMs = player.elapsedMs;
          }
        } else {
          stats[pid].compete[difficulty].losses++;
        }
        saveStats(stats);
      }
      emitUnlocked(socket);
      cleanupSocketDuel(socket);
      return;
    }

    const allPlayers = Object.values(players);
    const finishedPlayers = allPlayers.filter(p => p.finishedAtMs).sort((a, b) => a.elapsedMs - b.elapsedMs);
    const winner = finishedPlayers[0];
    const loser = finishedPlayers[1] || allPlayers.find(p => p !== winner);

    io.to(socket.id).emit("duel:result", {
      won: true,
      myTime: winner.elapsedMs,
      opponentTime: null,
      winnerName: winner.name,
      opponentName: loser.name
    });

    const opponentSocket = Object.keys(players).find(sid => sid !== socket.id);
    if (opponentSocket) {
      const oppSock = io.sockets.sockets.get(opponentSocket);
      if (oppSock) {
        oppSock.data.duelOver = true;
        oppSock.emit("duel:result", {
          won: false,
          myTime: null,
          opponentTime: winner.elapsedMs,
          winnerName: winner.name,
          opponentName: loser.name
        });
      }
    }

    const stats = loadStats();
    for (const sid of Object.keys(players)) {
      const p = players[sid];
      const pid = p.playerId;
      if (!pid) continue;
      if (!stats[pid]) stats[pid] = { practice: {}, compete: {} };
      if (!stats[pid].compete) stats[pid].compete = {};
      if (!stats[pid].compete[difficulty]) stats[pid].compete[difficulty] = { wins: 0, losses: 0, bestMs: null };
      if (p === winner) {
        stats[pid].compete[difficulty].wins++;
        if (stats[pid].compete[difficulty].bestMs === null || p.elapsedMs < stats[pid].compete[difficulty].bestMs) {
          stats[pid].compete[difficulty].bestMs = p.elapsedMs;
        }
      } else {
        stats[pid].compete[difficulty].losses++;
      }
    }
    saveStats(stats);

    emitUnlocked(socket);
    if (opponentSocket) {
      const oppSock = io.sockets.sockets.get(opponentSocket);
      if (oppSock) emitUnlocked(oppSock);
    }

    delete socket.data.duelRoom;
    delete socket.data.duelPlayers;
    delete socket.data.duelSolution;
    delete socket.data.duelStartAtMs;
    delete socket.data.duelDifficulty;
    if (opponentSocket) {
      const oppSock = io.sockets.sockets.get(opponentSocket);
      if (oppSock) cleanupSocketDuel(oppSock);
    }
  });

  socket.on("disconnect", () => {
    lastHeartbeat.delete(socket.id);
    lobbySockets.delete(socket.id);
    broadcastCount();
    const idx = matchQueue.findIndex(m => m.socketId === socket.id);
    if (idx !== -1) {
      matchQueue.splice(idx, 1);
      broadcastQueueCounts();
    }
    const players = socket.data.duelPlayers;
    if (players && !socket.data.duelOver) {
      const oSid = Object.keys(players).find(sid => sid !== socket.id);
      const oName = oSid ? players[oSid]?.name || "Opponent" : "Opponent";
      const pid = socket.data.playerId;
      if (pid) {
        pendingDisconnectResults.set(pid, {
          won: false,
          myTime: null,
          opponentTime: null,
          winnerName: oName,
          opponentName: socket.data.playerName || "Player",
          disconnected: true
        });
      }
      if (oSid) {
        const oppSock = io.sockets.sockets.get(oSid);
        if (oppSock) {
          oppSock.emit("duel:opponentDisconnected");
          oppSock.data.duelOver = true;
          cleanupSocketDuel(oppSock);
        }
      }
    }
  });
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/puzzle", (req, res) => {
  const difficulty = req.query.difficulty || "Medium";
  addGameSession("practice");
  res.json(generatePuzzle(difficulty));
});

app.get("/stats/:playerId", (req, res) => {
  const stats = loadStats();
  res.json(stats[req.params.playerId] || { practice: {}, compete: {} });
});

app.post("/stats/practice", (req, res) => {
  const { playerId, difficulty, elapsedMs } = req.body;
  if (!playerId || !difficulty || !elapsedMs) return res.status(400).json({ error: "missing fields" });
  const stats = loadStats();
  if (!stats[playerId]) stats[playerId] = { practice: {}, compete: {} };
  if (!stats[playerId].practice) stats[playerId].practice = {};
  const prev = stats[playerId].practice[difficulty];
  if (!prev || elapsedMs < prev) stats[playerId].practice[difficulty] = elapsedMs;
  saveStats(stats);
  res.json({ ok: true, bestMs: stats[playerId].practice[difficulty] });
});

app.post("/analytics/leave", (req, res) => {
  const { action, view, elapsedMs, difficulty, noClicksAntes, tabClicksAntes } = req.body;
  if (!action || !view) return res.status(400).json({ error: "missing fields" });
  const stats = loadStats();
  if (!stats.leaveAnalytics) stats.leaveAnalytics = [];
  stats.leaveAnalytics.push({ action, view, elapsedMs, difficulty, noClicksAntes: noClicksAntes || 0, tabClicksAntes: tabClicksAntes || 0, ts: Date.now() });
  saveStats(stats);
  res.json({ ok: true });
});

app.get("/analytics/leave", (req, res) => {
  const stats = loadStats();
  res.json(stats.leaveAnalytics || []);
});

app.get("/analytics/sessions", (req, res) => {
  const stats = loadStats();
  res.json(stats.gameSessions || { practice: 0, compete: 0 });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));
