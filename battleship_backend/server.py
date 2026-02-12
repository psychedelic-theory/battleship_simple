from __future__ import annotations

import time
import uuid
import random
import os
import json
import threading
from dataclasses import dataclass
from typing import List, Tuple, Dict, Set, Optional

from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

BOARD_N = 10
SHIP_SIZES = [2, 3, 5]
# Setup placement order (largest to smallest)
SETUP_ORDER = [5, 3, 2]
Coord = Tuple[int, int]

# -----------------------------
# Persistent Scoreboard (JSON)
# -----------------------------
SCOREBOARD_PATH = os.path.join(os.path.dirname(__file__), "scoreboard.json")
SCOREBOARD_LOCK = threading.Lock()

def default_scoreboard() -> Dict:
    return {
        "games_played": 0,
        "wins": 0,
        "losses": 0,
        "player_hits": 0,
        "player_misses": 0,
        "cpu_hits": 0,
        "cpu_misses": 0,
        "fastest_win_seconds": None,  # int or None
    }

def load_scoreboard() -> Dict:
    if not os.path.exists(SCOREBOARD_PATH):
        return default_scoreboard()
    try:
        with open(SCOREBOARD_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        base = default_scoreboard()
        # merge so missing keys don't break
        for k in base:
            if k in data:
                base[k] = data[k]
        # basic type sanity
        if base["fastest_win_seconds"] is not None and not isinstance(base["fastest_win_seconds"], int):
            base["fastest_win_seconds"] = None
        return base
    except Exception:
        # if file is corrupt, fall back (no manual editing required)
        return default_scoreboard()

def save_scoreboard(data: Dict) -> None:
    # Atomic-ish write: write temp then replace
    tmp_path = SCOREBOARD_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp_path, SCOREBOARD_PATH)

def record_game_result(*, winner: str, elapsed_seconds: int, game: "GameState") -> None:
    """
    Server-authoritative scoreboard update.
    Called exactly once per game when it transitions to over.
    """
    with SCOREBOARD_LOCK:
        sb = load_scoreboard()

        sb["games_played"] += 1

        if winner == "player":
            sb["wins"] += 1
            # fastest win time only tracks player wins
            cur = sb["fastest_win_seconds"]
            if isinstance(elapsed_seconds, int) and elapsed_seconds >= 0:
                if cur is None or elapsed_seconds < cur:
                    sb["fastest_win_seconds"] = elapsed_seconds
        else:
            sb["losses"] += 1

        # totals across all completed games
        sb["player_hits"] += int(game.player_hits)
        sb["player_misses"] += int(game.player_misses)
        sb["cpu_hits"] += int(game.cpu_hits)
        sb["cpu_misses"] += int(game.cpu_misses)

        save_scoreboard(sb)


def in_bounds(r: int, c: int) -> bool:
    return 0 <= r < BOARD_N and 0 <= c < BOARD_N


def neighbors8(cell: Coord) -> List[Coord]:
    r, c = cell
    out = []
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            if dr == 0 and dc == 0:
                continue
            rr, cc = r + dr, c + dc
            if in_bounds(rr, cc):
                out.append((rr, cc))
    return out


def ring_around(ship_cells: Set[Coord]) -> Set[Coord]:
    ring = set()
    for cell in ship_cells:
        for nb in neighbors8(cell):
            if nb not in ship_cells:
                ring.add(nb)
    return ring


@dataclass
class Ship:
    cells: Set[Coord]
    hits: Set[Coord]

    @property
    def sunk(self) -> bool:
        return self.cells == self.hits


@dataclass
class GameState:
    game_id: str

    # phases: "setup" -> "play" -> "over"
    phase: str

    start_time: Optional[float]

    # Player and CPU fleets
    player_ships: List[Ship]
    cpu_ships: List[Ship]

    # What each side has fired at
    player_fired: Set[Coord]  # shots into CPU board
    cpu_fired: Set[Coord]     # shots into Player board

    # Score
    player_hits: int
    player_misses: int
    cpu_hits: int
    cpu_misses: int

    # Setup progress
    setup_index: int  # which ship in SETUP_ORDER is next

    # Prevent double-counting stats if /fire is called again after game over
    stats_recorded: bool = False

    @property
    def over(self) -> bool:
        return self.phase == "over"


