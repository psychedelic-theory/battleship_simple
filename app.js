// Battleship V2 (Turn-based, Two Boards)
// - Left: Player board (shows player ships + CPU shots)
// - Right: CPU board (hidden ships; player clicks to fire)
// - Turn: Player fires -> server resolves -> CPU fires -> server resolves -> back to player
// Server-truth: server decides hits/misses/sunk/game-over

const API_BASE = "http://127.0.0.1:5001";

// --- DOM ---
const playerGridWrap = document.getElementById("playerGridWrap");
const cpuGridWrap = document.getElementById("cpuGridWrap");

const startBtn = document.getElementById("startBtn");
const resetBtn = document.getElementById("resetBtn");
const statusEl = document.getElementById("status");

const clockEl = document.getElementById("clock");
const finalCard = document.getElementById("finalCard");
const finalText = document.getElementById("finalText");

// Scores (V2)
const pHitsEl = document.getElementById("pHits");
const pMissesEl = document.getElementById("pMisses");
const cHitsEl = document.getElementById("cHits");
const cMissesEl = document.getElementById("cMisses");

// --- Constants ---
const LETTERS = "ABCDEFGHIJ".split("");

// --- State ---
let gameId = null;
let started = false;
let gameOver = false;
let awaitingTurn = false; // prevents double-click spamming during request

let clockTimer = null;
let localStartMs = null;

// --- Helpers ---
function pad2(n) {
  return String(n).padStart(2, "0");
}

function fmtTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${pad2(m)}:${pad2(s)}`;
}

function setStatus(msg) {
  if (statusEl) statusEl.innerHTML = msg;
}

function stopClock() {
  if (clockTimer) clearInterval(clockTimer);
  clockTimer = null;
}

function startClock() {
  stopClock();
  localStartMs = Date.now();
  clockTimer = setInterval(() => {
    const elapsed = Math.floor((Date.now() - localStartMs) / 1000);
    if (clockEl) clockEl.textContent = fmtTime(elapsed);
  }, 250);
}

function setHud(pHits, pMisses, cHits, cMisses) {
  if (pHitsEl) pHitsEl.textContent = pHits ?? 0;
  if (pMissesEl) pMissesEl.textContent = pMisses ?? 0;
  if (cHitsEl) cHitsEl.textContent = cHits ?? 0;
  if (cMissesEl) cMissesEl.textContent = cMisses ?? 0;
}

function coordLabel(r, c) {
  return `${LETTERS[r]}${c + 1}`;
}

function getCell(containerEl, r, c) {
  return containerEl?.querySelector?.(`.cell[data-r="${r}"][data-c="${c}"]`) ?? null;
}

function clearContainer(containerEl) {
  if (containerEl) containerEl.innerHTML = "";
}

function setBoardEnabled(containerEl, enable, blockIfGameOver = true) {
  if (!containerEl) return;
  containerEl.querySelectorAll(".cell").forEach((cell) => {
    // we only truly disable interaction for the CPU board; player board is never clickable anyway
    cell.classList.toggle("disabled", !enable || (blockIfGameOver && gameOver));
  });
}

function setCpuBoardClickable(enable) {
  // CPU board controls player input, so we gate clicks with a global flag too
  setBoardEnabled(cpuGridWrap, enable);
}

// --- Grid Rendering ---
function buildGrid(containerEl, { clickable }) {
  const table = document.createElement("table");
  table.className = "grid";

  // Header row
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");

  const corner = document.createElement("th");
  corner.textContent = "";
  hr.appendChild(corner);

  for (let c = 1; c <= 10; c++) {
    const th = document.createElement("th");
    th.textContent = c;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);

  // Body
  const tbody = document.createElement("tbody");
  for (let r = 0; r < 10; r++) {
    const tr = document.createElement("tr");

    const rowHead = document.createElement("th");
    rowHead.textContent = LETTERS[r];
    tr.appendChild(rowHead);

    for (let c = 0; c < 10; c++) {
      const td = document.createElement("td");
      td.className = "cell disabled";
      td.dataset.r = String(r);
      td.dataset.c = String(c);
      td.title = coordLabel(r, c);

      if (clickable) {
        td.addEventListener("click", () => onCpuCellClick(td));
      } else {
        td.classList.add("disabled"); // always disabled visually
      }

      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  clearContainer(containerEl);
  containerEl.appendChild(table);
}

// --- Cell Marking ---
function ensureXMark(cell) {
  if (!cell) return;
  if (!cell.querySelector(".xMark")) {
    const span = document.createElement("span");
    span.className = "xMark";
    span.textContent = "X";
    cell.appendChild(span);
  }
}

/**
 * kind: "hit" | "miss" | "ring"
 * - hit: red X
 * - miss: green X
 * - ring: faded red X (blocks clicks on CPU board per your requirement)
 */
function markShot(containerEl, r, c, kind) {
  const cell = getCell(containerEl, r, c);
  if (!cell) return;

  // Don't overwrite a real hit with ring/miss
  if (cell.classList.contains("hit")) return;

  cell.classList.remove("miss", "ring");
  if (kind === "hit") cell.classList.add("hit");
  if (kind === "miss") cell.classList.add("miss");
  if (kind === "ring") cell.classList.add("ring");

  ensureXMark(cell);

  // Block interaction on CPU board for any marked square (including ring),
  // since you want ring markers to block clicks.
  cell.classList.add("disabled");
}

function markPlayerShip(r, c) {
  const cell = getCell(playerGridWrap, r, c);
  if (!cell) return;
  cell.classList.add("ship");
  cell.classList.remove("disabled"); // player ship cells are always visible and not disabled
}

// --- API ---
async function apiStart() {
  const res = await fetch(`${API_BASE}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data?.error || `Start failed (HTTP ${res.status})`);
  }
  return data;
}

