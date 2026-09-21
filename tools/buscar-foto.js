#!/usr/bin/env node
/**
 * buscar-foto.js — busca la mejor foto de un partido en la prensa argentina.
 *
 *   node buscar-foto.js 8                 todos los partidos de la fecha 8
 *   node buscar-foto.js 8 --game 2614479  un partido puntual
 *   node buscar-foto.js 8 --comp 384      Apertura
 *
 * Cómo funciona, y por qué así:
 *
 *   1. Entra por los SITEMAPS de noticias, no por un buscador. Es lo mismo que
 *      hace scripts/news-agent/lineups.mjs para las formaciones: el sitemap
 *      lista las notas de las últimas 48 h con su URL real, sin depender de que
 *      un buscador las haya indexado.
 *
 *   2. Abre cada nota en un navegador de verdad. Leer el HTML crudo no alcanza:
 *      los medios cargan las fotos con JavaScript y el HTML inicial trae una
 *      sola imagen. En el navegador aparecen todas.
 *
 *   3. Pide el ORIGINAL, no lo que muestra la nota. Los medios sirven un
 *      recorte de ~1200 px y guardan el original detrás de la misma URL sin el
 *      sufijo de tamaño. Medido en TyC: la nota muestra 1440x809 y el original
 *      es 3500x2386. Esa diferencia es la que decide si la placa se ve bien.
 *
 *   4. Puntúa y ordena. Gana la que mejor sobreviva al recorte vertical 4:5 de
 *      la placa, no la más grande en bruto.
 *
 * Deja las candidatas en fotos-partido/_candidatas/<game_id>/ y una hoja de
 * contactos para elegir. NO elige sola: la foto la elegís vos.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SUPABASE_URL = 'https://ketwxvbrhqbemlflmadu.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtldHd4dmJyaHFiZW1sZmxtYWR1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4NjA4MDcsImV4cCI6MjA4NjQzNjgwN30.-qXPLMSFEiRORNk5EUKrD16VDiMXtv-VfcDSWpzWzsg';

/* Los sitemaps de noticias. Los mismos dos que usa el agente de formaciones,
   mas los que probamos que responden. */
const SITEMAPS = [
  ['TyC',     'https://www.tycsports.com/sitemap_news_48hs.xml'],
  ['Olé',     'https://www.ole.com.ar/sitemaps/sitemap_google_news.xml'],
  ['DobleAm', 'https://www.dobleamarilla.com.ar/sitemap-news.xml'],
  ['LaNación','https://www.lanacion.com.ar/sitemap-news.xml'],
  ['UnoSF',   'https://www.unosantafe.com.ar/sitemap-news.xml'],
  ['Litoral', 'https://www.ellitoral.com/sitemaps/sitemap_google_news.xml'],
];

/* Cómo pedirle el original a cada CDN. Se prueban todas: la que devuelva algo
   más grande que el recorte, gana. */
/* Todas se aplican sobre la URL SIN la query: las notas la traen con ?v=1 y
   con eso el sufijo de tamaño deja de estar al final de la cadena. */
