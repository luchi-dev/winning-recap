#!/usr/bin/env node
/* foto-jugador.js — fotos de JUEGO de cada jugador, para la ficha de jugador.

   La ficha no puede llevar la foto del partido: ahí aparece otro jugador o el
   plantel. Para cada jugador se buscan fotos suyas y sólo se acepta una si el
   título de la nota o el texto de la foto lo nombra (apellido). Orden:
     1. del partido (nota publicada después del pitazo que lo nombra),
     2. de los últimos 30 días con la camiseta del club (si del partido no hay).
   Si no hay ninguna que lo nombre, NO hay foto: la ficha sale sin foto, nunca
   con la genérica.

   Fuentes (las mismas que foto-fuentes.js, gratis y sin login, corren en server):
   Bing Noticias RSS + DuckDuckGo (og:image de cada nota, al tamaño original del
   CDN) y Bing Imágenes con Chrome sin cabeza.

   Uso:  node foto-jugador.js <game_id> [--ids 123,456] [--top 6] [--forzar]
         sin --ids: los 6 mejores puntajes de Winning del partido.
   Deja: fotos-jugador/<game_id>/<player_id>-op1..4.jpg
         fotos-jugador/elegidas.json  { game_id: { player_id: { nombre, opciones[] } } } */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const sharp = require('sharp');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SUPABASE_URL = 'https://ketwxvbrhqbemlflmadu.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtldHd4dmJyaHFiZW1sZmxtYWR1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4NjA4MDcsImV4cCI6MjA4NjQzNjgwN30.-qXPLMSFEiRORNk5EUKrD16VDiMXtv-VfcDSWpzWzsg';
const CHROME = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find(f => fs.existsSync(f));
const RAIZ = path.resolve(__dirname, '..');
const DEST = path.join(RAIZ, 'fotos-jugador');
const TMP = path.join(DEST, '_tmp');
const OPCIONES = 4;
const MAX_NOTAS = 10;

const dormir = ms => new Promise(r => setTimeout(r, ms));
const conTiempo = (pr, ms, que) => Promise.race([pr, new Promise((_, rj) => setTimeout(() => rj(new Error('se pasó de ' + ms / 1000 + 's: ' + que)), ms))]);
const log = m => console.log('[' + new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }) + '] ' + m);
const sinAcentos = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const host = u => String(u).replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
const ENT = { aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', uuml: 'ü', nbsp: ' ', ndash: '–', mdash: '—', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', rsquo: '’', lsquo: '‘', hellip: '…' };
const desHtml = s => String(s || '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))).replace(/&([a-zA-Z]+);/g, (m, n) => ENT[n] || m).replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, ' ').trim();

function args() {
  const a = process.argv.slice(2);
  const v = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  return {
    game: parseInt(a.find(x => /^\d+$/.test(x)), 10),
    ids: v('--ids') ? v('--ids').split(',').map(Number) : null,
    top: parseInt(v('--top') || '6', 10),
    forzar: a.includes('--forzar'),
  };
}

// ── Datos (Supabase, sólo lectura) ────────────────────────────────────
const H = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY };
const HL = { ...H, 'Accept-Profile': 'winning_lpf' };
const rest = async (ruta, h) => { const r = await fetch(SUPABASE_URL + '/rest/v1/' + ruta, { headers: h || H }); if (!r.ok) throw new Error(ruta.split('?')[0] + ': HTTP ' + r.status); return r.json(); };

const RELLENO = new Set(['club', 'atletico', 'de', 'del', 'la', 'los', 'las', 'old', 'boys', 'plate', 'juniors', 'sarsfield', 'central', 'deportivo', 'rio', 'iv', 'lp', 'mendoza', 'cordoba', 'tucuman', 'junin']);
const palabrasEquipo = n => sinAcentos(n).split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !RELLENO.has(w));
const corto = n => { const p = n.split(' ').filter(w => !RELLENO.has(sinAcentos(w)) && w.length > 2); return p.length ? p.slice(0, 2).join(' ') : n; };

