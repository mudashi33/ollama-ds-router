@echo off
setlocal
cd /d "%~dp0"

if not exist ".env" (
  echo [ERROR] .env not found.
  echo Copy .env.example to .env and fill in DEEPSEEK_API_KEY / OLLAMA_API_KEY.
  pause
  exit /b 1
)

node --env-file=.env router.mjs
