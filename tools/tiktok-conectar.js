#!/usr/bin/env node
/**
 * tiktok-conectar.js — conecta la cuenta de TikTok de Winning con el repo (se hace
 * una vez por año: el token largo de TikTok dura 365 días). Corre en la compu, no
 * en Actions, porque el repo es público y el log de una corrida lo ve cualquiera.
 *
 *   node tiktok-conectar.js link       imprime el link de login de TikTok
 *   node tiktok-conectar.js <código>   canjea el código que muestra tiktok.html y
 *                                      guarda TIKTOK_REFRESH_TOKEN en los secretos
 *
 * Las claves de la app (TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET) se leen del
 * ambiente o de tools/tiktok.local.json, que no se sube al repo.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const local = path.join(__dirname, 'tiktok.local.json');
if (fs.existsSync(local)) Object.assign(process.env, { ...JSON.parse(fs.readFileSync(local, 'utf8')), ...process.env });
const tiktok = require('./tiktok.js');

const GH = fs.existsSync('C:\\Program Files\\GitHub CLI\\gh.exe') ? 'C:\\Program Files\\GitHub CLI\\gh.exe' : 'gh';
const REPO = 'luchi-dev/winning-recap';

function secreto(nombre, valor) {
  const r = spawnSync(GH, ['secret', 'set', nombre, '--repo', REPO], { input: valor, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`no pude guardar ${nombre} en GitHub: ${(r.stderr || '').trim()}`);
}

(async () => {
  const arg = process.argv[2];
  if (!arg) { console.error('uso: node tiktok-conectar.js link | <código>'); process.exit(2); }
  try {
    if (!process.env.TIKTOK_CLIENT_KEY) throw new Error('falta TIKTOK_CLIENT_KEY (en el ambiente o en tools/tiktok.local.json)');
    if (arg === 'link') { console.log(tiktok.linkLogin('winning-' + Date.now())); return; }
    // tiktok.html muestra el código tal cual; si se pega la dirección entera, se saca de ahí.
    const codigo = arg.includes('code=') ? new URL(arg).searchParams.get('code') : arg.trim();
    const d = await tiktok.tokensDesdeCodigo(codigo);
    if (!/video\.upload/.test(d.scope || '') ) console.log('[tiktok] ojo: la cuenta no dio permiso para subir videos (' + d.scope + ')');
    secreto('TIKTOK_CLIENT_KEY', process.env.TIKTOK_CLIENT_KEY);
    secreto('TIKTOK_CLIENT_SECRET', process.env.TIKTOK_CLIENT_SECRET);
    secreto('TIKTOK_REFRESH_TOKEN', d.refresh_token);
    console.log(`[tiktok] conectado (permisos: ${d.scope}); vence en ${Math.floor(d.refresh_expires_in / 86400)} días`);
  } catch (e) {
    console.error('[tiktok] ' + (e.message || e));
    process.exit(1);
  }
})();