async function jugadores(cfg, fx) {
  const pms = await rest('player_match_stats?select=player_id,team_id&game_id=eq.' + cfg.game, HL);
  const equipo = {}; pms.forEach(x => { equipo[x.player_id] = x.team_id; });
  let ids = cfg.ids;
  let pts = {};
  if (!ids) {
    const ptsRows = await rest('v_fantasy_player_match_points?select=player_id,total_points&competition_id=eq.' + fx.competition_id + '&season_id=eq.' + fx.season_id + '&matchday=eq.' + fx.matchday +
      '&player_id=in.(' + Object.keys(equipo).join(',') + ')&order=total_points.desc&limit=' + cfg.top);
    ids = ptsRows.map(x => x.player_id); ptsRows.forEach(x => { pts[x.player_id] = x.total_points; });
  }
  const pu = await rest('player_universe?select=player_id,first_name,last_name,known_name&player_id=in.(' + ids.join(',') + ')', HL);
  return ids.map(id => {
    const x = pu.find(p => p.player_id === id) || {};
    const nombre = x.known_name || [x.first_name, x.last_name].filter(Boolean).join(' ');
    // Apellido que usa la prensa: el de known_name si tiene dos palabras ("Thiago Almada" → Almada).
    const apellido = (x.known_name && x.known_name.split(' ').length > 1 ? x.known_name.split(' ').slice(1).join(' ') : x.last_name) || nombre;
    return { id, nombre, apellido, team: equipo[id] || cfg.ids && null, puntos: pts[id] };
  });
}

// ── HTTP ──────────────────────────────────────────────────────────────
function get(url) { return execSync(`curl -sL -A "${UA}" --compressed --max-time 40 "${url.replace(/"/g, '%22')}"`, { encoding: 'utf8', maxBuffer: 40e6 }); }
function bajar(u, f, soloCabecera) {
  try { execSync(`curl -sL -A "${UA}" --max-time 40 ${soloCabecera ? '-r 0-262143' : ''} "${u.replace(/"/g, '%22')}" -o "${f}"`, { stdio: 'ignore' }); return fs.existsSync(f) && fs.statSync(f).size > 4000; }
  catch (e) { return false; }
}
async function medir(u, f) {
  if (!bajar(u, f, true)) return null;
  try { const m = await sharp(f).metadata(); return (m.width && m.height) ? { w: m.width, h: m.height } : null; } catch (e) { return null; }
}
const REDES = /facebook\.|fb\.watch|instagram\.|youtube\.|youtu\.be|tiktok\.|twitter\.|(^|\/)x\.com|whatsapp|telegram/i;
const BASURA = /livesport|flashscore|sofascore|365scores|promiedos|besoccer|onefootball|fotmob|whoscored|transfermarkt|goal\.com|bet|apuesta|odds|pronost|wikipedia|pinterest|alamy|gettyimages|shutterstock|dreamstime|ytimg|youtube/i;