const A_ORIGINAL = [
  u => u.replace(/_\d{3,4}x\d{3,4}__1(?=\.\w+$)/, '_2000x1500__1'),  // Olé: el más grande que sirve
  u => u.replace(/_\d{3,4}x\d{3,4}__1(?=\.\w+$)/, '_1565x0__1'),     // El Litoral: idem
  u => u.replace(/_\d{3,4}x\d{3,4}(?=\.\w+$)/, ''),      // TyC: ..._862x485.webp
  u => u.replace(/-\d{3,4}x\d{3,4}(?=\.\w+$)/, ''),      // variante con guion
  u => u.replace(/\/\d{3,4}x\d{3,4}\/smart\//, '/'),      // C5N: /1200x675/smart/
  u => u.replace(/\/\d{3,4}x\d{3,4}\//, '/'),             // genérico: /1200x675/
  u => u.replace(/\/(w|width)_\d+[^/]*\//, '/'),          // Cloudinary y parecidos
];

/* Le saca la query y devuelve todas las formas de pedir el original. */
function candidatasOriginal(url) {
  const limpia = url.split('?')[0];
  const out = new Set([limpia]);
  A_ORIGINAL.forEach(fn => { const v = fn(limpia); if (v !== limpia) out.add(v); });
  return [...out];
}

const CHROMES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].filter(Boolean);

const RAIZ = path.resolve(__dirname, '..');
const dormir = ms => new Promise(r => setTimeout(r, ms));
const ahora = () => new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
const log = m => console.log('[' + ahora() + '] ' + m);

// ── Argumentos ────────────────────────────────────────────────────────
function args() {
  const a = process.argv.slice(2);
  const i = k => a.indexOf(k);
  return {
    matchday: parseInt(a.find(x => /^\d+$/.test(x)), 10),
    competition: i('--comp') >= 0 ? parseInt(a[i('--comp') + 1], 10) : 724,
    season: 2026,
    game: i('--game') >= 0 ? parseInt(a[i('--game') + 1], 10) : null,
    max: i('--max') >= 0 ? parseInt(a[i('--max') + 1], 10) : 8,
  };
}

// ── Los partidos de la fecha ──────────────────────────────────────────
async function partidos(cfg) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/v_fixtures?select=game_id,home_team_display,' +
    'away_team_display,home_score,away_score,match_date' +
    '&competition_id=eq.' + cfg.competition + '&season_id=eq.' + cfg.season +
    '&matchday=eq.' + cfg.matchday, {
      headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY },
    });
  if (!r.ok) throw new Error('no pude leer el fixture: HTTP ' + r.status);
  const filas = await r.json();
  return cfg.game ? filas.filter(f => f.game_id === cfg.game) : filas;
}

/* Apellidos de los que hicieron gol en el partido: la foto que los nombra
   sube en el ranking. */
async function goleadores(gameId) {
  const h = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Accept-Profile': 'winning_lpf' };
  try {
    const g = await (await fetch(SUPABASE_URL + '/rest/v1/goal_events?select=scorer_player_id&game_id=eq.' + gameId, { headers: h })).json();
    const ids = [...new Set((g || []).map(x => x.scorer_player_id).filter(Boolean))];
    if (!ids.length) return [];
    const p = await (await fetch(SUPABASE_URL + '/rest/v1/player_universe?select=last_name,known_name&player_id=in.(' + ids.join(',') + ')', { headers: h })).json();
    return (p || []).map(x => (x.last_name || (x.known_name || '').split(' ').pop() || '')).filter(Boolean);
  } catch (e) { return []; }
}
const sinAcentos = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/* Qué tan prometedora es una nota, por su URL: galería > goleador > resto. */
function pesoNota(slug, goles) {
  let p = 0;
  if (/galeria|fotos|imagenes/.test(slug)) p += 30;
  if ((goles || []).some(g => g.length >= 4 && slug.includes(sinAcentos(g)))) p += 20;
  if (/festej|gol|triunf|gano|victoria/.test(slug)) p += 5;
  if (/video|vivo|formacion|previa|arbitro|entrada/.test(slug)) p -= 15;
  return p;
}

/* "River Plate" -> ["river","plate"], sin las palabras que no distinguen. */
const RELLENO = new Set(['de', 'del', 'la', 'el', 'club', 'atletico', 'atlético', 'ca', 'aa', 'y']);
const palabras = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !RELLENO.has(w));

// ── Descargas ─────────────────────────────────────────────────────────
function bajarUnaVez(url, dest) {
  try {
    execSync(`curl -sL -A "${UA}" --max-time 30 "${url.replace(/"/g, '%22')}" -o "${dest}"`,
      { stdio: 'ignore', timeout: 35000 });
    return fs.existsSync(dest) && fs.statSync(dest).size > 800;
  } catch (e) { return false; }
}

/* Un fallo casi siempre es el CDN pidiendo aire, no un 404: se reintenta una
   vez con pausa antes de darla por perdida. */
async function bajar(url, dest, reintentar) {
  if (bajarUnaVez(url, dest)) return true;
  if (reintentar === false) return false;
  await dormir(2500);
  return bajarUnaVez(url, dest);
}

async function medir(archivo) {
  try {
    const sharp = require('sharp');
    const m = await sharp(archivo).metadata();
    return { w: m.width, h: m.height };
  } catch (e) { return null; }
}

