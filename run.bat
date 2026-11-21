@echo off
rem Safer Turns: build the Toronto road file (first run only) and open the app.
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python is not installed. Get it from https://www.python.org/downloads/ and tick "Add python.exe to PATH".
  pause
  exit /b 1
)
if not exist "web\roads\toronto.json" (
  echo First run: downloading Toronto roads and traffic signals from OpenStreetMap.
  echo This takes about 5 to 15 minutes. Later runs start straight away.
  python -m pip install --quiet requests
  python build_roads.py
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
echo.
echo Safer Turns is running at http://localhost:8765
echo To try it on your phone, connect to the same Wi-Fi and open http://YOUR-PC-IP:8765
echo Close this window to stop it.
start "" http://localhost:8765/
python -m http.server 8765 --directory web