function bingNoticias(texto) {
  const out = [];
  try {
    const xml = get('https://www.bing.com/news/search?q=' + encodeURIComponent(texto) + '&format=rss&setlang=es&cc=AR');
    for (const it of xml.split('<item>').slice(1)) {
      const t = (it.match(/<title>([^<]*)<\/title>/) || [, ''])[1];
      const l = (it.match(/<link>([^<]*)<\/link>/) || [, ''])[1].replace(/&amp;/g, '&');
      const d = (it.match(/<pubDate>([^<]*)<\/pubDate>/) || [, ''])[1];
      const m = l.match(/[?&]url=([^&]+)/);
      const url = m ? decodeURIComponent(m[1]) : l;
      if (/^https?:/.test(url)) out.push({ url, titulo: desHtml(t), fecha: d ? new Date(d) : null });
    }
  } catch (e) {}
  return out;
}
function duckduckgo(texto) {
  const out = [];
  try {
    const html = get('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(texto) + '&df=w&kl=ar-es');
    for (const m of html.matchAll(/class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
      const u = (m[1].match(/uddg=([^&]+)/) || [])[1];
      if (u) out.push({ url: decodeURIComponent(u), titulo: desHtml(m[2].replace(/<[^>]+>/g, '')), fecha: null });
    }
  } catch (e) {}
  return out;
}
async function bingImagenes(texto, dias) {
  if (!CHROME) return [];
  const puppeteer = require('puppeteer-core');
  const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--lang=es-AR'] });
  try {
    const p = await b.newPage(); await p.setUserAgent(UA);
    await p.goto('https://www.bing.com/images/search?q=' + encodeURIComponent(texto) + '&qft=+filterui:age-lt' + (dias * 1440) + '+filterui:imagesize-large&setlang=es&cc=AR', { waitUntil: 'networkidle2', timeout: 60000 });
    await dormir(1200);
    await p.evaluate(async () => { for (let y = 0; y < 3000; y += 800) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 300)); } });
    const res = await p.evaluate(() => [...document.querySelectorAll('a.iusc')].map(a => { try { const m = JSON.parse(a.getAttribute('m')); return { u: m.murl, t: m.t, purl: m.purl }; } catch (e) { return null; } }).filter(Boolean));
    return res.map(r => ({ url: r.u, titulo: desHtml(r.t), nota: r.purl }));
  } finally { await b.close().catch(() => {}); }
}
function variantes(u) {
  const s = u.split('?')[0]; const out = []; const add = x => { if (x && !out.includes(x)) out.push(x); };
  add(s.replace(/_\d{3,4}x\d{1,4}__\d(?=\.\w+$)/, '_2000x1500__1'));
  add(s.replace(/_\d{3,4}x\d{1,4}__\d(?=\.\w+$)/, '_1565x0__1'));
  add(s.replace(/_\d{3,4}x\d{3,4}(?=\.\w+$)/, ''));
  add(s.replace(/-\d{3,4}x\d{3,4}(?=\.\w+$)/, ''));
  add(s.replace(/\/w\d{3,4}_/, '/'));
  if (/resizer\/v2\//.test(u)) add(u.replace(/([?&])(width|height|w|h|quality|smart|focal)=[^&]*/g, '$1').replace(/[?&]+$/, '').replace(/\?&+/, '?').replace(/&&+/g, '&'));
  add(s); add(u);
  return out;
}
async function huella(f) {
  try { const px = await sharp(f).grayscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer(); let b = ''; for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) b += px[y * 9 + x] < px[y * 9 + x + 1] ? '1' : '0'; return b; } catch (e) { return null; }
}
const distancia = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d; };
async function encuadre(f) {
  try {
    const m = await sharp(f).metadata(); const esc = Math.max(1080 / m.width, 1350 / m.height);
    const W = Math.round(m.width * esc), Hh = Math.round(m.height * esc);
    const { info } = await sharp(f).resize(W, Hh).resize(1080, 1350, { fit: 'cover', position: 'attention' }).toBuffer({ resolveWithObject: true });
    const x = W > 1080 ? Math.round(info.cropOffsetLeft / (W - 1080) * 100) : 50, y = Hh > 1350 ? Math.round(info.cropOffsetTop / (Hh - 1350) * 100) : 50;
    return { x: Math.max(0, Math.min(100, Math.abs(x))), y: Math.max(0, Math.min(100, Math.abs(y))), zoom: 1 };
  } catch (e) { return { x: 50, y: 50, zoom: 1 }; }
}

/* Cuántas personas protagonistas hay: recorta el fondo (mismo modelo que bajar-fotos.js)
   y mide las manchas. Una figura grande = foto del jugador; dos o más = grupal. */
const { pathToFileURL } = require('url');
const MODELO = pathToFileURL(path.join(__dirname, 'node_modules', '@imgly', 'background-removal-node', 'dist') + path.sep).href;
async function sujeto(f) {
  try {
    const { removeBackground } = require('@imgly/background-removal-node');
    const small = await sharp(f).resize(320, 320, { fit: 'inside' }).png().toBuffer();
    const blob = await removeBackground(new Blob([small], { type: 'image/png' }), { publicPath: MODELO, output: { format: 'image/png' } });
    const { data, info } = await sharp(Buffer.from(await blob.arrayBuffer())).ensureAlpha().extractChannel(3).raw().toBuffer({ resolveWithObject: true });
    const W = info.width, Hh = info.height, on = new Uint8Array(W * Hh); let total = 0;
    for (let i = 0; i < W * Hh; i++) if (data[i] > 128) { on[i] = 1; total++; }
    if (!total) return null;
    const vis = new Uint8Array(W * Hh); const manchas = [];
    for (let i = 0; i < W * Hh; i++) if (on[i] && !vis[i]) {
      let a = 0; const st = [i]; vis[i] = 1;
      while (st.length) { const k = st.pop(); a++; const x = k % W, y = (k / W) | 0; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= Hh) continue; const q = ny * W + nx; if (on[q] && !vis[q]) { vis[q] = 1; st.push(q); } } }
      manchas.push(a);
    }
    manchas.sort((a, b) => b - a);
    return { share: manchas[0] / total, grandes: manchas.filter(a => a > total * 0.08).length };
  } catch (e) { return null; }
}

