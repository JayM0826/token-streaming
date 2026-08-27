@echo off
setlocal
"%~dp0runtime\node.exe" "%~dp0dist\index.js" start
if errorlevel 1 pause
