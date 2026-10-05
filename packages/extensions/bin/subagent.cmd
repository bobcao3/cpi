@echo off
setlocal

if "%CPI_RUNTIME_KIND%"=="" set "CPI_RUNTIME_KIND=node"
if "%CPI_RUNTIME_BIN%"=="" set "CPI_RUNTIME_BIN=%CPI_RUNTIME_KIND%"

if /I "%CPI_RUNTIME_KIND%"=="node" goto :node
if /I "%CPI_RUNTIME_KIND%"=="bun" goto :bun
if /I "%CPI_RUNTIME_KIND%"=="deno" goto :deno

echo Unknown CPI runtime kind: %CPI_RUNTIME_KIND% >&2
exit /b 1

:node
"%CPI_RUNTIME_BIN%" "%~dp0subagent.js" %*
goto :end

:bun
"%CPI_RUNTIME_BIN%" "%~dp0subagent.js" %*
goto :end

:deno
"%CPI_RUNTIME_BIN%" run --allow-all "%~dp0subagent.js" %*

:end
set "CPI_EXIT_CODE=%ERRORLEVEL%"
endlocal & exit /b %CPI_EXIT_CODE%