/* ¿El texto nombra al jugador? Apellido entero como palabra (no "Rivero" dentro de "Riverplate"). */
function nombra(texto, j) {
  const t = ' ' + sinAcentos(texto).replace(/[^a-z0-9]+/g, ' ') + ' ';
  return t.includes(' ' + sinAcentos(j.apellido).replace(/[^a-z0-9]+/g, ' ').trim() + ' ');
}
function puntuar(c, j, equipos) {
  const escala = 1080 / Math.min(c.w, c.h * 1080 / 1350);
  const t = sinAcentos(c.titulo + ' ' + (c.notaUrl || '') + ' ' + c.u);
  let n = 0;
  n += Math.min(3, 1 / escala) * 30;
  n += c.h >= c.w ? 15 : 0;                                   // vertical: el jugador entra entero
  n -= /entren|practica|pretemporada|conferencia/.test(t) ? 50 : 0;   // entrenamiento o conferencia: no es foto de juego
  n += c.delPartido ? 60 : 0;
  n += equipos.some(e => t.includes(e)) ? 15 : 0;
  n += /festej|celebr|grit|abraz|gol/.test(t) ? 10 : 0;
  n -= /captura|video|screenshot|jwplayer|\/vid\//.test(t) ? 80 : 0;
  n -= /seleccion|scaloni|mundial|eliminatoria|afa\.com/.test(t) ? 40 : 0;   // con la camiseta de la Selección
  n -= /previa|formacion|probable|donde ver|como ver|en vivo/.test(t) ? 40 : 0;
  // Notas en vivo ("Vivo | ...", "River gana 1 a 0"): llevan una foto de archivo o de otro jugador.
  n -= /\bvivo\b|minuto a minuto|\b(gana|empata|pierde)\b[^|]*\d+ ?a ?\d+/.test(sinAcentos(c.titulo || '')) ? 70 : 0;
  // Títulos de previa: la foto es de antes del partido.
  n -= /titular|se perfila|evalua|podria|seria|debe aprovechar|probable|convocado|concentra/.test(sinAcentos(c.titulo || '')) ? 70 : 0;
  // Vavel y similares: placas de diseño con texto, no fotos.
  n -= /vavel\.com/.test(c.u + ' ' + (c.notaUrl || '')) ? 90 : 0;
  if (c.w < 700) n -= 80; else if (c.w < 900) n -= 30;
  return { nota: Math.round(n), escala: +escala.toFixed(2) };
}