/* Huella del archivo, para no guardar dos veces la misma foto. */
function md5(f) {
  return require('crypto').createHash('md5').update(fs.readFileSync(f)).digest('hex');
}

/* La placa es 1080x1350 (4:5). Puntúa cuánto sirve una foto para ese recorte. */
/* Criterios de Luchi: que se estire lo mínimo, y que sea del goleador o de
   lo destacado. La escala manda: una foto que no hay que agrandar siempre
   le gana a una que sí, y recién entre iguales decide el texto. */
function puntuar(w, h, texto, goles) {
  const anchoUtil = Math.min(w, h * 1080 / 1350);
  const altoUtil = anchoUtil * 1350 / 1080;
  if (altoUtil > h + 1) return null;
  const escala = 1080 / anchoUtil;            // <1 reduce, >1 amplía
  if (escala > 1.6) return null;              // más que eso ya es un póster pixelado
  const t = sinAcentos(texto);
  const goleador = (goles || []).some(g => g.length >= 4 && t.includes(sinAcentos(g)));
  const destacado = /festej|gol|celebr|abraz|grit|expuls|roja|ataj|figura/.test(t);
  // Escalones: sin estirar (>=1) > estira poco (<=1.2) > estira (<=1.6).
  const escalon = escala <= 1.001 ? 300 : escala <= 1.2 ? 200 : 100;
  const holgura = Math.min(3, 1 / escala) * 10;
  const nota = escalon + holgura + (goleador ? 40 : 0) + (destacado ? 15 : 0);
  return { escala, nota, anchoUtil: Math.round(anchoUtil), goleador, destacado };
}

