#!/usr/bin/env node
/**
 * publicar-ig.js — publica en Instagram una placa del Recap con su caption.
 *
 *   node publicar-ig.js <fecha> <placa> [opcion] [--corta] [--texto "..."] [--probar]
 *
 *   placa    ideal | ganadores (igual que publicar-x.js)
 *   opcion   1..4 para el 11 Ideal, A/B para ganadores (por defecto el primero)
 *   --corta  usa la versión corta del caption (texto_corto) en vez de la completa
 *   --texto  caption propio (o la variable IG_TEXTO), en vez del de captions.json
 *   --probar arma y sube la imagen, muestra el caption, pero no publica
 *
 * Cómo publica Instagram desde afuera (API de Instagram con inicio de sesión de
 * Instagram): la imagen tiene que estar en una dirección pública, así que se
 * sube al mismo S3 de la página (captions/ig-<placa>-fecha<N>-<hora>.jpg);
 * después se crea un "contenedor" con esa URL y el caption, se espera a que
 * Instagram lo procese y se publica. Claves en el ambiente: IG_USER_ID (el id
 * de la cuenta profesional) e IG_ACCESS_TOKEN (token de larga duración, vence
 * a los 60 días: lo renueva .github/workflows/renovar-ig-token.yml).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { imagenDe } = require('./publicar-x.js');

const COMPETITION = 724, SEASON = 2026;
const RAIZ = path.resolve(__dirname, '..');
const BUCKET = process.env.BUCKET || 's3://winning-com-ar/iloveneuquen';
const SITIO = 'https://winning.com.ar/iloveneuquen';
const GRAPH = 'https://graph.instagram.com/v21.0';
const MAX_IG = 2200;

const log = m => console.log('[publicar-ig] ' + m);

function argumentos() {
  const a = process.argv.slice(2);
  const i = a.indexOf('--texto');
  return {
    md: Number(a[0]), placa: a[1],
    opcion: a[2] && !a[2].startsWith('--') ? a[2] : null,
    corta: a.includes('--corta'),
    texto: i >= 0 ? a[i + 1] : (process.env.IG_TEXTO || null),
    probar: a.includes('--probar'),
  };
}

function captionDe(md, placa, opcion, corta) {
  const todo = JSON.parse(fs.readFileSync(path.join(RAIZ, 'captions.json'), 'utf8'));
  const fecha = todo[`${COMPETITION}-${SEASON}-${md}`] || {};
  const lista = fecha[placa === 'ideal' ? 'ideal' : 'ganadores'] || [];
  if (!lista.length) throw new Error(`la fecha ${md} no tiene textos de ${placa} en captions.json`);
  let idx = 0;
  if (opcion) {
    idx = /^\d+$/.test(opcion) ? Number(opcion) - 1 : 'ABCD'.indexOf(opcion.toUpperCase());
    if (idx < 0 || idx >= lista.length) throw new Error(`opción ${opcion} no existe (hay ${lista.length})`);
  }
  const c = lista[idx];
  return ((corta && c.texto_corto) || c.texto || '').trim();
}

/* Sube la imagen al S3 de la página y devuelve su dirección pública. */
function subir(jpg, md, placa) {
  const nombre = `ig-${placa}-fecha${md}-${Date.now()}.jpg`;
  const local = path.join(RAIZ, 'captions', nombre);
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.writeFileSync(local, jpg);
  const r = spawnSync('aws', ['s3', 'cp', local, `${BUCKET}/captions/${nombre}`, '--content-type', 'image/jpeg', '--cache-control', 'no-cache', '--only-show-errors'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('no pude subir la imagen a S3: ' + (r.stderr || '').trim().slice(0, 200));
  return { url: `${SITIO}/captions/${nombre}`, local };
}

async function graph(ruta, params, metodo = 'GET') {
  const token = process.env.IG_ACCESS_TOKEN;
  const url = new URL(GRAPH + ruta);
  Object.entries({ ...params, access_token: token }).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url, { method: metodo });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error('Instagram respondió ' + r.status + ': ' + JSON.stringify(d.error || d).slice(0, 300));
  return d;
}

async function publicar(caption, imageUrl) {
  const { IG_USER_ID, IG_ACCESS_TOKEN } = process.env;
  if (!IG_USER_ID || !IG_ACCESS_TOKEN) throw new Error('faltan las claves de Instagram en el ambiente (IG_USER_ID, IG_ACCESS_TOKEN)');
  // 1. El contenedor: la imagen (por URL pública) y el caption
  const { id } = await graph(`/${IG_USER_ID}/media`, { image_url: imageUrl, caption }, 'POST');
  // 2. Esperar a que Instagram termine de bajar y procesar la imagen
  let listo = false;
  for (let i = 0; i < 40 && !listo; i++) {
    const s = await graph(`/${id}`, { fields: 'status_code,status' }).catch(e => ({ status_code: 'SIN_ESTADO', status: e.message }));
    log('contenedor ' + id + ': ' + (s.status_code || '?') + (s.status ? ' (' + s.status + ')' : ''));
    if (s.status_code === 'FINISHED') { listo = true; break; }
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error('Instagram no pudo procesar la imagen: ' + (s.status || s.status_code));
    await new Promise(r => setTimeout(r, 4000));
  }
  // 3. Publicar. Instagram a veces dice "Media ID is not available" (código 9007)
  // aunque el contenedor figure listo: es transitorio, se espera y se reintenta.
  let p = null;
  for (let i = 0; i < 12 && !p; i++) {
    try {
      p = await graph(`/${IG_USER_ID}/media_publish`, { creation_id: id }, 'POST');
    } catch (e) {
      if (!/9007|2207027|not ready|not available/i.test(e.message) || i === 11) throw e;
      log('todavía no está listo para publicar, espero 10 s (' + (i + 1) + '/12)...');
      await new Promise(r => setTimeout(r, 10000));
    }
  }
  const info = await graph(`/${p.id}`, { fields: 'permalink' }).catch(() => ({}));
  return info.permalink || ('id ' + p.id);
}

(async () => {
  const { md, placa, opcion, corta, texto, probar } = argumentos();
  if (!md || !['ideal', 'ganadores'].includes(placa)) {
    console.error('uso: node publicar-ig.js <fecha> <ideal|ganadores> [opcion] [--corta] [--texto "..."] [--probar]');
    process.exit(2);
  }
  try {
    const caption = (texto || captionDe(md, placa, opcion, corta)).trim();
    if (caption.length > MAX_IG) throw new Error(`el caption tiene ${caption.length} caracteres e Instagram permite ${MAX_IG}`);
    log(`caption (${caption.length} caracteres):\n${caption}\n`);
    log('armando la imagen desde la página publicada...');
    const jpg = await imagenDe(md, placa);
    const { url, local } = subir(jpg, md, placa);
    log(`imagen subida: ${url} (${Math.round(jpg.length / 1024)} KB)`);
    if (probar) { log('modo prueba: no se publica'); return; }
    const link = await publicar(caption, url);
    log('publicado en Instagram: ' + link);
    fs.unlinkSync(local);
  } catch (e) {
    console.error('[publicar-ig] ' + (e.message || e));
    process.exit(1);
  }
})();
