#!/usr/bin/env node
/**
 * publicar-x.js — publica en X (Twitter) una placa del Recap con su texto.
 *
 *   node publicar-x.js <fecha> <placa> [opcion] [--texto "..."] [--probar]
 *
 *   placa    ideal      póster del 11 Ideal (equipo_ideal_fechaN)
 *            ganadores  placa de Ganadores de la fecha (ganadores_fechaN)
 *   opcion   qué texto de captions.json usar: 1..4 para el 11 Ideal, A/B para
 *            ganadores (por defecto el primero). Se publica el 'texto_x' de esa
 *            opción (la versión de 280 caracteres); si la opción no tiene
 *            texto_x, se usa la versión corta recortada con puntos suspensivos.
 *   --texto  texto propio, en vez del de captions.json (o la variable X_TEXTO).
 *   --probar arma la imagen y muestra el texto, pero no publica (deja
 *            captions/x-<placa>-fecha<N>.jpg para mirarla).
 *
 * La imagen sale de la página publicada (winning.com.ar/iloveneuquen) abierta
 * en Chrome sin cabeza: es exactamente el PNG del botón "Descargar PNG"
 * (recapExportar en index.html). Las claves de X van en el ambiente, nunca en
 * un archivo: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET.
 */

const fs = require('fs');
const path = require('path');

const COMPETITION = 724, SEASON = 2026;
const RAIZ = path.resolve(__dirname, '..');
const PAGINA = process.env.RECAP_URL || 'https://winning.com.ar/iloveneuquen/index.html';
const MAX_X = 275;   // X corta en 280; margen por cómo cuenta emojis y acentos

const log = m => console.log('[publicar-x] ' + m);

function argumentos() {
  const a = process.argv.slice(2);
  const md = Number(a[0]);
  const placa = a[1];
  const opcion = a[2] && !a[2].startsWith('--') ? a[2] : null;
  const i = a.indexOf('--texto');
  return { md, placa, opcion, texto: i >= 0 ? a[i + 1] : (process.env.X_TEXTO || null), probar: a.includes('--probar') };
}

/* El texto de X para esa placa y opción, desde captions.json. */
function textoDe(md, placa, opcion) {
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
  if (c.texto_x) return c.texto_x.trim();
  const base = (c.texto_corto || c.texto || '').trim();
  return base.length <= MAX_X ? base : base.slice(0, MAX_X - 1).replace(/\s+\S*$/, '') + '…';
}

/* La placa como PNG, desde la página publicada en Chrome sin cabeza. */
async function imagenDe(md, placa) {
  const puppeteer = require('puppeteer-core');
  const CHROMES = [process.env.CHROME_PATH, '/usr/bin/google-chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].filter(Boolean);
  const chrome = CHROMES.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
  if (!chrome) throw new Error('no encontré Chrome (poné la ruta en CHROME_PATH)');
  const archivo = (placa === 'ideal' ? 'equipo_ideal_fecha' : 'ganadores_fecha') + md;

  // En el server de GitHub Chrome tarda en levantar y a veces no llega a avisar en
  // los 30 s por defecto: más tiempo, sin GPU ni zygote, y su salida en el log.
  const browser = await puppeteer.launch({
    executablePath: chrome, headless: true, timeout: 120e3, protocolTimeout: 180e3, dumpio: !!process.env.GITHUB_ACTIONS,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote', '--no-first-run', '--lang=es-AR'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: 1 });
    page.on('pageerror', e => log('error en la página: ' + e.message));
    await page.goto(PAGINA + '?v=' + Date.now(), { waitUntil: 'networkidle2', timeout: 90e3 });
    // Clausura 2026, fecha N: igual que elegirla en la página
    await page.evaluate((comp, season, md) => { currentComp = comp; currentSeason = season; return loadFecha(md); }, COMPETITION, SEASON, md);
    await page.waitForSelector(`.card-wrapper[data-filename="${archivo}"]`, { timeout: 90e3 });
    await page.evaluate(() => document.fonts.ready);
    await new Promise(r => setTimeout(r, 2500));   // fotos y escudos que terminan de cargar
    const dataUrl = await page.evaluate(f => recapExportar(f), archivo);
    if (!dataUrl) throw new Error('la página no pudo exportar la placa');
    const png = Buffer.from(dataUrl.split(',')[1], 'base64');
    // El PNG a 2x pesa ~8 MB y X acepta hasta 5 MB por foto: va como JPG de alta calidad.
    const sharp = require('sharp');
    return sharp(png).flatten({ background: '#ffffff' }).jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer();
  } finally {
    await browser.close();
  }
}

async function publicar(texto, png) {
  const { TwitterApi } = require('twitter-api-v2');
  const { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET } = process.env;
  if (!X_API_KEY || !X_API_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_SECRET) throw new Error('faltan las claves de X en el ambiente (X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET)');
  const client = new TwitterApi({ appKey: X_API_KEY, appSecret: X_API_SECRET, accessToken: X_ACCESS_TOKEN, accessSecret: X_ACCESS_SECRET });
  const mediaId = await client.v1.uploadMedia(png, { mimeType: 'image/jpeg' });
  const r = await client.v2.tweet({ text: texto, media: { media_ids: [mediaId] } });
  return r.data && r.data.id;
}

(async () => {
  const { md, placa, opcion, texto, probar } = argumentos();
  if (!md || !['ideal', 'ganadores'].includes(placa)) {
    console.error('uso: node publicar-x.js <fecha> <ideal|ganadores> [opcion] [--texto "..."] [--probar]');
    process.exit(2);
  }
  try {
    const t = (texto || textoDe(md, placa, opcion)).trim();
    if (t.length > 280) throw new Error(`el texto tiene ${t.length} caracteres y X permite 280`);
    log(`texto (${t.length} caracteres):\n${t}\n`);
    log('armando la imagen desde ' + PAGINA + '...');
    const png = await imagenDe(md, placa);
    const salida = path.join(RAIZ, 'captions', `x-${placa}-fecha${md}.jpg`);
    fs.mkdirSync(path.dirname(salida), { recursive: true });
    fs.writeFileSync(salida, png);
    log(`imagen lista: ${path.relative(RAIZ, salida)} (${Math.round(png.length / 1024)} KB)`);
    if (probar) { log('modo prueba: no se publica'); return; }
    const id = await publicar(t, png);
    log('publicado en X: https://x.com/i/status/' + id);
  } catch (e) {
    console.error('[publicar-x] ' + (e.data ? JSON.stringify(e.data) : (e.message || e)));
    process.exit(1);
  }
})();