// ── Main ──────────────────────────────────────────────────────────────
(async () => {
  const cfg = args();
  if (!cfg.matchday) {
    console.error('Uso: node buscar-foto.js <fecha> [--game <id>] [--comp 384]');
    process.exit(2);
  }

  const puppeteer = require('puppeteer-core');
  const chrome = CHROMES.find(p => { try { return fs.existsSync(p); } catch { return false; } });
  if (!chrome) { console.error('No encontré Chrome. Poné la ruta en CHROME_PATH.'); process.exit(2); }

  const juegos = await partidos(cfg);
  if (!juegos.length) { log('la fecha no tiene partidos'); return; }
  log((cfg.competition === 724 ? 'Clausura' : 'Apertura') + ' fecha ' + cfg.matchday +
      ': ' + juegos.length + ' partido(s)');

  // 1. Las notas de los sitemaps, una sola vez para toda la fecha.
  const tmp = path.join(RAIZ, 'fotos-partido', '_tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const notas = [];
  for (const [medio, sm] of SITEMAPS) {
    const f = path.join(tmp, 'sm.xml');
    if (!await bajar(sm, f)) { log(medio + ': no pude leer el sitemap'); continue; }
    const xml = fs.readFileSync(f, 'utf8');
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
    locs.forEach(u => notas.push({ medio, url: u, slug: u.toLowerCase() }));
    log(medio + ': ' + locs.length + ' notas en las últimas 48 h');
  }
  if (!notas.length) { log('sin notas para revisar'); return; }

  const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent(UA);

  for (const j of juegos) {
    // Al menos una palabra de CADA equipo. Contar palabras sueltas no sirve:
    // "River Plate" ya aporta dos y entraba cualquier nota del club.
    const local = palabras(j.home_team_display);
    const visita = palabras(j.away_team_display);
    const golesSlug = await goleadores(j.game_id);
    const candidatas = notas.filter(n =>
      local.some(k => n.slug.includes(k)) && visita.some(k => n.slug.includes(k))
    ).sort((a, b) => pesoNota(b.slug, golesSlug) - pesoNota(a.slug, golesSlug)).slice(0, 10);

    console.log('\n── ' + j.home_team_display + ' ' + (j.home_score ?? '') + '-' +
      (j.away_score ?? '') + ' ' + j.away_team_display + '  (' + j.game_id + ')');
    if (!candidatas.length) { console.log('   sin notas que nombren a los dos equipos'); continue; }
    console.log('   ' + candidatas.length + ' nota(s): ' +
      [...new Set(candidatas.map(c => c.medio))].join(', '));

    const goles = await goleadores(j.game_id);
    if (goles.length) console.log('   goleadores: ' + goles.join(', '));
    const fotos = [];
    const vistas = new Set();
    for (const c of candidatas) {
      let urls = [];
      try {
        await page.goto(c.url, { waitUntil: 'networkidle2', timeout: 40000 });
        // Bajar hasta el final: las fotos se cargan recién al aparecer en pantalla.
        await page.evaluate(async () => {
          for (let y = 0; y < document.body.scrollHeight; y += 600) {
            window.scrollTo(0, y); await new Promise(r => setTimeout(r, 120));
          }
        });
        await dormir(900);
        // Sin filtrar por el tamaño con que se ven: la nota las muestra
        // chicas y el original puede ser diez veces más grande. Se descartan
        // sólo los iconos y logos, por tamaño y por nombre.
        urls = await page.evaluate(() => {
          // Lo de afuera del cuerpo de la nota es mobiliario del sitio: la tapa
          // del diario, promos, notas relacionadas. Nunca es la foto del partido.
          const CUERPO = 'article, figure, main, [itemprop="articleBody"],' +
            '[class*="article"], [class*="nota"], [class*="story"], [class*="cuerpo"]';
          const titulo = (document.querySelector('h1') || {}).textContent || document.title || '';
          const aca = location.href.split(/[?#]/)[0];
          return [...document.images]
            .filter(i => i.naturalWidth >= 200 && i.naturalHeight >= 150)
            .filter(i => i.closest(CUERPO))
            // Miniatura de otra nota: está envuelta en un link que se va de acá.
            .filter(i => { const a = i.closest('a[href]'); return !a || a.href.split(/[?#]/)[0] === aca || /^#|javascript:/.test(a.getAttribute('href') || ''); })
            .map(i => ({ u: i.currentSrc || i.src,
                         texto: (i.alt || '') + ' ' + ((i.closest('figure') || {}).textContent || '') +
                           (i.closest('figure') ? ' ' + titulo : '') }))
            .filter(x => /^https?:/.test(x.u))
            .filter(x => !/logo|icon|avatar|escudo|sprite|placeholder|banner/i.test(x.u))
            .filter(x => !/tapa|portada|edicion|impresa|diario-de/i.test(x.u));
        });
      } catch (e) { continue; }

      const yaVistas = new Set();
      for (const { u, texto } of urls.filter(x => !yaVistas.has(x.u) && yaVistas.add(x.u)).slice(0, 20)) {
        // El original primero; si no hay, lo que muestra la nota.
        const intentos = candidatasOriginal(u);
        let mejor = null;
        for (const iu of intentos) {
          await dormir(1500);   // el CDN corta si se le pide todo de golpe
          const dest = path.join(tmp, 'c.img');
          if (!await bajar(iu, dest)) continue;
          const m = await medir(dest);
          if (!m) continue;
          if (!mejor || m.w * m.h > mejor.w * mejor.h) {
            mejor = { ...m, url: iu };
            fs.copyFileSync(dest, path.join(tmp, 'best_' + fotos.length + '.img'));
          }
          // Con el original en mano, el resto de las variantes sobra.
          if (mejor.w >= 1600) break;
        }
        if (!mejor) continue;
        const p = puntuar(mejor.w, mejor.h, texto, goles);
        if (!p) continue;
        // La misma foto aparece en varias notas del mismo medio. Se guarda una.
        const huella = md5(path.join(tmp, 'best_' + fotos.length + '.img'));
        if (vistas.has(huella)) continue;
        vistas.add(huella);
        fotos.push({ ...mejor, ...p, medio: c.medio, nota_url: c.url, texto: texto.trim().slice(0, 140),
                     archivo: path.join(tmp, 'best_' + fotos.length + '.img') });
      }
      await dormir(1200);
    }

    if (!fotos.length) { console.log('   no encontré fotos utilizables'); continue; }

    fotos.sort((a, b) => b.nota - a.nota);
    const elegidas = fotos.slice(0, cfg.max);
    const dir = path.join(RAIZ, 'fotos-partido', '_candidatas', String(j.game_id));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    elegidas.forEach((f, i) => {
      const ext = /\.png/i.test(f.url) ? '.png' : /\.webp/i.test(f.url) ? '.webp' : '.jpg';
      const nombre = String(i + 1).padStart(2, '0') + '_' + f.medio.replace(/\W/g, '') +
        '_' + f.w + 'x' + f.h + ext;
      try { fs.copyFileSync(f.archivo, path.join(dir, nombre)); f.nombre = nombre; } catch (e) {}
      console.log('   ' + String(i + 1).padStart(2) + '. ' + f.medio.padEnd(8) +
        (f.w + 'x' + f.h).padEnd(11) +
        (f.escala <= 1.001 ? 'no se estira ' : 'estira ' + f.escala.toFixed(2) + 'x').padEnd(14) +
        (f.goleador ? 'GOLEADOR ' : '') + (f.destacado ? 'destacado ' : '') +
        '· ' + f.texto.slice(0, 60));
    });

    // La mejor va derecho a la placa. Se guarda ya recortada a 1080x1350
    // (recorte centrado del 4:5), que es lo que la placa muestra.
    const mejorFoto = elegidas[0];
    if (mejorFoto) {
      try {
        const sharp = require('sharp');
        await sharp(mejorFoto.archivo)
          .resize(1080, 1350, { fit: 'cover', position: 'attention' })
          .jpeg({ quality: 92 })
          .toFile(path.join(RAIZ, 'fotos-partido', j.game_id + '.jpg'));
        console.log('   → elegida la 1: fotos-partido/' + j.game_id + '.jpg');
      } catch (e) { console.log('   no pude guardar la elegida: ' + e.message); }
    }

    hojaDeContactos(dir, j, elegidas);
  }

  await browser.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* Windows */ }
  console.log('\nCandidatas en fotos-partido/_candidatas/<game_id>/, con su revisar.html.');
  console.log('Elegí una y guardala como fotos-partido/<game_id>.jpg\n');
})().catch(e => { log('Error: ' + e.message); process.exit(1); });

// ── Hoja de contactos ─────────────────────────────────────────────────
function hojaDeContactos(dir, j, fotos) {
  const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<!doctype html><meta charset="utf-8">
<title>Fotos — ${esc(j.home_team_display)} vs ${esc(j.away_team_display)}</title>
<style>
 body{background:#111;color:#eee;font:14px/1.5 system-ui,sans-serif;margin:24px}
 h1{font-size:18px;color:#92B1DC}
 p{color:#888;max-width:75ch}
 .g{display:flex;flex-wrap:wrap;gap:18px;margin-top:20px}
 .c{width:270px;background:#1b1b24;border:1px solid #333;border-radius:8px;overflow:hidden}
 /* El marco muestra el recorte 4:5 real de la placa, no la foto entera:
    lo que importa es si la accion sobrevive a ese recorte. */
 .c .m{width:270px;height:337px;background:#000;display:block;object-fit:cover}
 .c div{padding:8px 10px;font-size:11px;color:#888}
 .c b{color:#fff;font-size:13px;display:block}
 .ok{color:#7ede9a}
</style>
<h1>${esc(j.home_team_display)} ${j.home_score ?? ''}-${j.away_score ?? ''} ${esc(j.away_team_display)}</h1>
<p>Cada marco muestra el <b>recorte vertical real</b> de la placa (1080×1350). Elegí una,
guardala como <code>fotos-partido/${j.game_id}.jpg</code> y listo.</p>
<div class="g">
${fotos.filter(f => f.nombre).map((f, i) => `  <figure class="c" style="margin:0">
    <img class="m" src="${esc(f.nombre)}">
    <div><b>${i + 1}. ${esc(f.medio)}</b>${f.w}×${f.h} —
      <span class="${f.escala <= 1 ? 'ok' : ''}">${f.escala <= 1
        ? 'sobra ' + (1 / f.escala).toFixed(1) + 'x'
        : 'amplía ' + f.escala.toFixed(2) + 'x'}</span><br>
      <a href="${esc(f.nota_url)}" target="_blank" style="color:#666">ver la nota</a></div>
  </figure>`).join('\n')}
</div>`;
  fs.writeFileSync(path.join(dir, 'revisar.html'), html);
}
