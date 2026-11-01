@echo off
title 停止提示词翻译台
cd /d "%~dp0"

echo 正在关掉应用服务（8787）和它拉起的 llama-server（8085）...

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do (
  taskkill /PID %%a /T /F >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8085" ^| findstr "LISTENING"') do (
  taskkill /PID %%a /T /F >nul 2>&1
)
if exist "logs\child.pid" (
  for /f "usebackq delims=" %%p in ("logs\child.pid") do taskkill /PID %%p /T /F >nul 2>&1
  del "logs\child.pid" >nul 2>&1
)

echo 完成。
timeout /t 2 >nul
