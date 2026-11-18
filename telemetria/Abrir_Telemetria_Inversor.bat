@echo off
setlocal
set "OPEN_BROWSER=--open"
if /i "%~1"=="--so-receptor" (
  set "OPEN_BROWSER="
  shift
)
set "FOC_HOST=%~1"
if not defined FOC_HOST (
  if exist "%USERPROFILE%\Downloads\foc-f28379d-fsae-main\foc-f28379d-fsae-main\foc_f28379d\host\foc_debug\link.py" (
    set "FOC_HOST=%USERPROFILE%\Downloads\foc-f28379d-fsae-main\foc-f28379d-fsae-main\foc_f28379d\host"
  ) else (
    set "FOC_HOST=%~dp0..\..\Am07-inversor-foc\foc_f28379d\host"
  )
)
if not exist "%FOC_HOST%\foc_debug\link.py" (
  echo Informe a pasta host do FOC como argumento deste arquivo.
  pause
  exit /b 1
)

if exist "%FOC_HOST%\.venv\Scripts\python.exe" (
  "%FOC_HOST%\.venv\Scripts\python.exe" "%~dp0receptor-inversor.py" "%FOC_HOST%" %OPEN_BROWSER%
) else (
  py -3 "%~dp0receptor-inversor.py" "%FOC_HOST%" %OPEN_BROWSER%
)
if errorlevel 1 pause
