/**
 * redes.js — lo compartido para publicar placas del Recap en X, Instagram y
 * Facebook. Lo usan publicar-x.js, publicar-ig.js y publicar-auto.js.
 *
 *   imagenes(md, archivos, opciones)  las placas como JPG, desde la página
 *                                     publicada en Chrome sin cabeza (mismo PNG
 *                                     que "Descargar PNG", pasado a JPG)
 *   subirS3(jpg, nombre)              sube un JPG al S3 del sitio y devuelve su URL
 *   publicarX(texto, jpgs)            un posteo en X con hasta 4 imágenes
 *   publicarInstagram(caption, urls)  una foto o un carrusel (hasta 10) en Instagram
 *   publicarFacebook(caption, urls)   una o varias fotos en la página de Facebook
 *
 * Claves, siempre en el ambiente: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN,
 * X_ACCESS_SECRET · IG_USER_ID, IG_ACCESS_TOKEN · FB_PAGE_ID, FB_PAGE_TOKEN.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const COMPETITION = 724, SEASON = 2026;
const RAIZ = path.resolve(__dirname, '..');
const PAGINA = process.env.RECAP_URL || 'https://winning.com.ar/iloveneuquen/index.html';
const SITIO = 'https://winning.com.ar/iloveneuquen';
const BUCKET = process.env.BUCKET || 's3://winning-com-ar/iloveneuquen';
const GRAPH_IG = 'https://graph.instagram.com/v21.0';
const GRAPH_FB = 'https://graph.facebook.com/v21.0';

const log = m => console.log('[redes] ' + m);
const dormir = ms => new Promise(r => setTimeout(r, ms));

// ── Imágenes ──────────────────────────────────────────────────────────
function chromePath() {
  const CHROMES = [process.env.CHROME_PATH, '/usr/bin/google-chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].filter(Boolean);
  const c = CHROMES.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
  if (!c) throw new Error('no encontré Chrome (poné la ruta en CHROME_PATH)');
  return c;
}

/* archivos: nombres de placa tal como los usa "Descargar PNG" (data-filename):
   equipo_ideal_fecha10, ganadores_fecha10, mvps_fecha10, mvps_f10_sabado,
   resultado_f10_VEL_vs_TIG... opciones.game abre antes el partido (las placas
   de partido se arman al abrirlo), opciones.diseno elige 'nuevas' o 'antiguas'. */
