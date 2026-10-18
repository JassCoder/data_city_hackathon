@echo off
rem Starts SkyRoute Warsaw. Double-click, or run: run.cmd  |  run.cmd -Docker  |  run.cmd -Down
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" %*
