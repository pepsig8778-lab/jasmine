@echo off
REM ===========================================================================
REM  Конструктор "Acquista a distanza" — запуск localhost
REM  Двойной клик по этому файлу. Откроется на http://localhost:8000
REM ===========================================================================
cd /d "%~dp0"
set PORT=8000
echo.
echo   Конструктор скриншотов "Acquista a distanza"
echo   Адрес: http://localhost:%PORT%/index.html
echo   (закройте это окно, чтобы остановить сервер)
echo.
start "" "http://localhost:%PORT%/index.html"
python server.py %PORT%