async function imagenes(md, archivos, opciones = {}) {
  const puppeteer = require('puppeteer-core');
  const sharp = require('sharp');
  const browser = await puppeteer.launch({
    executablePath: chromePath(), headless: true, timeout: 120e3, protocolTimeout: 180e3, dumpio: !!process.env.CHROME_DEBUG,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-zygote', '--no-first-run', '--lang=es-AR'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: 1 });
    page.on('pageerror', e => log('error en la página: ' + e.message));
    await page.goto(PAGINA + '?v=' + Date.now(), { waitUntil: 'networkidle2', timeout: 90e3 });
    await page.evaluate((comp, season, md) => { currentComp = comp; currentSeason = season; return loadFecha(md); }, COMPETITION, SEASON, md);
    if (opciones.game) {
      await page.waitForFunction(() => typeof partidosDeLaFecha !== 'undefined' && partidosDeLaFecha && partidosDeLaFecha.matches && partidosDeLaFecha.matches.length, { timeout: 90e3 });
      await page.evaluate((g, d) => recapAbrirPartido(g, d), Number(opciones.game), opciones.diseno || 'nuevas');
    }
    const salida = [];
    for (const archivo of archivos) {
      await page.waitForSelector(`.card-wrapper[data-filename="${archivo}"]`, { timeout: 90e3 });
      await page.evaluate(() => document.fonts.ready);
      await dormir(2500);   // fotos y escudos que terminan de cargar
      const dataUrl = await page.evaluate(f => recapExportar(f), archivo);
      if (!dataUrl) throw new Error('la página no pudo exportar ' + archivo);
      const png = Buffer.from(dataUrl.split(',')[1], 'base64');
      // El PNG a 2x pesa ~8 MB; X acepta 5 e Instagram 8: va como JPG de alta calidad.
      salida.push(await sharp(png).flatten({ background: '#ffffff' }).jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer());
      log(`placa ${archivo}: ${Math.round(salida[salida.length - 1].length / 1024)} KB`);
    }
    return salida;
  } finally {
    await browser.close();
  }
}

function subirS3(jpg, nombre) {
  const local = path.join(RAIZ, 'captions', nombre);
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.writeFileSync(local, jpg);
  const r = spawnSync('aws', ['s3', 'cp', local, `${BUCKET}/captions/${nombre}`, '--content-type', 'image/jpeg', '--cache-control', 'no-cache', '--only-show-errors'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('no pude subir la imagen a S3: ' + (r.stderr || '').trim().slice(0, 200));
  return { url: `${SITIO}/captions/${nombre}`, local };
}

// ── X ─────────────────────────────────────────────────────────────────
async function publicarX(texto, jpgs) {
  const { TwitterApi } = require('twitter-api-v2');
  const { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET } = process.env;
  if (!X_API_KEY || !X_API_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_SECRET) throw new Error('faltan las claves de X en el ambiente (X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET)');
  if (texto.length > 280) throw new Error(`el texto tiene ${texto.length} caracteres y X permite 280`);
  const client = new TwitterApi({ appKey: X_API_KEY, appSecret: X_API_SECRET, accessToken: X_ACCESS_TOKEN, accessSecret: X_ACCESS_SECRET });
  const ids = [];
  for (const jpg of jpgs.slice(0, 4)) ids.push(await client.v1.uploadMedia(jpg, { mimeType: 'image/jpeg' }));
  const r = await client.v2.tweet({ text: texto, media: { media_ids: ids } });
  return 'https://x.com/i/status/' + (r.data && r.data.id);
}

// ── Instagram ─────────────────────────────────────────────────────────
async function graphIG(ruta, params, metodo = 'GET') {
  const url = new URL(GRAPH_IG + ruta);
  Object.entries({ ...params, access_token: process.env.IG_ACCESS_TOKEN }).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url, { method: metodo });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error('Instagram respondió ' + r.status + ': ' + JSON.stringify(d.error || d).slice(0, 300));
  return d;
}
async function esperarContenedor(id) {
  for (let i = 0; i < 40; i++) {
    const s = await graphIG(`/${id}`, { fields: 'status_code,status' }).catch(e => ({ status_code: 'SIN_ESTADO', status: e.message }));
    if (s.status_code === 'FINISHED') return;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error('Instagram no pudo procesar la imagen: ' + (s.status || s.status_code));
    await dormir(4000);
  }
}
/* urls: direcciones públicas de los JPG. Una sola → foto; varias → carrusel (hasta 10). */
async function publicarInstagram(caption, urls) {
  const { IG_USER_ID, IG_ACCESS_TOKEN } = process.env;
  if (!IG_USER_ID || !IG_ACCESS_TOKEN) throw new Error('faltan las claves de Instagram en el ambiente (IG_USER_ID, IG_ACCESS_TOKEN)');
  if (caption.length > 2200) throw new Error(`el caption tiene ${caption.length} caracteres e Instagram permite 2200`);
  let id;
  if (urls.length === 1) {
    id = (await graphIG(`/${IG_USER_ID}/media`, { image_url: urls[0], caption }, 'POST')).id;
    await esperarContenedor(id);
  } else {
    const hijos = [];
    for (const u of urls.slice(0, 10)) {
      const h = (await graphIG(`/${IG_USER_ID}/media`, { image_url: u, is_carousel_item: 'true' }, 'POST')).id;
      await esperarContenedor(h);
      hijos.push(h);
    }
    id = (await graphIG(`/${IG_USER_ID}/media`, { media_type: 'CAROUSEL', children: hijos.join(','), caption }, 'POST')).id;
    await esperarContenedor(id);
  }
  // Instagram a veces dice "not ready" (9007) aunque el contenedor figure listo: se espera y se reintenta.
  let p = null;
  for (let i = 0; i < 12 && !p; i++) {
    try { p = await graphIG(`/${IG_USER_ID}/media_publish`, { creation_id: id }, 'POST'); }
    catch (e) { if (!/9007|2207027|not ready|not available/i.test(e.message) || i === 11) throw e; log('Instagram: todavía no está listo, espero 10 s (' + (i + 1) + '/12)'); await dormir(10000); }
  }
  const info = await graphIG(`/${p.id}`, { fields: 'permalink' }).catch(() => ({}));
  return info.permalink || ('id ' + p.id);
}

// ── Facebook (página) ─────────────────────────────────────────────────
async function graphFB(ruta, params) {
  const r = await fetch(GRAPH_FB + ruta, { method: 'POST', body: new URLSearchParams({ ...params, access_token: process.env.FB_PAGE_TOKEN }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error('Facebook respondió ' + r.status + ': ' + JSON.stringify(d.error || d).slice(0, 300));
  return d;
}
async function publicarFacebook(caption, urls) {
  const { FB_PAGE_ID, FB_PAGE_TOKEN } = process.env;
  if (!FB_PAGE_ID || !FB_PAGE_TOKEN) return null;   // sin claves no se publica ahí, sin error
  if (urls.length === 1) {
    const d = await graphFB(`/${FB_PAGE_ID}/photos`, { url: urls[0], message: caption });
    return 'https://www.facebook.com/' + (d.post_id || d.id);
  }
  // Varias fotos: se suben sin publicar y se cuelgan de un solo posteo.
  const fotos = [];
  for (const u of urls) fotos.push((await graphFB(`/${FB_PAGE_ID}/photos`, { url: u, published: 'false' })).id);
  const params = { message: caption };
  fotos.forEach((id, i) => { params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id }); });
  const d = await graphFB(`/${FB_PAGE_ID}/feed`, params);
  return 'https://www.facebook.com/' + d.id;
}

module.exports = { imagenes, subirS3, publicarX, publicarInstagram, publicarFacebook, COMPETITION, SEASON, RAIZ, SITIO };
