@echo off
REM Publica esta carpeta en https://winning.com.ar/iloveneuquen/index.html
REM (bucket S3 winning-com-ar, prefijo iloveneuquen/, perfil AWS "iloveneuquen").
REM Sube solo lo que la pagina necesita: index.html, fuentes, iconos, escudos,
REM camisetas y fotos. No sube tools/, pruebas, logs ni scripts.
title Winning Recap - publicar
cd /d "%~dp0"
set AWS="C:\Program Files\Amazon\AWSCLIV2\aws.exe"
set BUCKET=s3://winning-com-ar/iloveneuquen

echo.
echo   WINNING RECAP - PUBLICAR
echo   ========================
echo.
echo   1/4  Fotos que el vigilante (GitHub) encontro solo
node "tools\traer-del-server.js"
if errorlevel 1 goto error

echo.
echo   2/4  Stub de redireccion (winning.com.ar/iloveneuquen)
%AWS% s3 cp "tools\iloveneuquen-stub.html" %BUCKET% --content-type "text/html" --cache-control "no-cache" --profile iloveneuquen
if errorlevel 1 goto error

echo.
echo   3/4  Pagina y assets
node "tools\lista-fotos.js"
%AWS% s3 sync . %BUCKET%/ --profile iloveneuquen --cache-control "no-cache" ^
  --exclude "*" ^
  --include "index.html" --include "historial.json" --include "especiales.json" --include "captions.json" --include "captions/*" --include "background.png" --include "logo-white.png" ^
  --include "badges/*" --include "escudos/*" --include "jerseys/*" --include "fonts/*" --include "icons/*" --include "fotos/*" ^
  --include "fotos-partido/*.jpg" --include "fotos-partido/elegidas.json" ^
  --exclude "fotos-partido/_*" --exclude "fotos/_*" --exclude "fotos/README.md" --exclude "fotos/revisar.html" --exclude "*/.gitignore"
if errorlevel 1 goto error

echo.
echo   4/4  Verificando
curl -s -o NUL -w "   HTTP %%{http_code}  https://winning.com.ar/iloveneuquen/index.html" https://winning.com.ar/iloveneuquen/index.html
echo.
echo.
echo   Listo. Si no ves el cambio en el navegador: Ctrl+Shift+R.
echo.
pause
exit /b 0

:error
echo.
echo   Fallo la publicacion. Revisar el mensaje de arriba.
echo   Si dice "could not be found" o "InvalidAccessKeyId": faltan o estan mal las credenciales en %USERPROFILE%\.aws\credentials
echo.
pause
exit /b 1
