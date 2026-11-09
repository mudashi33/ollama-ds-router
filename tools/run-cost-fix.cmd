@echo off
rem Independent launcher: started via WMI so it is NOT a child of DeepSeek Harness
rem (killing DSH would otherwise kill this script too).
rem Usage: run-cost-fix.cmd [--delay 40] [--dry-run]
cd /d "%~dp0.."
node tools\apply-cost-fix.mjs %* >> cost-fix.log 2>&1
