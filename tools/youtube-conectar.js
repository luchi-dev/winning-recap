#!/usr/bin/env node
/**
 * youtube-conectar.js — conecta el canal de YouTube de Winning con el repo. Corre en
 * la compu, no en Actions, porque el repo es público y el log lo ve cualquiera.
 *
 *   node youtube-conectar.js        abre un puerto local, imprime el link de login de
 *                                   Google y, al volver, guarda los secretos del repo
 *
 * Las claves de la app (client_id y client_secret, tipo "Desktop app") se leen del
 * ambiente o de tools/youtube.local.json, que no se sube al repo:
 *   { "YOUTUBE_CLIENT_ID": "...", "YOUTUBE_CLIENT_SECRET": "..." }
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const local = path.join(__dirname, 'youtube.local.json');
if (fs.existsSync(local)) Object.assign(process.env, { ...JSON.parse(fs.readFileSync(local, 'utf8')), ...process.env });
const youtube = require('./youtube.js');

const GH = fs.existsSync('C:\\Program Files\\GitHub CLI\\gh.exe') ? 'C:\\Program Files\\GitHub CLI\\gh.exe' : 'gh';
const REPO = 'luchi-dev/winning-recap';
const ESPERA_MS = 10 * 60 * 1000;

// Deja cómo terminó en tools/youtube-conectar.log (no se sube al repo). Nunca anotar un token.
const registrar = m => fs.appendFileSync(path.join(__dirname, 'youtube-conectar.log'), `${new Date().toISOString()} ${m}\n`);

function secreto(nombre, valor) {
  const r = spawnSync(GH, ['secret', 'set', nombre, '--repo', REPO], { input: valor, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`no pude guardar ${nombre} en GitHub: ${(r.stderr || '').trim()}`);
}

/* Espera a que Google vuelva a http://127.0.0.1:<puerto> con el código. */
function esperarCodigo(state) {
  return new Promise((resolver, rechazar) => {
    const cierre = setTimeout(() => { srv.close(); rechazar(new Error('pasaron 10 minutos sin login')); }, ESPERA_MS);
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/') { res.writeHead(404).end(); return; }
      const error = u.searchParams.get('error');
      const codigo = u.searchParams.get('code');
      const valido = u.searchParams.get('state') === state;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<p style="font:18px sans-serif">${error || !codigo || !valido ? 'No se pudo conectar: volvé a la terminal.' : 'Listo, ya podés cerrar esta pestaña.'}</p>`);
      clearTimeout(cierre);
      srv.close();
      if (error) rechazar(new Error('Google no dio permiso: ' + error));
      else if (!valido) rechazar(new Error('la respuesta no corresponde a este login'));
      else if (!codigo) rechazar(new Error('Google no devolvió código'));
      else resolver(codigo);
    });
    srv.on('error', rechazar);
    srv.listen(0, '127.0.0.1', () => {
      const redirect = `http://127.0.0.1:${srv.address().port}`;
      esperarCodigo.redirect = redirect;
      const link = youtube.linkLogin(state, redirect);
      if (process.platform === 'win32') spawnSync('clip', { input: link });
      console.log('El link ya está copiado. Pegalo en el Chrome de Winning (Ctrl+V), elegí el canal y tocá Permitir.\nNo cierres esta ventana.\n\n' + link + '\n');
      registrar('esperando login');
    });
  });
}

(async () => {
  try {
    if (!process.env.YOUTUBE_CLIENT_ID || !process.env.YOUTUBE_CLIENT_SECRET) throw new Error('faltan YOUTUBE_CLIENT_ID y YOUTUBE_CLIENT_SECRET (en el ambiente o en tools/youtube.local.json)');
    const codigo = await esperarCodigo(crypto.randomBytes(16).toString('hex'));
    const d = await youtube.tokensDesdeCodigo(codigo, esperarCodigo.redirect);
    if (!d.refresh_token) throw new Error('Google no dio el token largo: sacar el acceso en myaccount.google.com/permissions y volver a conectar');
    if (!/youtube\.upload/.test(d.scope || '')) throw new Error('la cuenta no dio permiso para subir videos: volver a conectar tildando todo');
    const canal = await youtube.canalPropio(d.access_token);
    if (!canal) throw new Error('esa cuenta no tiene canal de YouTube: no se guardó nada');
    secreto('YOUTUBE_CLIENT_ID', process.env.YOUTUBE_CLIENT_ID);
    secreto('YOUTUBE_CLIENT_SECRET', process.env.YOUTUBE_CLIENT_SECRET);
    secreto('YOUTUBE_REFRESH_TOKEN', d.refresh_token);
    console.log(`[youtube] conectado: ${canal.nombre} ${canal.handle} (${canal.id})`);
    registrar(`conectado: ${canal.nombre} ${canal.handle} (${canal.id})`);
  } catch (e) {
    console.error('[youtube] ' + (e.message || e));
    registrar('error: ' + (e.message || e));
    process.exit(1);
  }
})();
