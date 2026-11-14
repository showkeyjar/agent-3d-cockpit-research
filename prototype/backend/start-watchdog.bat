@echo off
rem start-watchdog.bat - launch backend watchdog detached (ASCII only)
rem Keeps port 8770 alive: probes /api/health every 30s, relaunches uvicorn if down.
cd /d "C:\Users\smith\WorkBuddy\2026-11-03-19-18-08\agent-3d-cockpit\backend"
start "" /B "D:\tools\Python312\python.exe" "C:\Users\smith\WorkBuddy\2026-11-03-19-18-08\agent-3d-cockpit\backend\backend-watchdog.py" >> "C:\Users\smith\WorkBuddy\2026-11-03-19-18-08\agent-3d-cockpit\backend\watchdog.log" 2>&1
exit
