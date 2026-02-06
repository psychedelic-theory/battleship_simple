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

const pHitsEl = document.getElementById("pHits");
const pMissesEl = document.getElementById("pMisses");
const cHitsEl = document.getElementById("cHits");
const cMissesEl = document.getElementById("cMisses");

const LETTERS = "ABCDEFGHIJ".split("");

// --- State ---
let gameId = null;

// phases
let inSetup = false;
let started = false;     // play started
let gameOver = false;
let awaitingTurn = false;

let clockTimer = null;
let localStartMs = null;

// placement
const SETUP_ORDER = [5, 3, 2];
let nextShipSize = null;
let horizontal = true; // spacebar toggles
let lastPreview = [];  // list of [r,c] cells

// --- Helpers ---
function pad2(n){ return String(n).padStart(2, "0"); }
function fmtTime(seconds){
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${pad2(m)}:${pad2(s)}`;
}
function setStatus(msg){ if(statusEl) statusEl.innerHTML = msg; }
function stopClock(){ if(clockTimer) clearInterval(clockTimer); clockTimer=null; }
function startClock(){
  stopClock();
  localStartMs = Date.now();
  clockTimer = setInterval(()=>{
    const elapsed = Math.floor((Date.now() - localStartMs) / 1000);
    if(clockEl) clockEl.textContent = fmtTime(elapsed);
  }, 250);
}
function setHud(pHits,pMisses,cHits,cMisses){
  if(pHitsEl) pHitsEl.textContent = pHits ?? 0;
  if(pMissesEl) pMissesEl.textContent = pMisses ?? 0;
  if(cHitsEl) cHitsEl.textContent = cHits ?? 0;
  if(cMissesEl) cMissesEl.textContent = cMisses ?? 0;
}
function coordLabel(r,c){ return `${LETTERS[r]}${c+1}`; }
function getCell(containerEl,r,c){
  return containerEl?.querySelector?.(`.cell[data-r="${r}"][data-c="${c}"]`) ?? null;
}
function clearContainer(containerEl){ if(containerEl) containerEl.innerHTML = ""; }

function setBoardEnabled(containerEl, enable){
  if(!containerEl) return;
  containerEl.querySelectorAll(".cell").forEach(cell=>{
    cell.classList.toggle("disabled", !enable);
  });
}

// CPU board gating
function setCpuBoardClickable(enable){
  setBoardEnabled(cpuGridWrap, enable && started && !gameOver);
}

// --- Grid Rendering ---
function buildGrid(containerEl, { clickable, onClick, onHover }){
  const table = document.createElement("table");
  table.className = "grid";

  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  const corner = document.createElement("th");
  corner.textContent = "";
  hr.appendChild(corner);
  for(let c=1;c<=10;c++){
    const th = document.createElement("th");
    th.textContent = c;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for(let r=0;r<10;r++){
    const tr = document.createElement("tr");
    const rowHead = document.createElement("th");
    rowHead.textContent = LETTERS[r];
    tr.appendChild(rowHead);

    for(let c=0;c<10;c++){
      const td = document.createElement("td");
      td.className = "cell disabled";
      td.dataset.r = String(r);
      td.dataset.c = String(c);
      td.title = coordLabel(r,c);

      if(clickable){
        td.addEventListener("click", () => onClick(td));
        td.addEventListener("mouseenter", () => onHover?.(td));
        td.addEventListener("mouseleave", () => onHover?.(null));
      }

      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  clearContainer(containerEl);
  containerEl.appendChild(table);
}

// --- Marking ---
function ensureXMark(cell){
  if(!cell) return;
  if(!cell.querySelector(".xMark")){
    const span = document.createElement("span");
    span.className = "xMark";
    span.textContent = "X";
    cell.appendChild(span);
  }
}

function markShot(containerEl, r, c, kind){
  const cell = getCell(containerEl, r, c);
  if(!cell) return;
  if(cell.classList.contains("hit")) return;

  cell.classList.remove("miss","ring");
  if(kind==="hit") cell.classList.add("hit");
  if(kind==="miss") cell.classList.add("miss");
  if(kind==="ring") cell.classList.add("ring");

  ensureXMark(cell);
  cell.classList.add("disabled");
}

function markPlayerShip(r,c){
  const cell = getCell(playerGridWrap, r, c);
  if(!cell) return;
  cell.classList.add("ship");
  cell.classList.remove("disabled"); // keep ships bright in setup/play
}

function clearPreview(){
  for(const [r,c] of lastPreview){
    const cell = getCell(playerGridWrap,r,c);
    if(cell){
      cell.classList.remove("preview","previewBad");
    }
  }
  lastPreview = [];
}

function computePreviewCells(anchorR, anchorC, size, horiz){
  const cells = [];
  for(let i=0;i<size;i++){
    const r = horiz ? anchorR : anchorR + i;
    const c = horiz ? anchorC + i : anchorC;
    cells.push([r,c]);
  }
  return cells;
}

function inBounds(r,c){ return r>=0 && r<10 && c>=0 && c<10; }

// --- API ---
async function apiNew(){
  const res = await fetch(`${API_BASE}/new`, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({})
  });
  const data = await res.json().catch(()=> ({}));
  if(!res.ok || !data.ok) throw new Error(data?.error || `New failed (HTTP ${res.status})`);
  return data;
}

async function apiPlace(row,col,horiz){
  const res = await fetch(`${API_BASE}/place`, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ game_id: gameId, row, col, horizontal: horiz })
  });
  const data = await res.json().catch(()=> ({}));
  if(!res.ok || !data.ok) throw new Error(data?.error || `Place failed (HTTP ${res.status})`);
  return data;
}

async function apiBegin(){
  const res = await fetch(`${API_BASE}/begin`, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ game_id: gameId })
  });
  const data = await res.json().catch(()=> ({}));
  if(!res.ok || !data.ok) throw new Error(data?.error || `Begin failed (HTTP ${res.status})`);
  return data;
}

async function apiFire(r,c){
  const res = await fetch(`${API_BASE}/fire`, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ game_id: gameId, row:r, col:c })
  });
  const data = await res.json().catch(()=> ({}));
  if(!res.ok || !data.ok) throw new Error(data?.error || `Fire failed (HTTP ${res.status})`);
  return data;
}

// --- Setup / Placement UI ---
function updateSetupStatus(){
  const orient = horizontal ? "Horizontal" : "Vertical";
  if(inSetup){
    setStatus(`Place ship size <b>${nextShipSize}</b> (${orient}). Press <b>Space</b> to rotate.`);
  }
}

function enterSetupMode(newGameData){
  gameId = newGameData.game_id;

  inSetup = true;
  started = false;
  gameOver = false;
  awaitingTurn = false;

  stopClock();
  if(clockEl) clockEl.textContent = "00:00";
  setHud(0,0,0,0);
  if(finalCard) finalCard.style.display = "none";

  // boards: player is clickable for placement, cpu board disabled until play begins
  buildGrid(playerGridWrap, { clickable:true, onClick:onPlayerPlaceClick, onHover:onPlayerHover });
  buildGrid(cpuGridWrap, { clickable:true, onClick:onCpuCellClick, onHover:null });

  setBoardEnabled(playerGridWrap, true);
  setCpuBoardClickable(false);

  horizontal = true;
  nextShipSize = newGameData.next_ship_size;

  clearPreview();
  updateSetupStatus();
}

async function onPlayerPlaceClick(cell){
  if(!inSetup) return;

  const r = Number(cell.dataset.r);
  const c = Number(cell.dataset.c);

  try{
    const data = await apiPlace(r,c,horizontal);

    // redraw ships from server truth
    // first clear all ship classes
    playerGridWrap.querySelectorAll(".cell").forEach(td => td.classList.remove("ship"));
    if(Array.isArray(data.player_ship_cells)){
      for(const p of data.player_ship_cells){
        markPlayerShip(p.row, p.col);
      }
    }

    clearPreview();

    if(data.setup_done){
      nextShipSize = null;
      inSetup = true; // still in setup until Start Game is pressed
      setStatus(`All ships placed! Press <b>Start Game</b> to begin.`);
    } else {
      nextShipSize = data.next_ship_size;
      updateSetupStatus();
    }
  } catch(e){
    // placement invalid: show error, keep setup mode
    setStatus(`Placement invalid: ${e.message}. Press <b>Space</b> to rotate and try again.`);
  }
}

function onPlayerHover(cell){
  if(!inSetup) return;
  clearPreview();

  if(!cell || !nextShipSize) return;

  const r = Number(cell.dataset.r);
  const c = Number(cell.dataset.c);

  const cells = computePreviewCells(r,c,nextShipSize,horizontal);
  lastPreview = cells;

  // local bounds check for preview coloring
  let ok = true;
  for(const [rr,cc] of cells){
    if(!inBounds(rr,cc)) ok = false;
  }

  for(const [rr,cc] of cells){
    const td = getCell(playerGridWrap, rr, cc);
    if(td){
      td.classList.add(ok ? "preview" : "previewBad");
    }
  }
}

// --- Play / Firing ---
function showGameOver(payload){
  gameOver = true;
  awaitingTurn = false;
  setCpuBoardClickable(false);
  stopClock();

  if(finalCard) finalCard.style.display = "block";

  const winnerLine =
    payload.winner === "player"
      ? "<b>Player wins!</b> You sank all enemy ships."
      : "<b>Computer wins!</b> Your fleet was sunk.";

  const elapsed = typeof payload.elapsed_seconds === "number" ? payload.elapsed_seconds : 0;

  if(finalText){
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

async function onCpuCellClick(cell){
  if(!started || gameOver) return;
  if(awaitingTurn) return;

  if(
    cell.classList.contains("hit") ||
    cell.classList.contains("miss") ||
    cell.classList.contains("ring")
  ){
    setStatus(`Already fired at <b>${cell.title}</b>. Try another square.`);
    return;
  }

  const r = Number(cell.dataset.r);
  const c = Number(cell.dataset.c);

  awaitingTurn = true;
  setCpuBoardClickable(false);
  setStatus(`Firing at <b>${coordLabel(r,c)}</b>...`);

  try{
    const data = await apiFire(r,c);
    setHud(data.player_hits, data.player_misses, data.cpu_hits, data.cpu_misses);

    if(data.player_shot){
      const ps = data.player_shot;
      if(ps.result==="hit"){
        markShot(cpuGridWrap, ps.row, ps.col, "hit");
        setStatus(`✅ You hit at <b>${coordLabel(ps.row, ps.col)}</b>.`);
      } else if(ps.result==="miss"){
        markShot(cpuGridWrap, ps.row, ps.col, "miss");
        setStatus(`🌊 You missed at <b>${coordLabel(ps.row, ps.col)}</b>.`);
      } else {
        setStatus(`Already fired there. Pick a new target.`);
        awaitingTurn = false;
        setCpuBoardClickable(true);
        return;
      }
    }

    if(Array.isArray(data.player_ring_marks)){
      for(const p of data.player_ring_marks){
        markShot(cpuGridWrap, p.row, p.col, "ring");
      }
    }

    if(data.cpu_shot){
      const cs = data.cpu_shot;
      if(cs.result==="hit") markShot(playerGridWrap, cs.row, cs.col, "hit");
      if(cs.result==="miss") markShot(playerGridWrap, cs.row, cs.col, "miss");

      if(Array.isArray(data.cpu_ring_marks)){
        for(const p of data.cpu_ring_marks){
          markShot(playerGridWrap, p.row, p.col, "ring");
        }
      }
    }

    if(data.game_over){
      showGameOver(data);
      return;
    }

    awaitingTurn = false;
    setCpuBoardClickable(true);
    setStatus(`Your turn. Fire at the computer board (e.g., <b>A1</b> to <b>J10</b>).`);
  } catch(e){
    console.error(e);
    awaitingTurn = false;
    setCpuBoardClickable(true);
    setStatus(`Could not fire. Check backend + CORS.`);
  }
}

// --- Button actions ---
function blankBoards(){
  inSetup = false;
  started = false;
  gameOver = false;
  awaitingTurn = false;
  gameId = null;

  stopClock();
  if(clockEl) clockEl.textContent = "00:00";
  setHud(0,0,0,0);
  if(finalCard) finalCard.style.display = "none";

  buildGrid(playerGridWrap, { clickable:false, onClick:null, onHover:null });
  buildGrid(cpuGridWrap, { clickable:true, onClick:onCpuCellClick, onHover:null });

  setBoardEnabled(playerGridWrap, false);
  setCpuBoardClickable(false);

  setStatus(`Click <b>New Game</b> to place ships, then <b>Start Game</b>.`);
}

async function onNewGame(){
  blankBoards();
  setStatus(`Creating setup session...`);
  try{
    const data = await apiNew();
    enterSetupMode(data);
  } catch(e){
    console.error(e);
    setStatus(`Could not create new game. Check backend + CORS.`);
  }
}

async function onStartGame(){
  // If currently playing, Start Game does nothing
  if(started && !gameOver){
    setStatus(`Game already running. Keep firing on the computer board.`);
    return;
  }

  // Must have a setup session
  if(!gameId || !inSetup){
    setStatus(`Click <b>New Game</b> first to place ships.`);
    return;
  }

  // Must have placed all ships
  if(nextShipSize !== null){
    updateSetupStatus();
    return;
  }

  try{
    await apiBegin();
    inSetup = false;
    started = true;
    gameOver = false;

    startClock();
    setCpuBoardClickable(true);
    setStatus(`Game started. Your turn: fire at the computer board (e.g., <b>A1</b> to <b>J10</b>).`);
  } catch(e){
    console.error(e);
    setStatus(`Could not start game: ${e.message}`);
  }
}

// --- Spacebar toggles orientation ---
window.addEventListener("keydown", (e) => {
  if(e.code === "Space"){
    // prevent page scroll
    e.preventDefault();
    if(!inSetup) return;
    horizontal = !horizontal;
    updateSetupStatus();

    // refresh preview if hovering over a cell
    // (cheap: just clear preview; next hover will redraw)
    clearPreview();
  }
});

// --- Wire buttons ---
startBtn?.addEventListener("click", onStartGame);
resetBtn?.addEventListener("click", onNewGame);

// --- Init: blank state until New Game ---
blankBoards();
