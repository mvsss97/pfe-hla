@echo off
rem Double-clic : active la traduction instantanee du lecteur PDF (une seule fois).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\activate-reader.ps1"
pause
