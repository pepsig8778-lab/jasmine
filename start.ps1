# =============================================================================
#  Конструктор "Acquista a distanza" — запуск localhost (PowerShell)
#  Запуск:  powershell -ExecutionPolicy Bypass -File start.ps1
# =============================================================================
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot
$port = 8000
Write-Host ""
Write-Host "  Конструктор скриншотов 'Acquista a distanza'"
Write-Host "  Адрес: http://localhost:$port/index.html"
Write-Host "  (Ctrl+C чтобы остановить сервер)"
Write-Host ""
Start-Process "http://localhost:$port/index.html"
python server.py $port