GAMES: Dict[str, GameState] = {}


def random_place_ships_no_adjacent(sizes: List[int]) -> List[Ship]:
    occupied: Set[Coord] = set()
    ships: List[Ship] = []

    def can_place(cells: List[Coord]) -> bool:
        for (r, c) in cells:
            if (r, c) in occupied:
                return False
            for nb in neighbors8((r, c)):
                if nb in occupied:
                    return False
        return True

    for size in sizes:
        placed = False
        for _ in range(4000):
            horizontal = random.choice([True, False])
            if horizontal:
                r = random.randrange(BOARD_N)
                c = random.randrange(BOARD_N - size + 1)
                cells = [(r, c + i) for i in range(size)]
            else:
                r = random.randrange(BOARD_N - size + 1)
                c = random.randrange(BOARD_N)
                cells = [(r + i, c) for i in range(size)]

            if can_place(cells):
                sc = set(cells)
                ships.append(Ship(cells=sc, hits=set()))
                occupied |= sc
                placed = True
                break

        if not placed:
            raise RuntimeError("Failed to place ships (try again).")

    return ships


def ships_to_cells(ships: List[Ship]) -> List[Dict[str, int]]:
    out = []
    for s in ships:
        for (r, c) in s.cells:
            out.append({"row": r, "col": c})
    return out


def all_sunk(ships: List[Ship]) -> bool:
    return all(s.sunk for s in ships)


def apply_shot(ships: List[Ship], fired: Set[Coord], cell: Coord) -> Dict:
    if cell in fired:
        return {"result": "repeat", "ring_marks": []}

    fired.add(cell)

    ship = None
    for s in ships:
        if cell in s.cells:
            ship = s
            break

    ring_marks_payload = []
    if ship:
        ship.hits.add(cell)
        if ship.sunk:
            ring = ring_around(ship.cells)
            ring = {p for p in ring if p not in fired}
            ring_marks_payload = [{"row": r, "col": c} for (r, c) in ring]
        return {"result": "hit", "ring_marks": ring_marks_payload}

    return {"result": "miss", "ring_marks": []}


def pick_cpu_shot(game: GameState) -> Coord:
    while True:
        r = random.randrange(BOARD_N)
        c = random.randrange(BOARD_N)
        if (r, c) not in game.cpu_fired:
            return (r, c)


def can_place_player_ship(game: GameState, cells: List[Coord]) -> bool:
    # current occupied cells (player)
    occupied: Set[Coord] = set()
    for s in game.player_ships:
        occupied |= s.cells

    # overlap + adjacency + bounds
    for (r, c) in cells:
        if not in_bounds(r, c):
            return False
        if (r, c) in occupied:
            return False
        for nb in neighbors8((r, c)):
            if nb in occupied:
                return False

    return True


@app.get("/stats")
def stats():
    # Read-only endpoint; server is authority
    with SCOREBOARD_LOCK:
        sb = load_scoreboard()
    return jsonify({"ok": True, "scoreboard": sb})


@app.post("/new")
def new_game():
    """Create a new SETUP session. CPU ships are placed, player ships are empty."""
    game_id = str(uuid.uuid4())
    cpu_ships = random_place_ships_no_adjacent(SHIP_SIZES)

    GAMES[game_id] = GameState(
        game_id=game_id,
        phase="setup",
        start_time=None,
        player_ships=[],
        cpu_ships=cpu_ships,
        player_fired=set(),
        cpu_fired=set(),
        player_hits=0,
        player_misses=0,
        cpu_hits=0,
        cpu_misses=0,
        setup_index=0,
        stats_recorded=False,
    )

    return jsonify({
        "ok": True,
        "game_id": game_id,
        "phase": "setup",
        "next_ship_size": SETUP_ORDER[0],
        "setup_order": SETUP_ORDER,
        "player_ship_cells": [],  # none yet
    })