async function apiFire(r, c) {
  const res = await fetch(`${API_BASE}/fire`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ game_id: gameId, row: r, col: c }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error(data?.error || `Fire failed (HTTP ${res.status})`);
  }
  return data;
}

// --- Game Over UI ---
function showGameOver(payload) {
  gameOver = true;
  awaitingTurn = false;

  setCpuBoardClickable(false);
  stopClock();

  if (finalCard) finalCard.style.display = "block";

  const winnerLine =
    payload.winner === "player"
      ? "<b>Player wins!</b> You sank all enemy ships."
      : "<b>Computer wins!</b> Your fleet was sunk.";

  const elapsed = typeof payload.elapsed_seconds === "number" ? payload.elapsed_seconds : 0;

  if (finalText) {
    finalText.innerHTML = `
      <div style="margin-bottom:8px">${winnerLine}</div>
      <div style="margin-bottom:6px">
        <b>Player:</b> ${payload.player_hits}/${payload.player_misses}
        &nbsp; | &nbsp;
        <b>CPU:</b> ${payload.cpu_hits}/${payload.cpu_misses}
      </div>
      <div><b>Game length:</b> ${fmtTime(elapsed)}</div>
    `;
  }

  setStatus(`Game over. ${winnerLine}`);
}

// --- CPU Board Click ---
async function onCpuCellClick(cell) {
  if (!started || gameOver) return;
  if (awaitingTurn) return;

  // Block clicks on already marked squares (hit/miss/ring)
  if (
    cell.classList.contains("hit") ||
    cell.classList.contains("miss") ||
    cell.classList.contains("ring")
  ) {
    setStatus(`Already fired at <b>${cell.title}</b>. Try another square.`);
    return;
  }

  const r = Number(cell.dataset.r);
  const c = Number(cell.dataset.c);

  awaitingTurn = true;
  setCpuBoardClickable(false);
  setStatus(`Firing at <b>${coordLabel(r, c)}</b>...`);

  try {
    const data = await apiFire(r, c);

    // Update HUD
    setHud(data.player_hits, data.player_misses, data.cpu_hits, data.cpu_misses);

    // Apply player shot to CPU board
    if (data.player_shot) {
      const ps = data.player_shot;
      if (ps.result === "hit") {
        markShot(cpuGridWrap, ps.row, ps.col, "hit");
        setStatus(`✅ You hit at <b>${coordLabel(ps.row, ps.col)}</b>.`);
      } else if (ps.result === "miss") {
        markShot(cpuGridWrap, ps.row, ps.col, "miss");
        setStatus(`🌊 You missed at <b>${coordLabel(ps.row, ps.col)}</b>.`);
      } else if (ps.result === "repeat") {
        setStatus(`Already fired there. Pick a new target.`);
        awaitingTurn = false;
        setCpuBoardClickable(true);
        return;
      }
    }

    // Ring marks from player's sunk on CPU board
    if (Array.isArray(data.player_ring_marks)) {
      for (const p of data.player_ring_marks) {
        markShot(cpuGridWrap, p.row, p.col, "ring");
      }
    }

    // Apply CPU shot to Player board
    if (data.cpu_shot) {
      const cs = data.cpu_shot;
      if (cs.result === "hit") {
        markShot(playerGridWrap, cs.row, cs.col, "hit");
        // Player ship cell stays visible; hit overlays X via markShot
      } else if (cs.result === "miss") {
        markShot(playerGridWrap, cs.row, cs.col, "miss");
      }

      // Ring marks from CPU sinking player ship on Player board
      if (Array.isArray(data.cpu_ring_marks)) {
        for (const p of data.cpu_ring_marks) {
          markShot(playerGridWrap, p.row, p.col, "ring");
        }
      }
    }

    if (data.game_over) {
      showGameOver(data);
      return;
    }

    // Back to player turn
    awaitingTurn = false;
    setCpuBoardClickable(true);
    setStatus(
      `Your turn. Fire at the computer board (e.g., <b>A1</b> to <b>J10</b>).`
    );
  } catch (e) {
    console.error(e);
    awaitingTurn = false;
    setCpuBoardClickable(true);
    setStatus(`Could not fire. Check backend + CORS.`);
  }
}