// ── Main ──────────────────────────────────────────────────────────────
(async () => {
  const cfg = args();
  if (!cfg.game) { console.error('Uso: node foto-jugador.js <game_id> [--ids a,b] [--top 6] [--forzar]'); process.exit(2); }
  fs.mkdirSync(TMP, { recursive: true });
  fs.mkdirSync(path.join(DEST, String(cfg.game)), { recursive: true });
  const regPath = path.join(DEST, 'elegidas.json');
  let reg = {}; try { reg = JSON.parse(fs.readFileSync(regPath, 'utf8')); } catch (e) {}
  reg[cfg.game] = reg[cfg.game] || {};

  const [fx] = await rest('v_fixtures?select=game_id,competition_id,season_id,matchday,home_id,away_id,home_team_display,away_team_display,kickoff_ts&game_id=eq.' + cfg.game);
  if (!fx) throw new Error('no encuentro el partido ' + cfg.game);
  const kickoff = fx.kickoff_ts ? new Date(fx.kickoff_ts) : null;
  const nombreEq = { [fx.home_id]: fx.home_team_display, [fx.away_id]: fx.away_team_display };
  const js = await jugadores(cfg, fx);
  log(fx.home_team_display + ' vs ' + fx.away_team_display + ': ' + js.map(j => j.apellido).join(', '));
  // Huellas de las fotos del partido (fotos-partido/<game>-*.jpg): ésas no pueden ser la foto de un jugador.
  const huellasPartido = [];
  try {
    const dp = path.join(RAIZ, 'fotos-partido');
    for (const f of fs.readdirSync(dp)) if (f.startsWith(cfg.game + '-') || f === cfg.game + '.jpg') { const h = await huella(path.join(dp, f)); if (h) huellasPartido.push(h); }
  } catch (e) {}

  for (const j of js) {
    if (reg[cfg.game][j.id] && reg[cfg.game][j.id].opciones && reg[cfg.game][j.id].opciones.length && !cfg.forzar) { console.log('\n── ' + j.nombre + ': ya tiene fotos'); continue; }
    const club = nombreEq[j.team] || '';
    const rival = nombreEq[j.team === fx.home_id ? fx.away_id : fx.home_id] || '';
    const equipos = palabrasEquipo(club);
    console.log('\n── ' + j.nombre + ' (' + corto(club) + ')');
    const cands = []; const vistas = new Set(); let n = 0;
    const tmp = () => path.join(TMP, cfg.game + '_' + j.id + '_' + (n++) + '.img');
    async function candidata(u, info) {
      if (REDES.test(u) || BASURA.test(host(u)) || BASURA.test(host(info.notaUrl || ''))) return;
      const k = u.split('?')[0]; if (vistas.has(k)) return; vistas.add(k);
      let mejor = null;
      for (const v of variantes(u)) { const f = tmp(); const m = await medir(v, f); if (m && (!mejor || m.w > mejor.w)) mejor = { u: v, f, ...m }; if (mejor && mejor.w >= 1600) break; }
      if (!mejor || mejor.w < 600 || mejor.h < 600) return;
      const c = { ...mejor, ...info, host: host(mejor.u) };
      Object.assign(c, puntuar(c, j, equipos));
      cands.push(c);
    }

    // 1. Notas del partido que lo nombran en el TÍTULO (la foto principal suele ser él).
    const qPartido = `${j.nombre} ${corto(club)} ${corto(rival)}`;
    let notas = [...bingNoticias(qPartido), ...duckduckgo(qPartido)];
    const porUrl = {}; notas.forEach(x => { const k = x.url.split('?')[0]; if (!porUrl[k]) porUrl[k] = x; });
    notas = Object.values(porUrl).filter(x => !REDES.test(x.url) && !BASURA.test(host(x.url)) && nombra(x.titulo, j))
      .filter(x => !x.fecha || !kickoff || x.fecha > kickoff).slice(0, MAX_NOTAS);
    console.log('   notas que lo nombran en el título: ' + notas.length);
    for (const nt of notas) {
      let html = ''; try { html = get(nt.url); } catch (e) { continue; }
      const og = (html.match(/property="og:image"\s+content="([^"]+)"/) || html.match(/content="([^"]+)"\s+property="og:image"/) || html.match(/name="twitter:image"\s+content="([^"]+)"/) || [])[1];
      const tit = desHtml((html.match(/property="og:title"\s+content="([^"]+)"/) || html.match(/<title>([^<]+)/) || [, nt.titulo])[1]);
      const pub = (html.match(/property="article:published_time"\s+content="([^"]+)"/) || html.match(/"datePublished"\s*:\s*"([^"]+)"/) || [])[1];
      const fpub = pub ? new Date(pub) : nt.fecha;
      if (fpub && kickoff && !isNaN(fpub) && fpub < kickoff) continue;     // previa: foto de antes
      if (!nombra(tit, j)) continue;
      if (og) await candidata(new URL(og, nt.url).href, { titulo: tit, notaUrl: nt.url, delPartido: true, via: 'nota' });
      await dormir(500);
    }

    // 2. Bing Imágenes: primero del partido (última semana), después de los últimos 30 días.
    for (const [q, dias, delPartido] of [[`${j.nombre} ${corto(club)} ${corto(rival)}`, 7, true], [`${j.nombre} ${corto(club)}`, 30, false]]) {
      if (cands.filter(c => c.nota > 60).length >= OPCIONES) break;
      let res = []; try { res = await conTiempo(bingImagenes(q, dias), 120000, 'Bing Imágenes'); } catch (e) { console.log('   Bing Imágenes: ' + e.message); }
      const suyas = res.filter(r => nombra(r.titulo + ' ' + (r.nota || ''), j));
      console.log('   Bing Imágenes «' + q + '» (' + dias + ' días): ' + res.length + ' resultados, ' + suyas.length + ' lo nombran');
      for (const r of suyas.slice(0, 20)) {
        const delRival = rival && nombra(r.titulo + ' ' + (r.nota || ''), { apellido: corto(rival) });
        await candidata(r.url, { titulo: r.titulo, notaUrl: r.nota, delPartido: delPartido && !!delRival, via: 'Bing Imágenes' });
      }
    }

    cands.sort((a, b) => b.nota - a.nota);
    // Las de antes de este jugador se borran: si ahora salen menos, no quedan sueltas.
    for (const f of fs.readdirSync(path.join(DEST, String(cfg.game)))) if (f.startsWith(j.id + '-op')) fs.rmSync(path.join(DEST, String(cfg.game), f), { force: true });
    const opciones = []; const huellas = []; const titulos = new Set(); const grupales = [];
    // Primero las individuales; las grupales (plantel, festejo de varios) sólo si no alcanzan.
    const cola = [...cands.filter(c => c.nota >= 0), { finGrupales: true }];
    for (let i = 0; i < cola.length; i++) {
      const c = cola[i];
      if (c.finGrupales) { cola.push(...grupales.splice(0)); continue; }
      if (opciones.length >= OPCIONES) break;
      let full = c.full;
      if (!c.grupal) {
        // Una foto por nota: el mismo artículo en dos tamaños es la misma foto recortada distinto.
        const tituloClave = sinAcentos(c.titulo || '').replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 50);
        if (tituloClave && titulos.has(tituloClave)) continue;
        full = tmp(); if (!bajar(c.u, full)) continue;
        try { await sharp(full).metadata(); } catch (e) { continue; }
        const h = await huella(full);
        if (h && huellas.some(x => distancia(x, h) <= 8)) continue;
        // Nunca la genérica: si es la misma foto que la del partido (el plantel, otro jugador), afuera.
        if (h && huellasPartido.some(x => distancia(x, h) <= 10)) { console.log('   descartada: es la foto del partido · ' + (c.titulo || '').slice(0, 50)); continue; }
        if (h) huellas.push(h);
        if (tituloClave) titulos.add(tituloClave);
        const s = await sujeto(full);
        if (s && s.grandes >= 2 && s.share < 0.85) { c.grupal = true; c.full = full; grupales.push(c); console.log('   grupal, la dejo para el final · ' + (c.titulo || '').slice(0, 50)); continue; }
      }
      const nombre = j.id + '-op' + (opciones.length + 1) + '.jpg';
      await sharp(full).rotate().jpeg({ quality: 92 }).toFile(path.join(DEST, String(cfg.game), nombre));
      opciones.push({ archivo: 'fotos-jugador/' + cfg.game + '/' + nombre, tam: c.w + 'x' + c.h, escala: c.escala, medio: c.host, url: c.u, fuente: c.notaUrl || null,
        que: (c.titulo || '').slice(0, 140), delPartido: !!c.delPartido, nota: c.nota, pos: await encuadre(full) });
      console.log('   ' + opciones.length + '. ' + (c.w + 'x' + c.h).padEnd(11) + c.host.padEnd(26) + String(c.nota).padEnd(5) + (c.delPartido ? 'DEL PARTIDO ' : 'reciente    ') + (c.h >= c.w ? 'vertical · ' : '') + (c.titulo || '').slice(0, 60));
    }
    if (!opciones.length) console.log('   ninguna foto que lo nombre: la ficha sale sin foto');
    reg[cfg.game][j.id] = { nombre: j.nombre, opciones, actualizado: new Date().toISOString() };
    fs.writeFileSync(regPath, JSON.stringify(reg, null, 1));
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  log('listo: fotos-jugador/elegidas.json');
})().catch(e => { log('Error: ' + e.message); process.exit(1); });
