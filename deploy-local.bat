@echo off
chcp 65001 >nul
setlocal
REM ============================================================
REM  BhandsMusic Web - local one-click deploy (for listeners)
REM  Everything runs on YOUR machine, no server bandwidth used.
REM  Requirement: Node.js LTS 18+  https://nodejs.org/zh-cn
REM
REM  Usage: double-click this file (or run in cmd).
REM  Daily use: just re-run it, deps are cached, done in seconds.
REM ============================================================

echo ============================================
echo   BhandsMusic Web 本地一键部署
echo ============================================
echo.

REM ---- [1/4] check Node.js ----
where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Node.js。
    echo 请先安装 Node.js LTS（18 或更高版本）: https://nodejs.org/zh-cn
    echo 安装完成后重新运行本脚本。
    pause
    exit /b 1
)
node -e "process.exit(parseInt(process.versions.node.split('.')[0])>=18?0:1)" || (
    echo [错误] Node.js 版本过低，需要 18 及以上，当前版本:
    node -v
    echo 请到 https://nodejs.org/zh-cn 安装 LTS 版本后重试。
    pause
    exit /b 1
)
for /f %%i in ('node -v') do set "NODE_V=%%i"
echo [1/4] Node.js %NODE_V% 检测通过

REM ---- [2/4] install dependencies ----
cd /d "%~dp0"
echo [2/4] 安装依赖（首次约 3~10 分钟，请耐心等待）...
call npm install --no-audit --no-fund --registry=https://registry.npmmirror.com || (
    echo [错误] 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
)
echo [2/4] 依赖就绪

REM ---- [3/4] build ----
echo [3/4] 构建前端与后端（约 1 分钟）...
call npm run build || (
    echo [错误] 构建失败，请截图此窗口反馈。
    pause
    exit /b 1
)
if not exist "apps\web\dist\index.html" (
    echo [错误] 未找到前端构建产物 apps\web\dist\index.html
    pause
    exit /b 1
)
if not exist "apps\server\dist\index.js" (
    echo [错误] 未找到后端构建产物 apps\server\dist\index.js
    pause
    exit /b 1
)
echo [3/4] 构建完成

REM ---- [4/4] start server in a new window ----
REM PORT=3001  HOST=127.0.0.1 (本机访问；如需局域网设备一起听改成 0.0.0.0)
REM SESSION_PERSIST=on  本地部署开启：重启后不用重新扫码登录
set "PORT=3001"
set "HOST=127.0.0.1"
set "SESSION_PERSIST=on"
cd /d "%~dp0apps\server"
echo [4/4] 启动服务（新窗口 BhandsMusic Server）...
start "BhandsMusic Server" cmd /k node dist\index.js
timeout /t 4 /nobreak >nul
start "" http://localhost:3001

echo.
echo ============================================
echo   部署完成！浏览器已打开 http://localhost:3001
echo.
echo   - 「BhandsMusic Server」窗口是服务本体，别关（关闭即停止）
echo   - 听歌走你自己的网络与音源，不占任何服务器带宽
echo   - 下次使用直接再双击本脚本（依赖已装好，几秒完成）
echo   - 微信扫码登录你的网易云账号即可听歌
echo ============================================
pause
exit /b 0