// --- Game Control ---
function resetUIOnly() {
  started = false;
  gameOver = false;
  awaitingTurn = false;
  gameId = null;

  stopClock();
  if (clockEl) clockEl.textContent = "00:00";

  setHud(0, 0, 0, 0);

  if (finalCard) finalCard.style.display = "none";

  // Rebuild both boards
  buildGrid(playerGridWrap, { clickable: false });
  buildGrid(cpuGridWrap, { clickable: true });

  // Disable CPU board until started
  setCpuBoardClickable(false);
  setStatus(`Press <b>Start Game</b> to begin.`);
}

async function startGame() {
  // Reset UI first so old marks disappear
  resetUIOnly();

  setStatus("Starting a new game (placing ships for both sides)...");
  try {
    const data = await apiStart();
    gameId = data.game_id;
    started = true;

    // Show player's ships
    if (Array.isArray(data.player_ship_cells)) {
      for (const p of data.player_ship_cells) {
        markPlayerShip(p.row, p.col);
      }
    }

    startClock();
    setCpuBoardClickable(true);

    setStatus(
      `Game started. Your turn: fire at the computer board (e.g., <b>A1</b> to <b>J10</b>).`
    );
  } catch (e) {
    console.error(e);
    setStatus(`Could not start game. Check backend + CORS.`);
  }
}

// --- Wire Buttons ---
startBtn?.addEventListener("click", startGame);
resetBtn?.addEventListener("click", () => {
  resetUIOnly(); // blank boards, stop clock, clear HUD
  setStatus(`Boards cleared. Press <b>Start Game</b> to begin.`);
});

// --- Init ---
resetUIOnly();