@app.post("/place")
def place():
    """
    Place one player ship during setup.
    Body: { game_id, row, col, horizontal }
    Places the NEXT ship size from SETUP_ORDER.
    """
    data = request.get_json(silent=True) or {}
    game_id = data.get("game_id")
    row = data.get("row")
    col = data.get("col")
    horizontal = data.get("horizontal")

    if not game_id or game_id not in GAMES:
        return jsonify({"ok": False, "error": "Invalid or missing game_id"}), 400

    game = GAMES[game_id]
    if game.phase != "setup":
        return jsonify({"ok": False, "error": "Not in setup phase"}), 400

    if not isinstance(row, int) or not isinstance(col, int) or not isinstance(horizontal, bool):
        return jsonify({"ok": False, "error": "Invalid placement payload"}), 400

    if game.setup_index >= len(SETUP_ORDER):
        return jsonify({"ok": False, "error": "All ships already placed"}), 400

    size = SETUP_ORDER[game.setup_index]
    cells: List[Coord] = []
    if horizontal:
        cells = [(row, col + i) for i in range(size)]
    else:
        cells = [(row + i, col) for i in range(size)]

    if not can_place_player_ship(game, cells):
        return jsonify({"ok": False, "error": "Invalid placement (overlap/adjacent/out-of-bounds)"}), 400

    ship_cells = set(cells)
    game.player_ships.append(Ship(cells=ship_cells, hits=set()))
    game.setup_index += 1

    setup_done = (game.setup_index >= len(SETUP_ORDER))
    next_size = None if setup_done else SETUP_ORDER[game.setup_index]

    return jsonify({
        "ok": True,
        "placed_cells": [{"row": r, "col": c} for (r, c) in cells],
        "player_ship_cells": ships_to_cells(game.player_ships),
        "setup_done": setup_done,
        "next_ship_size": next_size,
        "phase": game.phase,
    })


@app.post("/begin")
def begin():
    """Transition from setup -> play. Starts the clock."""
    data = request.get_json(silent=True) or {}
    game_id = data.get("game_id")

    if not game_id or game_id not in GAMES:
        return jsonify({"ok": False, "error": "Invalid or missing game_id"}), 400

    game = GAMES[game_id]
    if game.phase != "setup":
        return jsonify({"ok": False, "error": "Game is not in setup phase"}), 400

    if game.setup_index < len(SETUP_ORDER):
        return jsonify({"ok": False, "error": "Place all ships before starting"}), 400

    game.phase = "play"
    game.start_time = time.time()

    return jsonify({"ok": True, "phase": "play"})


