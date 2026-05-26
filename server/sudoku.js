// Sudoku generator + solver with "count solutions up to 2" for uniqueness.

const SIZE = 9;
const BOX = 3;

function idx(r, c) { return r * SIZE + c; }

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function isValid(grid, r, c, n) {
  // row
  for (let cc = 0; cc < SIZE; cc++) if (grid[idx(r, cc)] === n) return false;
  // col
  for (let rr = 0; rr < SIZE; rr++) if (grid[idx(rr, c)] === n) return false;
  // box
  const br = Math.floor(r / BOX) * BOX;
  const bc = Math.floor(c / BOX) * BOX;
  for (let rr = br; rr < br + BOX; rr++) {
    for (let cc = bc; cc < bc + BOX; cc++) {
      if (grid[idx(rr, cc)] === n) return false;
    }
  }
  return true;
}

function findEmpty(grid) {
  for (let i = 0; i < 81; i++) if (grid[i] === 0) return i;
  return -1;
}

function solve(grid) {
  const pos = findEmpty(grid);
  if (pos === -1) return true;
  const r = Math.floor(pos / 9);
  const c = pos % 9;
  const nums = shuffle([1,2,3,4,5,6,7,8,9]);
  for (const n of nums) {
    if (isValid(grid, r, c, n)) {
      grid[pos] = n;
      if (solve(grid)) return true;
      grid[pos] = 0;
    }
  }
  return false;
}

function countSolutions(grid, limit = 2) {
  // backtracking count, stops at limit
  let count = 0;

  function bt() {
    if (count >= limit) return;
    const pos = findEmpty(grid);
    if (pos === -1) {
      count++;
      return;
    }
    const r = Math.floor(pos / 9);
    const c = pos % 9;
    for (let n = 1; n <= 9; n++) {
      if (isValid(grid, r, c, n)) {
        grid[pos] = n;
        bt();
        grid[pos] = 0;
        if (count >= limit) return;
      }
    }
  }

  bt();
  return count;
}

function makeSolvedGrid() {
  const grid = new Array(81).fill(0);
  solve(grid);
  return grid;
}

const DIFFICULTY_CLUES = {
  "Easy": 40,
  "Medium": 34,
  "Hard": 30,
  "Expert": 28,
  "Master": 26
};

function generateOnce(targetClues) {
  const solution = makeSolvedGrid();
  const puzzle = solution.slice();
  let clues = 81;

  if (targetClues < 80) {
    puzzle[40] = 0;
    clues--;
  }

  const allPairs = [];
  for (let i = 0; i < 40; i++) {
    allPairs.push([i, 80 - i]);
  }

  for (let pass = 0; pass < 3 && clues > targetClues; pass++) {
    const remaining = allPairs.filter(([a, b]) => puzzle[a] !== 0);
    shuffle(remaining);
    for (const [a, b] of remaining) {
      if (clues <= targetClues) break;
      const backupA = puzzle[a];
      const backupB = puzzle[b];
      puzzle[a] = 0;
      puzzle[b] = 0;
      const tmp = puzzle.slice();
      const solCount = countSolutions(tmp, 2);
      if (solCount !== 1) {
        puzzle[a] = backupA;
        puzzle[b] = backupB;
      } else {
        clues -= 2;
      }
    }
  }

  return { puzzle, solution };
}

export function generatePuzzle(difficulty = "Medium") {
  const targetClues = DIFFICULTY_CLUES[difficulty] ?? 34;
  const maxAttempts = targetClues <= 28 ? 3 : 1;

  let best = null;
  let bestClues = 81;

  for (let i = 0; i < maxAttempts; i++) {
    const result = generateOnce(targetClues);
    const clues = result.puzzle.filter(v => v !== 0).length;
    if (clues <= targetClues) return result;
    if (clues < bestClues) { best = result; bestClues = clues; }
  }

  return best;
}