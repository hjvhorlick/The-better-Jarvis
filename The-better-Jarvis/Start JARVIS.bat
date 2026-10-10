@echo off
rem Double-click to set up (first time only) and start JARVIS on Windows.
cd /d "%~dp0"
set PY=
for %%V in (3.11 3.12 3.10) do if not defined PY (py -%%V -c "import sys" >nul 2>nul && set PY=py -%%V)
if not defined PY (where python >nul 2>nul && set PY=python)
if not defined PY (
  echo JARVIS needs Python 3.10, 3.11 or 3.12. Install it from python.org and tick "Add python.exe to PATH".
  pause
  exit /b 1
)
%PY% tools\start_jarvis.py %*
if errorlevel 1 pause