@app.post("/fire")
def fire():
    data = request.get_json(silent=True) or {}
    game_id = data.get("game_id")
    row = data.get("row")
    col = data.get("col")

    if not game_id or game_id not in GAMES:
        return jsonify({"ok": False, "error": "Invalid or missing game_id"}), 400

    game = GAMES[game_id]

    if game.phase != "play":
        return jsonify({"ok": False, "error": "Game is not in play phase"}), 400

    if game.over:
        elapsed = int(time.time() - (game.start_time or time.time()))
        winner = "player" if all_sunk(game.cpu_ships) else "cpu"
        # If a game is over and hasn't been recorded yet (rare), record it.
        if not game.stats_recorded:
            record_game_result(winner=winner, elapsed_seconds=elapsed, game=game)
            game.stats_recorded = True

        return jsonify({
            "ok": True,
            "game_over": True,
            "winner": winner,
            "elapsed_seconds": elapsed,
            "player_hits": game.player_hits,
            "player_misses": game.player_misses,
            "cpu_hits": game.cpu_hits,
            "cpu_misses": game.cpu_misses,
        })

    if not isinstance(row, int) or not isinstance(col, int) or not in_bounds(row, col):
        return jsonify({"ok": False, "error": "Invalid coordinates"}), 400

    # -------- Player fires at CPU board --------
    player_cell = (row, col)
    player_shot = apply_shot(game.cpu_ships, game.player_fired, player_cell)

    if player_shot["result"] == "hit":
        game.player_hits += 1
    elif player_shot["result"] == "miss":
        game.player_misses += 1

    if player_shot["result"] == "repeat":
        elapsed = int(time.time() - (game.start_time or time.time()))
        return jsonify({
            "ok": True,
            "player_shot": {"row": row, "col": col, "result": "repeat"},
            "player_ring_marks": [],
            "cpu_shot": None,
            "cpu_ring_marks": [],
            "game_over": False,
            "elapsed_seconds": elapsed,
            "player_hits": game.player_hits,
            "player_misses": game.player_misses,
            "cpu_hits": game.cpu_hits,
            "cpu_misses": game.cpu_misses,
        })

    if all_sunk(game.cpu_ships):
        game.phase = "over"
        elapsed = int(time.time() - (game.start_time or time.time()))
        winner = "player"
        if not game.stats_recorded:
            record_game_result(winner=winner, elapsed_seconds=elapsed, game=game)
            game.stats_recorded = True

        return jsonify({
            "ok": True,
            "player_shot": {"row": row, "col": col, "result": player_shot["result"]},
            "player_ring_marks": player_shot["ring_marks"],
            "cpu_shot": None,
            "cpu_ring_marks": [],
            "game_over": True,
            "winner": winner,
            "elapsed_seconds": elapsed,
            "player_hits": game.player_hits,
            "player_misses": game.player_misses,
            "cpu_hits": game.cpu_hits,
            "cpu_misses": game.cpu_misses,
        })

    # -------- CPU fires at Player board --------
    cpu_r, cpu_c = pick_cpu_shot(game)
    cpu_shot = apply_shot(game.player_ships, game.cpu_fired, (cpu_r, cpu_c))

    if cpu_shot["result"] == "hit":
        game.cpu_hits += 1
    elif cpu_shot["result"] == "miss":
        game.cpu_misses += 1

    if all_sunk(game.player_ships):
        game.phase = "over"
        elapsed = int(time.time() - (game.start_time or time.time()))
        winner = "cpu"
        if not game.stats_recorded:
            record_game_result(winner=winner, elapsed_seconds=elapsed, game=game)
            game.stats_recorded = True

        return jsonify({
            "ok": True,
            "player_shot": {"row": row, "col": col, "result": player_shot["result"]},
            "player_ring_marks": player_shot["ring_marks"],
            "cpu_shot": {"row": cpu_r, "col": cpu_c, "result": cpu_shot["result"]},
            "cpu_ring_marks": cpu_shot["ring_marks"],
            "game_over": True,
            "winner": winner,
            "elapsed_seconds": elapsed,
            "player_hits": game.player_hits,
            "player_misses": game.player_misses,
            "cpu_hits": game.cpu_hits,
            "cpu_misses": game.cpu_misses,
        })

    elapsed = int(time.time() - (game.start_time or time.time()))
    return jsonify({
        "ok": True,
        "player_shot": {"row": row, "col": col, "result": player_shot["result"]},
        "player_ring_marks": player_shot["ring_marks"],
        "cpu_shot": {"row": cpu_r, "col": cpu_c, "result": cpu_shot["result"]},
        "cpu_ring_marks": cpu_shot["ring_marks"],
        "game_over": False,
        "elapsed_seconds": elapsed,
        "player_hits": game.player_hits,
        "player_misses": game.player_misses,
        "cpu_hits": game.cpu_hits,
        "cpu_misses": game.cpu_misses,
    })


@app.get("/health")
def health():
    return jsonify({"ok": True, "service": "battleship-v2-setup+turn-based"})


if __name__ == "__main__":
    # debug=True while developing; set to False for submission stability
    app.run(host="127.0.0.1", port=5001, debug=True)
