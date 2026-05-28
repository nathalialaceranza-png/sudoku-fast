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

const matchQueue = [];
const lobbySockets = new Set();

function broadcastCount() {
  io.emit("lobby:count", lobbySockets.size);
}

function tryMatch(player) {
  const idx = matchQueue.findIndex(
    m => m.socketId !== player.socketId && m.difficulty === player.difficulty && !m.matched
  );
  if (idx === -1) return null;
  const opponent = matchQueue[idx];
  opponent.matched = true;
  return opponent;
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
  socket.on("lobby:enter", ({ playerId, playerName }) => {
    socket.data.playerId = playerId;
    socket.data.playerName = playerName;
    lobbySockets.add(socket.id);
    broadcastCount();
  });

  socket.on("lobby:leave", () => {
    lobbySockets.delete(socket.id);
    const idx = matchQueue.findIndex(m => m.socketId === socket.id);
    if (idx !== -1) matchQueue.splice(idx, 1);
    broadcastCount();
  });

  socket.on("matchmaking:search", ({ difficulty, playerId, playerName }) => {
    const entry = { socketId: socket.id, difficulty, playerId, playerName };
    const opponent = tryMatch(entry);
    if (opponent) {
      const { puzzle, solution } = generatePuzzle(difficulty);
      const matchId = `${Date.now()}-${socket.id}-${opponent.socketId}`;
      const startAtMs = Date.now() + 2000;

      socket.join(matchId);
      io.sockets.sockets.get(opponent.socketId)?.join(matchId);

      socket.data.duelRoom = matchId;
      socket.data.duelDifficulty = difficulty;
      io.sockets.sockets.get(opponent.socketId).data.duelRoom = matchId;
      io.sockets.sockets.get(opponent.socketId).data.duelDifficulty = difficulty;

      const players = {
        [socket.id]: { name: playerName || "Player 1", playerId, finishedAtMs: null, elapsedMs: null },
        [opponent.socketId]: { name: opponent.playerName || "Player 2", playerId: opponent.playerId, finishedAtMs: null, elapsedMs: null }
      };

      socket.data.duelPlayers = players;
      io.sockets.sockets.get(opponent.socketId).data.duelPlayers = players;
      socket.data.duelSolution = solution;
      io.sockets.sockets.get(opponent.socketId).data.duelSolution = solution;
      socket.data.duelStartAtMs = startAtMs;
      io.sockets.sockets.get(opponent.socketId).data.duelStartAtMs = startAtMs;
      socket.data.duelOver = false;
      io.sockets.sockets.get(opponent.socketId).data.duelOver = false;

      io.to(socket.id).emit("matchmaking:found", {
        matchId, difficulty, puzzle, solution, startAtMs,
        opponentName: opponent.playerName || "Player 2",
        playerSide: 1
      });
      io.to(opponent.socketId).emit("matchmaking:found", {
        matchId, difficulty, puzzle, solution, startAtMs,
        opponentName: playerName || "Player 1",
        playerSide: 2
      });

      setTimeout(() => {
        io.to(matchId).emit("duel:start", { startAtMs });
      }, 0);
    } else {
      matchQueue.push(entry);
      socket.emit("matchmaking:queued");
    }
  });

  socket.on("matchmaking:cancel", () => {
    const idx = matchQueue.findIndex(m => m.socketId === socket.id);
    if (idx !== -1) matchQueue.splice(idx, 1);
    socket.emit("matchmaking:cancelled");
  });

  socket.on("duel:finish", ({ board }) => {
    if (socket.data.duelOver) return;
    const roomCode = socket.data.duelRoom;
    const players = socket.data.duelPlayers;
    const solution = socket.data.duelSolution;
    const startAtMs = socket.data.duelStartAtMs;
    const difficulty = socket.data.duelDifficulty;
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

    const allPlayers = Object.values(players);
    const finishedPlayers = allPlayers.filter(p => p.finishedAtMs).sort((a, b) => a.elapsedMs - b.elapsedMs);
    const winner = finishedPlayers[0];
    const loser = finishedPlayers[1] || allPlayers.find(p => p !== winner);

    // Emit result to the winner
    io.to(socket.id).emit("duel:result", {
      won: true,
      myTime: winner.elapsedMs,
      opponentTime: null,
      winnerName: winner.name,
      opponentName: loser.name
    });

    // Mark opponent's duel as over and emit loss
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

    // Save stats
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

    delete socket.data.duelRoom;
    delete socket.data.duelPlayers;
    delete socket.data.duelSolution;
    delete socket.data.duelStartAtMs;
    delete socket.data.duelDifficulty;
  });

  socket.on("disconnect", () => {
    lobbySockets.delete(socket.id);
    broadcastCount();
    const idx = matchQueue.findIndex(m => m.socketId === socket.id);
    if (idx !== -1) matchQueue.splice(idx, 1);
    const players = socket.data.duelPlayers;
    if (players) {
      const opponentSocket = Object.keys(players).find(sid => sid !== socket.id);
      if (opponentSocket) {
        const oppSock = io.sockets.sockets.get(opponentSocket);
        if (oppSock) {
          oppSock.emit("duel:opponentDisconnected");
        }
      }
    }
  });
});

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/puzzle", (req, res) => {
  const difficulty = req.query.difficulty || "Medium";
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

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`Server on http://localhost:${PORT}`));
