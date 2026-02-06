from __future__ import annotations

import time
import uuid
import random
from dataclasses import dataclass
from typing import List, Tuple, Dict, Set, Optional

from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

BOARD_N = 10
SHIP_SIZES = [2, 3, 5]
Coord = Tuple[int, int]


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
    start_time: float

    # Player's own ships live on player board
    player_ships: List[Ship]
    # Computer's ships live on computer board
    cpu_ships: List[Ship]

    # What each side has fired at
    player_fired: Set[Coord]  # shots into CPU board
    cpu_fired: Set[Coord]     # shots into Player board

    # Score
    player_hits: int
    player_misses: int
    cpu_hits: int
    cpu_misses: int

    over: bool

    def find_ship_at(self, ships: List[Ship], cell: Coord) -> Optional[Ship]:
        for s in ships:
            if cell in s.cells:
                return s
        return None


GAMES: Dict[str, GameState] = {}


def random_place_ships_no_adjacent() -> List[Ship]:
    occupied: Set[Coord] = set()
    ships: List[Ship] = []

    def can_place(cells: List[Coord]) -> bool:
        # Disallow overlap AND adjacency (including diagonals)
        for (r, c) in cells:
            if (r, c) in occupied:
                return False
            for nb in neighbors8((r, c)):
                if nb in occupied:
                    return False
        return True

    for size in SHIP_SIZES:
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
    """Apply a shot to the target fleet. Returns result + optional ring marks."""
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
        # if sunk, provide ring marks (not counted as fired)
        if ship.sunk:
            ring = ring_around(ship.cells)
            ring = {p for p in ring if p not in fired}
            ring_marks_payload = [{"row": r, "col": c} for (r, c) in ring]
        return {"result": "hit", "ring_marks": ring_marks_payload}

    return {"result": "miss", "ring_marks": []}


def pick_cpu_shot(game: GameState) -> Coord:
    """Very simple CPU: random untargeted square on player board."""
    while True:
        r = random.randrange(BOARD_N)
        c = random.randrange(BOARD_N)
        if (r, c) not in game.cpu_fired:
            return (r, c)


@app.post("/start")
def start():
    game_id = str(uuid.uuid4())

    player_ships = random_place_ships_no_adjacent()
    cpu_ships = random_place_ships_no_adjacent()

    GAMES[game_id] = GameState(
        game_id=game_id,
        start_time=time.time(),
        player_ships=player_ships,
        cpu_ships=cpu_ships,
        player_fired=set(),
        cpu_fired=set(),
        player_hits=0,
        player_misses=0,
        cpu_hits=0,
        cpu_misses=0,
        over=False,
    )

    return jsonify({
        "ok": True,
        "game_id": game_id,
        # We reveal ONLY the player's ship positions
        "player_ship_cells": ships_to_cells(player_ships),
    })


@app.post("/fire")
def fire():
    data = request.get_json(silent=True) or {}
    game_id = data.get("game_id")
    row = data.get("row")
    col = data.get("col")

    if not game_id or game_id not in GAMES:
        return jsonify({"ok": False, "error": "Invalid or missing game_id"}), 400

    game = GAMES[game_id]

    if game.over:
        elapsed = int(time.time() - game.start_time)
        return jsonify({
            "ok": True,
            "game_over": True,
            "winner": "player" if all_sunk(game.cpu_ships) else "cpu",
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

    # If player repeats, do NOT allow CPU to also shoot (keeps turn logic clean)
    if player_shot["result"] == "repeat":
        elapsed = int(time.time() - game.start_time)
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

    # Check if player won
    if all_sunk(game.cpu_ships):
        game.over = True
        elapsed = int(time.time() - game.start_time)
        return jsonify({
            "ok": True,
            "player_shot": {"row": row, "col": col, "result": player_shot["result"]},
            "player_ring_marks": player_shot["ring_marks"],
            "cpu_shot": None,
            "cpu_ring_marks": [],
            "game_over": True,
            "winner": "player",
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

    # Check if CPU won
    if all_sunk(game.player_ships):
        game.over = True
        elapsed = int(time.time() - game.start_time)
        return jsonify({
            "ok": True,
            "player_shot": {"row": row, "col": col, "result": player_shot["result"]},
            "player_ring_marks": player_shot["ring_marks"],
            "cpu_shot": {"row": cpu_r, "col": cpu_c, "result": cpu_shot["result"]},
            "cpu_ring_marks": cpu_shot["ring_marks"],
            "game_over": True,
            "winner": "cpu",
            "elapsed_seconds": elapsed,
            "player_hits": game.player_hits,
            "player_misses": game.player_misses,
            "cpu_hits": game.cpu_hits,
            "cpu_misses": game.cpu_misses,
        })

    elapsed = int(time.time() - game.start_time)
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
    return jsonify({"ok": True, "service": "battleship-v2-turn-based"})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5001, debug=True)
