#!/usr/bin/env node
/**
 * cerrar-fecha.js — deja las placas de una fecha listas, sin nadie mirando.
 *
 *   node cerrar-fecha.js 8              hace la fecha 8 del Clausura ahora
 *   node cerrar-fecha.js 8 --esperar    espera a que cierre el scoring y ahí arranca
 *   node cerrar-fecha.js 8 --comp 384   Apertura
 *   node cerrar-fecha.js 8 --salida D:/placas
 *
 * Encadena los tres pasos:
 *   1. Espera (si le pedís --esperar) a que exista el equipo ideal de la fecha.
 *      OJO: el disparador NO es el final del último partido, es el cierre del
 *      scoring. Medido sobre las fechas 1 a 7 del Clausura, eso pasa entre 2 y
 *      13 horas después del kickoff del último partido — a veces a los 15
 *      minutos del pitazo, a veces a la mañana siguiente.
 *   2. Baja y recorta las fotos que falten (bajar-fotos.js).
 *   3. Abre la página en Chrome headless y exporta TODAS las placas en PNG,
 *      las mismas que saca el botón "Descargar Todas".
 *
 * Las placas quedan en salida/<torneo>-fecha-<N>/.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SUPABASE_URL = 'https://ketwxvbrhqbemlflmadu.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtldHd4dmJyaHFiZW1sZmxtYWR1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4NjA4MDcsImV4cCI6MjA4NjQzNjgwN30.-qXPLMSFEiRORNk5EUKrD16VDiMXtv-VfcDSWpzWzsg';

const CHROMES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].filter(Boolean);

const RAIZ = path.resolve(__dirname, '..');           // website/recap
const PUERTO = 8799;                                   // propio, para no pisar el server que tengas abierto
const dormir = ms => new Promise(r => setTimeout(r, ms));
const ahora = () => new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
const log = m => console.log('[' + ahora() + '] ' + m);

// ── Argumentos ────────────────────────────────────────────────────────
function args() {
  const a = process.argv.slice(2);
  const num = a.find(x => /^\d+$/.test(x));
  const idx = k => a.indexOf(k);
  return {
    matchday: parseInt(num, 10),
    competition: idx('--comp') >= 0 ? parseInt(a[idx('--comp') + 1], 10) : 724,
    season: 2026,
    esperar: a.includes('--esperar'),
    // Cada cuánto pregunta si ya cerró, y hasta cuándo insiste.
    cadaMin: idx('--cada') >= 0 ? parseInt(a[idx('--cada') + 1], 10) : 10,
    horasMax: idx('--horas') >= 0 ? parseFloat(a[idx('--horas') + 1]) : 18,
    salida: idx('--salida') >= 0 ? a[idx('--salida') + 1] : path.join(RAIZ, 'salida'),
    sinFotos: a.includes('--sin-fotos'),
    // Con --sin-placas sólo deja las fotos listas: los flyers los arma la
    // página sola cuando entrás, no hace falta exportarlos a archivos.
    sinPlacas: a.includes('--sin-placas'),
    ultima: a.includes('--ultima'),
    soloFlyers: a.includes('--solo-flyers'),
  };
}

// ── ¿Ya está el equipo ideal? ─────────────────────────────────────────
async function recapDeLaFecha(cfg) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/rpc/get_matchday_recap', {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_competition_id: cfg.competition,
      p_season_id: cfg.season,
      p_matchday: cfg.matchday,
    }),
  });
  if (!r.ok) throw new Error('RPC HTTP ' + r.status);
  return r.json();
}

function estaLista(data) {
  const xi = data && data.winning_team;
  return !!(xi && xi.players && xi.players.length >= 11);
}

async function esperarLaFecha(cfg) {
  const limite = Date.now() + cfg.horasMax * 3600 * 1000;
  let vuelta = 0;
  while (Date.now() < limite) {
    vuelta++;
    try {
      const data = await recapDeLaFecha(cfg);
      if (estaLista(data)) { log('el equipo ideal ya está armado'); return data; }
      log(`todavía no está el equipo ideal (consulta ${vuelta}), reviso en ${cfg.cadaMin} min`);
    } catch (e) {
      log('no pude consultar (' + e.message + '), reintento en ' + cfg.cadaMin + ' min');
    }
    await dormir(cfg.cadaMin * 60 * 1000);
  }
  throw new Error(`pasaron ${cfg.horasMax} h y la fecha nunca cerró`);
}

// ── Fotos ─────────────────────────────────────────────────────────────
function bajarFotos(cfg) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, ['bajar-fotos.js', String(cfg.matchday), '--comp', String(cfg.competition)],
      { cwd: __dirname, stdio: 'inherit' });
    // Que falle bajando fotos no debe impedir las placas: se dibujan sin foto.
    p.on('close', code => resolve(code));
  });
}

// ── Servidor estático mínimo ──────────────────────────────────────────
const TIPOS = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.json': 'application/json', '.css': 'text/css',
  '.js': 'text/javascript' };

function servir() {
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const abs = path.join(RAIZ, rel);
    if (!abs.startsWith(RAIZ)) { res.writeHead(403).end(); return; }
    fs.readFile(abs, (err, buf) => {
      if (err) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': TIPOS[path.extname(abs).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store' });
      res.end(buf);
    });
  });
  return new Promise(r => srv.listen(PUERTO, () => r(srv)));
}

// ── Exportar las placas ───────────────────────────────────────────────
async function exportarPlacas(cfg, destino) {
  const puppeteer = require('puppeteer-core');
  const chrome = CHROMES.find(p => { try { return fs.existsSync(p); } catch { return false; } });
  if (!chrome) throw new Error('no encontré Chrome; poné la ruta en CHROME_PATH');

  fs.mkdirSync(destino, { recursive: true });
  const srv = await servir();
  const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1400 });
    const errores = [];
    page.on('pageerror', e => errores.push(e.message));

    await page.goto('http://localhost:' + PUERTO + '/index.html', { waitUntil: 'networkidle2' });
    await page.click(`.comp-btn[data-comp="${cfg.competition}"]`);
    await page.evaluate(n => {
      const b = [...document.querySelectorAll('.md-btn')].find(x => x.textContent.trim() === 'Fecha ' + n);
      if (!b) throw new Error('no existe el botón de la fecha ' + n);
      b.click();
    }, cfg.matchday);

    // Esperar a que rinda todo: pósters, MVPs, ganadores y las fichas.
    await page.waitForSelector('#postersContainer .card-pitch', { timeout: 90000 });
    await page.waitForSelector('#equipoIdealContainer .pcard', { timeout: 90000 }).catch(() => {});
    await page.waitForSelector('#mvpContainer .card-mvp', { timeout: 90000 }).catch(() => {});
    await dormir(6000);

    // Los nombres los arma la misma lógica que el botón "Descargar Todas".
    // Con --solo-flyers son nada mas los dos posters de cancha; si no, todo lo
    // que baja el boton "Descargar Todas".
    const selector = cfg.soloFlyers ? '.card-pitch' : '.card, .pcard';
    const cuantas = await page.evaluate(sel => document.querySelectorAll(sel).length, selector);
    log(`exportando ${cuantas} placas...`);

    let hechas = 0, fallidas = 0;
    for (let i = 0; i < cuantas; i++) {
      const r = await page.evaluate(async (idx, sel) => {
        const card = document.querySelectorAll(sel)[idx];
        if (!card) return { error: 'no está' };
        let nombre = card.dataset.filename;
        if (!nombre) {
          if (card.classList.contains('pcard')) nombre = 'player_' + idx;
          else {
            const sec = card.closest('.match-section');
            const h3 = sec && sec.querySelector('h3') ? sec.querySelector('h3').textContent : 'card';
            const tipo = card.classList.contains('card-resultado') ? 'resultado'
              : card.classList.contains('card-predicciones') ? 'predicciones' : 'fantasy';
            nombre = tipo + '_' + h3.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 40);
          }
        }
        // Capturamos el data URL en vez de dejar que el navegador lo baje.
        const clickOrig = HTMLAnchorElement.prototype.click;
        const alertOrig = window.alert;
        let href = null, err = null;
        window.alert = m => { err = m; };
        HTMLAnchorElement.prototype.click = function () { href = this.href; };
        try { await downloadCard(card, nombre); } catch (e) { err = e.message; }
        HTMLAnchorElement.prototype.click = clickOrig;
        window.alert = alertOrig;
        return { nombre, href, error: err };
      }, i, selector);

      if (r.href && r.href.startsWith('data:image/png')) {
        const limpio = String(r.nombre).replace(/[^\w.-]+/g, '_').slice(0, 90);
        fs.writeFileSync(path.join(destino, limpio + '.png'),
          Buffer.from(r.href.split(',')[1], 'base64'));
        hechas++;
      } else {
        fallidas++;
        log('  no salió: ' + (r.nombre || i) + ' — ' + (r.error || 'sin dataURL'));
      }
    }
    if (errores.length) log('errores de JS en la página: ' + errores.slice(0, 3).join(' | '));
    return { hechas, fallidas };
  } finally {
    await browser.close();
    srv.close();
  }
}

/* Cual es la ultima fecha con el scoring cerrado. Va de la 16 para atras y se
   queda con la primera que ya tenga equipo ideal. Sirve para que el acceso
   directo no tenga que saber en que fecha estamos. */
