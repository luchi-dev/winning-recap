@echo off
REM Pone al dia las fotos de la ultima fecha cerrada y abre la pagina.
title Winning Recap - no cerrar mientras uses la pagina
cd /d "%~dp0"

echo.
echo   WINNING RECAP
echo   =============
echo.
echo   Buscando caras nuevas de la ultima fecha...
echo   (puede tardar un minuto, es normal)
echo.

cd tools
call node cerrar-fecha.js --ultima --sin-placas
cd ..

echo.
echo   Abriendo http://localhost:8765
echo.
echo   DEJAR ESTA VENTANA ABIERTA mientras uses la pagina.
echo   Para apagarla: cerra esta ventana.
echo.

start "" http://localhost:8765
npx --yes http-server -p 8765 -c-1
