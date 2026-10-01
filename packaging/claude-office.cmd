@echo off
:: 베타 미검증: Windows 실제 설치 확인 전입니다(스펙 12장).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0claude-office.ps1" %*
