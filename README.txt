Battleship Exam V3.0
NEW FEATURE: Persistent Scoreboard (JSON-Based Storage)
Description

A persistent scoreboard was implemented using a JSON file stored on the server.
The scoreboard tracks:
  Games Played
  Wins
  Losses
  Player Hits
  Player Misses
  CPU Hits
  CPU Misses
  Fastest Win Time (in seconds)

The scoreboard is displayed in the right sidebar of the UI and updates automatically:
  When the page loads
  After a completed game
  After refreshing the browser
  After restarting the backend server

Where State Lives (Architecture Explanation)
The persistent scoreboard follows the server-authoritative model:
Server (Authoritative):
  Determines winner
  Tracks hit/miss counts
  Computes elapsed game time
  Updates scoreboard values
  Writes to scoreboard.json
Exposes stats via GET /stats
Client (Display Only):
  Fetches /stats
  Renders values into the Scoreboard card
  Does NOT compute or modify statistics
Persistence Method:
  JSON file sored next to server.py
  File name: scoreboard.json
  Written only when a game transitions to the "over" phase
This ensures:
  Data persists across browser refresh
  Data persists after Flask restart
  No manual file editing required
  Server remains authoritative


Folder Structure (Submission Format)

battleship_simple/
  index.html
  app.js
  styles.css
  scoreboard.json (auto-generated after first completed game)
  server.py

If separated:

battleship_simple/
  battleship_backend/
    server.py
    scoreboard.json
  battleship_frontend/
    index.html
    app.js
    styles.css

Architecture Summary

This project demonstrates:
  Clear separation of client vs server responsibilities
  Explicit state transitions (SETUP → PLAY → OVER)
  Server-authoritative validation
  Persistent storage using JSON
  Clean integration of new features without breaking existing flow
  Incremental, architecture-driven development

BATTLESHIP V2+ (Web + Python Backend)
====================================

Overview
--------
This project is a web-based Battleship game with a Python (Flask) backend and an HTML/CSS/JS frontend.
The backend is "server-truth": the client UI never decides hits, misses, sinking, or winning. The
browser only sends actions to the server, and the server returns JSON results that the UI renders.

Frontend: HTML/CSS/JS (served via XAMPP/Apache)
Backend: Python + Flask (runs as a separate local server)\

Loom Recording Link: https://www.loom.com/share/cf54c11ea1644e698eb6df150d1a4d3f 

Two Major Iterations (Beyond Baseline)
-------------------------------------
Iteration #1: Two-Board Turn-Based Player vs Computer
- Changed the game from a single target board to TWO boards:
  (1) Player Board (left): shows the player's fleet and the computer's shots
  (2) Computer Board (right): the target grid where the player fires
- Added true turn-based flow:
  Player fires -> Server resolves -> Computer fires back -> Server resolves -> Next player turn
- Updated state management so BOTH boards and BOTH fleets are stored on the server.

Iteration #2: Player Ship Placement + Setup/Play Phases (Architecture Change)
- Replaced random player ship placement with a SETUP phase where the user places their own ships.
- Added explicit game phases:
  SETUP: player places ships in order (size 5, then 3, then 2)
  PLAY: player fires at the computer grid and the computer fires back
- Added spacebar rotation for placement:
  Press Space to toggle ship orientation (Horizontal / Vertical)
- Server enforces placement rules (in-bounds, no overlap, no adjacent ships).

Known Limitations / Notes
-------------------------
- The backend (Flask) must be running for the game to function. XAMPP serves the frontend, but it
  does not automatically run Python by itself.
- Computer AI uses a simple random targeting strategy (no advanced "hunt/target" logic).
- This is a local development setup (127.0.0.1). It is not configured for public hosting.

Requirements
------------
1) Install Python 3.10+ (Python 3.11/3.13 also works)
2) Install required Python modules for the backend:
   - flask
   - flask-cors

You can install dependencies with:
  py -3 -m pip install flask flask-cors

Folder Structure (Typical)
--------------------------
battleship_simple/
  battleship_backend/
    server.py
    start_battleship_backend.bat   (optional helper script)
  battleship_frontend/ (or directly inside XAMPP htdocs)
    index.html
    app.js
    styles.css

How to Run (Local with XAMPP + Flask)
-------------------------------------
Step 1: Start the Backend (Flask)
- Open PowerShell/Command Prompt in the backend folder (where server.py is):
  cd C:\xampp\htdocs\battleship_simple\battleship_backend

- Run:
  py -3 server.py

- Backend should print something like:
  Running on http://127.0.0.1:5001

Optional: Verify backend is running
- Open in browser:
  http://127.0.0.1:5001/health

Step 2: Start XAMPP / Serve the Frontend
- Start Apache in XAMPP.
- Place the frontend folder inside:
  C:\xampp\htdocs\

- Open the game in your browser (example):
  http://localhost/battleship_simple/

Gameplay Instructions (V2+)
---------------------------
1) Click "New Game"
   - Creates a new setup session (SETUP phase).
2) Place ships on the LEFT board in the required order (5 -> 3 -> 2).
   - Press Spacebar to rotate between Horizontal and Vertical.
   - Click to place the current ship.
3) After all ships are placed, click "Start Game"
   - Begins PLAY phase and starts the clock.
4) Click squares on the RIGHT (Computer) board to fire.
   - The server returns hit/miss results.
   - The computer fires back automatically each turn.
5) Game ends when one side’s ships are fully sunk.

Architecture Summary (Server-Truth)
-----------------------------------
Client -> POST /new     (creates setup session)
Client -> POST /place   (place next ship during SETUP)
Client -> POST /begin   (transition SETUP -> PLAY)
Client -> POST /fire    (player fires; server also computes CPU shot; returns JSON)
Server -> JSON results (hit/miss/sunk/ring markers/game-over)
Client updates UI based ONLY on the server response.

Troubleshooting
---------------
- If UI changes don’t seem to take effect:
  - Hard refresh the browser: Ctrl + Shift + R
- If the game cannot start or fire:
  - Ensure Flask is running and listening on port 5001
  - Ensure app.js API_BASE points to: http://127.0.0.1:5001
- If you changed server.py:
  - Restart the Flask server (Ctrl+C, then run again)

Credits
-------
Created as a Battleship web application assignment using vibe coding (AI-assisted development),
with emphasis on architecture, state management, and intentional iteration.
