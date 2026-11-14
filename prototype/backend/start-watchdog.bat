@echo off
rem start-watchdog.bat - launch backend watchdog detached (ASCII only)
rem Keeps port 8770 alive: probes /api/health every 30s, relaunches uvicorn if down.
rem Portable: uses script dir + python from PATH (override interpreter with COCKPIT_PYTHON).
setlocal
set "HERE=%~dp0"
cd /d "%HERE%"
if defined COCKPIT_PYTHON (set "PY=%COCKPIT_PYTHON%") else (set "PY=python")
start "" /B "%PY%" "%HERE%backend-watchdog.py" >> "%HERE%watchdog.log" 2>&1
endlocal
exit