async function ultimaFechaCerrada(cfg) {
  for (let n = 16; n >= 1; n--) {
    try {
      const data = await recapDeLaFecha(Object.assign({}, cfg, { matchday: n }));
      if (estaLista(data)) return n;
    } catch (e) { /* si una consulta falla seguimos con la anterior */ }
  }
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────
(async () => {
  const cfg = args();
  if (cfg.ultima) {
    log('buscando la ultima fecha cerrada...');
    cfg.matchday = await ultimaFechaCerrada(cfg);
    if (!cfg.matchday) { log('todavia no cerro ninguna fecha'); return; }
    log('la ultima cerrada es la fecha ' + cfg.matchday);
  }
  if (!cfg.matchday) {
    console.error('Uso: node cerrar-fecha.js <fecha> [--esperar] [--comp 384] [--salida <dir>]');
    process.exit(2);
  }
  const torneo = cfg.competition === 724 ? 'clausura' : 'apertura';
  log(`${torneo} ${cfg.season}, fecha ${cfg.matchday}`);

  if (cfg.esperar) {
    log(`esperando el cierre del scoring (consulto cada ${cfg.cadaMin} min, hasta ${cfg.horasMax} h)`);
    await esperarLaFecha(cfg);
  } else {
    const data = await recapDeLaFecha(cfg);
    if (!estaLista(data)) {
      log('la fecha todavía no cerró: no hay equipo ideal. Corré con --esperar y se queda esperando.');
      process.exit(1);
    }
  }

  if (!cfg.sinFotos) {
    log('bajando las fotos que falten...');
    await bajarFotos(cfg);
  }

  if (cfg.sinPlacas) {
    log('fotos al día. Los flyers ya salen solos en http://localhost:8765');
    return;
  }

  const destino = path.join(cfg.salida, `${torneo}-fecha-${cfg.matchday}`);
  const r = await exportarPlacas(cfg, destino);

  log(`listo: ${r.hechas} placas en ${destino}` + (r.fallidas ? ` (${r.fallidas} no salieron)` : ''));
})().catch(e => { log('ERROR: ' + e.message); process.exit(1); });
