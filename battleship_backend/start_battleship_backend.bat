@echo on
setlocal

REM === Change this to your real backend folder ===
cd /d C:\xampp\htdocs\battleship_simple\battleship_backend
echo Current directory:
cd

REM === Print which Python is being used ===
where py
where python

REM === Start Flask and keep window open ===
py -3 server.py

echo.
echo If you see an error above, copy/paste it.
pause
