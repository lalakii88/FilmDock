@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 22 或更新版本，再运行此启动器。
  pause
  exit /b 1
)
if not exist "node_modules\electron\dist\electron.exe" (
  echo 首次启动正在安装依赖，请保持联网。
  call npm ci
  if errorlevel 1 (
    echo 依赖安装失败。请检查网络后重新运行。
    pause
    exit /b 1
  )
)
call npm start
if errorlevel 1 pause
