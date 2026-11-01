@echo off
title 提示词翻译台 - llama.cpp
cd /d "%~dp0"

set "NODE=%~dp0runtime\node.exe"
if exist "%NODE%" goto run
where node >nul 2>nul
if errorlevel 1 (
  echo [!] 没找到 node.exe。把它放进 runtime\ 目录，或安装 Node.js 后重试。
  pause
  exit /b 1
)
set "NODE=node"

:run
echo.
echo   提示词翻译台 · llama.cpp
echo   起好后用浏览器打开 http://127.0.0.1:8787（不会自动弹）
echo   这个窗口别关，关了服务就停。也可以直接用 提示词翻译台.exe。
echo.
"%NODE%" server.js

rem 点 X 关窗口时 Node 来不及收尾，这里兜底清掉它拉起的 llama-server
if exist "logs\child.pid" (
  for /f "usebackq delims=" %%p in ("logs\child.pid") do (
    taskkill /PID %%p /T /F >nul 2>&1
  )
  del "logs\child.pid" >nul 2>&1
)

echo.
echo 服务已退出。
pause
