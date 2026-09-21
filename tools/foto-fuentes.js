#!/usr/bin/env node
/* Foto de cada partido por el "camino D": sin Google y sin sesión de nadie,
   así corre igual en un server. Fuentes, todas gratis y abiertas:
     1. Bing Noticias (RSS) y DuckDuckGo → las notas de la última semana que
        hablan del partido / del goleador. De cada nota, su foto principal
        (og:image) en el tamaño más grande que dé el CDN.
     2. Galerías: si la nota (por ejemplo la del sitio del club) linkea a una
        galería de fotos del partido, se entra y se traen las fotos grandes.
     3. Bing Imágenes (Chrome sin cabeza, sin login) → fotos sueltas con su título.
   Todo pasa por el mismo puntaje (criterio de Luchi): del partido correcto,
   del goleador, lo más grande posible, festejo, sin capturas de video.

   Uso:  node foto-fuentes.js <fecha> [--game <id>[,<id>...]] [--comp 724] [--forzar]
   Deja: fotos-partido/<game_id>-op1..4.jpg (+ -original.jpg y .jpg = la 1)
         fotos-partido/elegidas.json con qué es, por qué, de dónde y cómo se encontró. */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const sharp = require('sharp');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SUPABASE_URL = 'https://ketwxvbrhqbemlflmadu.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtldHd4dmJyaHFiZW1sZmxtYWR1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4NjA4MDcsImV4cCI6MjA4NjQzNjgwN30.-qXPLMSFEiRORNk5EUKrD16VDiMXtv-VfcDSWpzWzsg';
const CHROME = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find(f => fs.existsSync(f));
const RAIZ = path.resolve(__dirname, '..');
const DEST = path.join(RAIZ, 'fotos-partido');
const TMP = path.join(DEST, '_tmp');
const OPCIONES = 4;
const MAX_NOTAS = 18;        // notas que se abren por partido
const MAX_GALERIAS = 2;      // galerías que se recorren por partido
const MAX_FOTOS_GALERIA = 10;

const dormir = ms => new Promise(r => setTimeout(r, ms));
const conTiempo = (pr, ms, que) => Promise.race([pr, new Promise((_, rj) => setTimeout(() => rj(new Error('se pasó de ' + ms / 1000 + 's: ' + que)), ms))]);
const ahora = () => new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
const log = m => console.log('[' + ahora() + '] ' + m);
const sinAcentos = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const host = u => String(u).replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
const ENT = { aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', uuml: 'ü', iquest: '¿', iexcl: '¡', nbsp: ' ', ndash: '–', mdash: '—', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', rsquo: '’', lsquo: '‘', hellip: '…' };
const desHtml = s => String(s || '').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))).replace(/&([a-zA-Z]+);/g, (m, n) => ENT[n] || m).replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, ' ').trim();

function args() {
  const a = process.argv.slice(2);
  const i = k => a.indexOf(k);
  return {
    matchday: parseInt(a.find(x => /^\d+$/.test(x)), 10),
    competition: i('--comp') >= 0 ? parseInt(a[i('--comp') + 1], 10) : 724,
    season: 2026,
    games: i('--game') >= 0 ? a[i('--game') + 1].split(',').map(x => parseInt(x, 10)) : null,
    forzar: a.includes('--forzar'),
  };
}

// ── Datos del partido (Supabase, sólo lectura) ────────────────────────
const H = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY };
const HL = { ...H, 'Accept-Profile': 'winning_lpf' };
const rest = async (ruta, h) => { const r = await fetch(SUPABASE_URL + '/rest/v1/' + ruta, { headers: h || H }); if (!r.ok) throw new Error(ruta.split('?')[0] + ': HTTP ' + r.status); return r.json(); };

async function partidos(cfg) {
  const f = await rest('v_fixtures?select=game_id,home_id,away_id,home_team_display,away_team_display,home_score,away_score,kickoff_ts' +
    '&competition_id=eq.' + cfg.competition + '&season_id=eq.' + cfg.season + '&matchday=eq.' + cfg.matchday);
  return cfg.games ? f.filter(x => cfg.games.includes(x.game_id)) : f;
}
async function goleadores(gameId) {
  const g = await rest('goal_events?select=team_id,scorer_player_id,minute,goal_type&game_id=eq.' + gameId + '&order=minute', HL);
  const ids = [...new Set(g.map(x => x.scorer_player_id).filter(Boolean))];
  if (!ids.length) return [];
  const p = await rest('player_universe?select=player_id,first_name,last_name,known_name&player_id=in.(' + ids.join(',') + ')', HL);
  const nom = {}; p.forEach(x => { nom[x.player_id] = { nombre: (x.first_name && x.last_name) ? x.first_name + ' ' + x.last_name : x.known_name, apellido: x.last_name || (x.known_name || '').split(' ').pop() }; });
  return g.filter(x => x.goal_type !== 'Own' && nom[x.scorer_player_id]).map(x => ({ ...nom[x.scorer_player_id], team: x.team_id, minute: x.minute }));
}
async function figura(gameId, cfg) {
  const pms = await rest('player_match_stats?select=player_id,team_id&game_id=eq.' + gameId, HL);
  const ids = pms.map(x => x.player_id); if (!ids.length) return null;
  const pts = await rest('v_fantasy_player_match_points?select=player_id,player_name,total_points&competition_id=eq.' + cfg.competition + '&season_id=eq.' + cfg.season + '&matchday=eq.' + cfg.matchday + '&player_id=in.(' + ids.slice(0, 60).join(',') + ')&order=total_points.desc&limit=1');
  return pts[0] ? { nombre: pts[0].player_name, apellido: pts[0].player_name.split(' ').pop() } : null;
}

/* Nombre corto del equipo, como lo escribe la prensa ("Vélez", "Unión"). */
const RELLENO = new Set(['club', 'atletico', 'de', 'del', 'la', 'los', 'las', 'old', 'boys', 'plate', 'juniors', 'sarsfield', 'central', 'deportivo', 'rio', 'iv', 'lp', 'mendoza', 'cordoba', 'tucuman', 'junin']);
const palabrasEquipo = nombre => sinAcentos(nombre).split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !RELLENO.has(w));
const corto = nombre => { const p = nombre.split(' ').filter(w => !RELLENO.has(sinAcentos(w)) && w.length > 2); return p.length ? p.slice(0, 2).join(' ') : nombre; };

/* Qué se busca (lo mismo que buscaría Luchi): con goles, los goleadores del
   ganador (hasta dos) y uno del otro; sin goles, la figura y el resultado. */
function consultas(j, goles, fig) {
  const local = corto(j.home_team_display), visita = corto(j.away_team_display);
  const q = [];
  if (goles.length) {
    const ganador = j.home_score > j.away_score ? j.home_id : j.away_score > j.home_score ? j.away_id : null;
    const delGanador = ganador ? goles.filter(g => g.team === ganador) : goles;
    const vistos = new Set();
    for (const g of [...(delGanador.length ? delGanador : goles)].reverse()) {
      if (vistos.has(g.apellido) || vistos.size >= 2) continue; vistos.add(g.apellido);
      q.push({ texto: `${g.nombre} gol ${local} ${visita}`, quien: g.apellido, motivo: 'goleador' });
    }
    const otro = goles.filter(g => !vistos.has(g.apellido)).slice(-1)[0];
    if (otro) q.push({ texto: `${otro.nombre} gol ${local} ${visita}`, quien: otro.apellido, motivo: 'goleador' });
  } else if (fig) {
    q.push({ texto: `${fig.nombre} ${local} ${visita}`, quien: fig.apellido, motivo: 'figura' });
  }
  q.push({ texto: `${local} ${visita} ${j.home_score}-${j.away_score}`, quien: null, motivo: 'partido' });
  return q;
}

// ── HTTP (curl: es lo que mejor se lleva con los CDN de los diarios) ──
function get(url, extra) {
  return execSync(`curl -sL -A "${UA}" --compressed --max-time 40 ${extra || ''} "${url.replace(/"/g, '%22')}"`, { encoding: 'utf8', maxBuffer: 40e6 });
}
function bajar(u, f, soloCabecera) {
  try {
    execSync(`curl -sL -A "${UA}" --max-time 40 ${soloCabecera ? '-r 0-262143' : ''} "${u.replace(/"/g, '%22')}" -o "${f}"`, { stdio: 'ignore' });
    return fs.existsSync(f) && fs.statSync(f).size > 4000;
  } catch (e) { return false; }
}
/* Medida sin bajar la foto entera (las cabeceras están al principio). */
async function medir(u, f) {
  if (!bajar(u, f, true)) return null;
  try { const m = await sharp(f).metadata(); return (m.width && m.height) ? { w: m.width, h: m.height } : null; } catch (e) { return null; }
}
const REDES = /facebook\.|fb\.watch|instagram\.|youtube\.|youtu\.be|tiktok\.|twitter\.|(^|\/)x\.com|whatsapp|telegram/i;

// ── 1. Notas: Bing Noticias (RSS) + DuckDuckGo ────────────────────────
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
      if (/^https?:/.test(url)) out.push({ url, titulo: desHtml(t), fecha: d ? new Date(d) : null, via: 'Bing Noticias' });
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
      if (u) out.push({ url: decodeURIComponent(u), titulo: desHtml(m[2].replace(/<[^>]+>/g, '')), fecha: null, via: 'DuckDuckGo' });
    }
  } catch (e) {}
  return out;
}
/* Qué tan prometedora es una nota antes de abrirla. */
function pesoNota(n, goles, equipos) {
  const t = sinAcentos(n.titulo + ' ' + n.url);
  let p = 0;
  if (/galeria|fotos|imagenes|postales/.test(t)) p += 30;
  if (goles.some(g => t.includes(sinAcentos(g.apellido)))) p += 20;
  if (equipos.filter(e => t.includes(e)).length >= 2) p += 15;
  if (/festej|gol|triunf|gano|venci|victoria|figura|resumen|derrot/.test(t)) p += 5;
  if (/video|en-vivo|en vivo|formacion|previa|arbitro|entrada|puntaje|donde-ver|donde ver|hora|agenda|apuesta|pronostic|puede marcar|se enfrenta|recibe a|visita a|palpita|probable/.test(t)) p -= 25;
  if (REDES.test(n.url)) p -= 100;
  return p;
}

// ── Variantes del CDN: del recorte que muestra la nota al original ────
function variantes(u) {
  const sinQuery = u.split('?')[0];
  const out = [];
  const add = x => { if (x && !out.includes(x)) out.push(x); };
  add(sinQuery.replace(/_\d{3,4}x\d{1,4}__\d(?=\.\w+$)/, '_2000x1500__1'));   // Olé
  add(sinQuery.replace(/_\d{3,4}x\d{1,4}__\d(?=\.\w+$)/, '_1565x0__1'));      // El Litoral / Uno
  add(sinQuery.replace(/_\d{3,4}x\d{3,4}(?=\.\w+$)/, ''));                     // TyC
  add(sinQuery.replace(/-\d{3,4}x\d{3,4}(?=\.\w+$)/, ''));                     // WordPress
  add(sinQuery.replace(/\/w\d{3,4}_/, '/'));                                    // Vavel
  if (/resizer\/v2\//.test(u)) add(u.replace(/([?&])(width|height|w|h|quality|smart|focal)=[^&]*/g, '$1').replace(/[?&]+$/, '').replace(/\?&+/, '?').replace(/&&+/g, '&'));   // La Nación / Infobae (Arc)
  add(sinQuery);
  add(u);
  return out;
}

// ── 2. Galerías: fotos grandes de una página de galería ───────────────
function imagenesDe(html, base) {
  const out = [];
  for (const m of html.matchAll(/<img[^>]+(?:src|data-src|data-lazy-src)="([^"]+\.(?:jpe?g|png|webp)(?:\?[^"]*)?)"/gi)) {
    try { out.push(new URL(m[1], base).href); } catch (e) {}
  }
  for (const m of html.matchAll(/<a[^>]+href="([^"]+\.(?:jpe?g|png|webp))"/gi)) {
    try { out.push(new URL(m[1], base).href); } catch (e) {}
  }
  return [...new Set(out)].filter(u => !/logo|icon|avatar|sprite|banner|publicidad|\/ads?\//i.test(u));
}
function linksGaleria(html, base) {
  const out = [];
  for (const m of html.matchAll(/<a[^>]+href="([^"#]+)"/gi)) {
    let u; try { u = new URL(m[1], base); } catch (e) { continue; }
    if (u.host !== new URL(base).host) continue;
    if (/galeria|fotogaleria|\/fotos\/|postales|album/i.test(u.pathname) && !/\/galerias\/?$/.test(u.pathname)) out.push(u.origin + u.pathname);
  }
  return [...new Set(out)];
}

// ── 3. Bing Imágenes (Chrome sin cabeza) ──────────────────────────────
async function bingImagenes(texto) {
  if (!CHROME) return [];
  const puppeteer = require('puppeteer-core');
  const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage', '--lang=es-AR'] });
  try {
    const p = await b.newPage();
    await p.setUserAgent(UA);
    await p.goto('https://www.bing.com/images/search?q=' + encodeURIComponent(texto) + '&qft=+filterui:age-lt10080&setlang=es&cc=AR', { waitUntil: 'networkidle2', timeout: 60000 });
    await dormir(1200);
    await p.evaluate(async () => { for (let y = 0; y < 4000; y += 800) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 300)); } });
    const res = await p.evaluate(() => [...document.querySelectorAll('a.iusc')].map(a => { try { const m = JSON.parse(a.getAttribute('m')); return { u: m.murl, t: m.t, purl: m.purl }; } catch (e) { return null; } }).filter(Boolean));
    return res.map(r => ({ url: r.u, titulo: desHtml(r.t), nota: r.purl, via: 'Bing Imágenes' }));
  } finally { await b.close().catch(() => {}); }
}

// ── Puntaje (criterio de Luchi) ───────────────────────────────────────
const MEDIOS_BUENOS = /tycsports|ole\.com|infobae|lanacion|clarin|lavoz|ellitoral|unosantafe|eldia\.com|lagaceta|dobleamarilla|espn|tn\.com|pagina12|diariopopular|cronica|airedesantafe|0221|puntal|lacapital|eleco|losandes|mdzol/i;
const CLUBES = /velez\.com|cariverplate|bocajuniors|racingclub|clubaindependiente|sanlorenzo\.com|estudiantesdelaplata|gimnasia\.org|clubatleticolanus|clubaunion|institutoacc|rosariocentral|newellsoldboys|clubatleticohuracan|talleres|belgrano\.com|argentinosjuniors|platense|defensayjusticia|catigre|banfield|aldosivi|atleticotucuman|cacc\.com|sarmiento|barracascentral|riestra|gimnasiamendoza|independienterivadavia|estudiantesrc/i;
function puntuar(c, quien, equipos) {
  const anchoUtil = Math.min(c.w, c.h * 1080 / 1350);
  const escala = 1080 / anchoUtil;
  const t = sinAcentos(c.u + ' ' + (c.titulo || '') + ' ' + (c.notaUrl || ''));
  const goleador = !!(quien && t.includes(sinAcentos(quien)));
  const equipo = equipos.filter(e => t.includes(e)).length;
  const festejo = /festej|celebr|grit|abraz/.test(t);
  const video = /captura|video|screenshot|jwplayer|poster|\/vid\//.test(t) || /vavel\.com\/w\d+_screenshot/.test(c.u);
  const oficial = CLUBES.test(host(c.u)) || CLUBES.test(host(c.notaUrl || ''));
  let nota = 0;
  nota += Math.min(3, 1 / escala) * 30;            // tamaño: hasta 90
  nota += c.h >= c.w ? 20 : 0;                      // vertical ayuda
  nota += goleador ? 40 : 0;
  nota += Math.min(2, equipo) * 10;
  nota += festejo ? 15 : 0;
  nota += MEDIOS_BUENOS.test(c.u) || MEDIOS_BUENOS.test(c.notaUrl || '') ? 10 : 0;
  nota += oficial ? 15 : 0;
  nota += c.origen === 'galería' ? 10 : 0;
  nota -= video ? 80 : 0;
  if (!goleador && !equipo) nota -= 100;            // nada del partido en el texto: casi seguro es otra cosa
  if (/predicti|pronostic|apuesta|betting|\bbet\b|odds|casino|sportsbook|h2h|lineup|prob(able|abilidad)/i.test(t) || /bet|apuesta|odds|pronost|1xbet|betano|codere/i.test(host(c.u) + ' ' + host(c.notaUrl || ''))) nota -= 120;   // sitios de apuestas / pronósticos: fotos de archivo
  if (/livesport|flashscore|sofascore|365scores|promiedos|besoccer|onefootball|fotmob|whoscored|espn\.com\.br|goal\.com/i.test(host(c.u) + ' ' + host(c.notaUrl || ''))) nota -= 120;   // sitios de estadísticas: gráficos, no fotos
  if (/previa|puede marcar|duelo que|se enfrenta|recibe a|visita a|formacion|probable|donde ver|como ver|hora y tv|en vivo/i.test(sinAcentos(c.titulo || ''))) nota -= 90;   // título de previa: la foto no es de este partido
  if (c.w < 700) nota -= 80; else if (c.w < 900) nota -= 35;
  return { nota: Math.round(nota), escala: +escala.toFixed(2), goleador, equipo: !!equipo, festejo, video, oficial };
}

/* Encuadre sugerido: dónde cae el recorte 4:5 más interesante según sharp. */
async function encuadre(archivo) {
  try {
    const m = await sharp(archivo).metadata();
    const esc = Math.max(1080 / m.width, 1350 / m.height);
    const W = Math.round(m.width * esc), Hh = Math.round(m.height * esc);
    const { info } = await sharp(archivo).resize(W, Hh).resize(1080, 1350, { fit: 'cover', position: 'attention' }).toBuffer({ resolveWithObject: true });
    const x = W > 1080 ? Math.round(info.cropOffsetLeft / (W - 1080) * 100) : 50;
    const y = Hh > 1350 ? Math.round(info.cropOffsetTop / (Hh - 1350) * 100) : 50;
    return { x: Math.max(0, Math.min(100, Math.abs(x))), y: Math.max(0, Math.min(100, Math.abs(y))), zoom: 1 };
  } catch (e) { return { x: 50, y: 50, zoom: 1 }; }
}

/* Huella visual (dHash 9x8 en gris): dos recortes de la misma foto dan casi la misma. */
async function huella(archivo) {
  try {
    const px = await sharp(archivo).grayscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
    let bits = '';
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += px[y * 9 + x] < px[y * 9 + x + 1] ? '1' : '0';
    return bits;
  } catch (e) { return null; }
}
const distancia = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d; };

/* Clave para no repetir la misma foto en distintos tamaños. */
const claveFoto = u => sinAcentos(u.split('?')[0].replace(/^https?:\/\/(www\.)?/, '').replace(/_\d{3,4}x\d{1,4}(__\d)?(?=\.\w+$)/, '').replace(/-\d{3,4}x\d{3,4}(?=\.\w+$)/, '').replace(/\/w\d{3,4}_/, '/'));

// ── Main ──────────────────────────────────────────────────────────────
(async () => {
  const cfg = args();
  if (!cfg.matchday) { console.error('Uso: node foto-fuentes.js <fecha> [--game <id>,<id>] [--forzar]'); process.exit(2); }
  if (!CHROME) log('aviso: no encuentro Chrome; sigo sin Bing Imágenes');
  fs.mkdirSync(TMP, { recursive: true });
  const registroPath = path.join(DEST, 'elegidas.json');
  let registro = {}; try { registro = JSON.parse(fs.readFileSync(registroPath, 'utf8')); } catch (e) {}

  const juegos = await partidos(cfg);
  log('fecha ' + cfg.matchday + ': ' + juegos.length + ' partido(s)');
  for (const j of juegos) {
    const titulo = `${j.home_team_display} ${j.home_score ?? ''}-${j.away_score ?? ''} ${j.away_team_display}`;
    if (registro[j.game_id] && registro[j.game_id].como && /camino D/.test(registro[j.game_id].como) && !cfg.forzar) { console.log('\n── ' + titulo + '  ya tiene opciones (--forzar para rehacer)'); continue; }
    console.log('\n── ' + titulo + '  (' + j.game_id + ')');
    const t0 = Date.now();
    const goles = await goleadores(j.game_id);
    const fig = goles.length ? null : await figura(j.game_id, cfg);
    const qs = consultas(j, goles, fig);
    const equipos = [...palabrasEquipo(j.home_team_display), ...palabrasEquipo(j.away_team_display)];
    const kickoff = j.kickoff_ts ? new Date(j.kickoff_ts) : null;
    const cands = []; const vistas = new Set(); let n = 0;
    const pedir = () => path.join(TMP, j.game_id + '_' + (n++) + '.img');

    /* Agrega una foto candidata: mide primero (cabecera), y elige la variante más grande. */
    async function candidata(u, info) {
      const k = claveFoto(u);
      if (vistas.has(k)) return; vistas.add(k);
      let mejor = null;
      for (const v of variantes(u)) {
        const f = pedir();
        const m = await medir(v, f);
        if (m && (!mejor || m.w > mejor.w)) mejor = { u: v, f, ...m };
        if (mejor && mejor.w >= 1600) break;
      }
      if (!mejor || mejor.w < 500 || mejor.h < 400) return;
      const c = { ...mejor, ...info, host: host(mejor.u) };
      Object.assign(c, puntuar(c, info.quien, equipos));
      cands.push(c);
    }

    // 1. Notas
    let notas = [];
    for (const q of qs) { notas.push(...bingNoticias(q.texto).map(x => ({ ...x, q }))); notas.push(...duckduckgo(q.texto).map(x => ({ ...x, q }))); await dormir(800); }
    const porUrl = {}; notas.forEach(x => { const k = x.url.split('?')[0]; if (!porUrl[k]) porUrl[k] = x; });
    notas = Object.values(porUrl)
      .filter(x => !x.fecha || !kickoff || (x.fecha - kickoff) > -6 * 3600e3)   // publicada desde el partido en adelante (las previas no sirven)
      .map(x => ({ ...x, peso: pesoNota(x, goles, equipos) }))
      .filter(x => x.peso > -50 && equipos.some(e => sinAcentos(x.titulo + ' ' + x.url).includes(e)))
      .sort((a, b) => b.peso - a.peso).slice(0, MAX_NOTAS);
    console.log('   ' + Object.keys(porUrl).length + ' notas encontradas, abro ' + notas.length);
    let galerias = 0, previas = 0;
    for (const nt of notas) {
      let html = ''; try { html = get(nt.url); } catch (e) { continue; }
      const og = (html.match(/property="og:image"\s+content="([^"]+)"/) || html.match(/content="([^"]+)"\s+property="og:image"/) || html.match(/name="twitter:image"\s+content="([^"]+)"/) || [])[1];
      const tit = desHtml((html.match(/property="og:title"\s+content="([^"]+)"/) || html.match(/<title>([^<]+)/) || [, nt.titulo])[1]);
      // Publicada antes del partido = previa: su foto no es de este partido.
      const pub = (html.match(/property="article:published_time"\s+content="([^"]+)"/) || html.match(/content="([^"]+)"\s+property="article:published_time"/) || html.match(/"datePublished"\s*:\s*"([^"]+)"/) || [])[1];
      let fechaPub = pub ? new Date(pub) : null; if (fechaPub && isNaN(fechaPub)) fechaPub = null;
      if (fechaPub && !isNaN(fechaPub) && kickoff && fechaPub < kickoff) { previas++; if (process.env.VERBOSE) console.log('   previa: ' + tit.slice(0, 60)); continue; }
      if (process.env.VERBOSE) console.log('   nota ' + host(nt.url).padEnd(24) + (fechaPub ? fechaPub.toISOString().slice(0, 16) : '          sin fecha') + ' · ' + tit.slice(0, 60));
      if (og) await candidata(new URL(og, nt.url).href, { titulo: tit, notaUrl: nt.url, via: nt.via, origen: 'nota', quien: nt.q.quien, consulta: nt.q.texto });
      // 2. Galerías linkeadas desde la nota (o la nota misma si es una galería).
      const esGaleria = /galeria|fotogaleria|postales/i.test(nt.url);
      const links = esGaleria ? [nt.url] : linksGaleria(html, nt.url).slice(0, 1);
      for (const g of links) {
        if (galerias >= MAX_GALERIAS) break; galerias++;
        let gh = html; if (g !== nt.url) { try { gh = get(g); } catch (e) { continue; } }
        const imgs = imagenesDe(gh, g).filter(u => host(u) === host(g) || /cdn|static|media|img/.test(host(u)));
        let tomadas = 0;
        for (const u of imgs) {
          if (tomadas >= MAX_FOTOS_GALERIA) break;
          const antes = cands.length;
          await candidata(u, { titulo: tit, notaUrl: g, via: nt.via, origen: 'galería', quien: nt.q.quien, consulta: nt.q.texto });
          if (cands.length > antes) { if (cands[cands.length - 1].w < 1000) cands.pop(); else tomadas++; }   // en galerías, sólo fotos grandes (las chicas son miniaturas de otras notas)
        }
        if (tomadas) console.log('   galería ' + host(g) + ': ' + tomadas + ' fotos grandes');
      }
      await dormir(700);
    }
    if (previas) console.log('   ' + previas + ' notas descartadas por ser de antes del partido');
    // 3. Bing Imágenes (hasta dos búsquedas; sólo si lo encontrado no alcanza: buenas Y grandes)
    for (const q of qs.slice(0, 2)) {
      if (cands.filter(c => c.nota > 60 && c.escala <= 1.4).length >= 3) break;
      let res = []; try { res = await conTiempo(bingImagenes(q.texto), 120000, 'Bing Imágenes'); } catch (e) { console.log('   Bing Imágenes: ' + e.message); }
      console.log('   Bing Imágenes «' + q.texto + '»: ' + res.length + ' resultados');
      for (const r of res.slice(0, 25)) { if (REDES.test(r.url) || REDES.test(r.nota || '')) continue; await candidata(r.url, { titulo: r.titulo, notaUrl: r.nota, via: 'Bing Imágenes', origen: 'imagen', quien: q.quien, consulta: q.texto }); }
    }

    if (!cands.length) { console.log('   no encontré fotos'); continue; }
    cands.sort((a, b) => b.nota - a.nota);
    // Ahora sí, se bajan enteras las mejores.
    const opciones = []; let k = 0; const huellas = [];
    for (const c of cands) {
      if (opciones.length >= OPCIONES) break;
      if (c.nota < 0 && opciones.length) break;   // puntaje negativo = no es de este partido; mejor menos opciones que una de cualquier cosa
      const full = pedir();
      if (!bajar(c.u, full)) continue;
      let ok = true; try { await sharp(full).metadata(); } catch (e) { ok = false; }
      if (!ok) continue;
      // La misma foto publicada por dos medios (o dos recortes) no cuenta dos veces.
      const h = await huella(full);
      if (h && huellas.some(x => distancia(x, h) <= 8)) { if (process.env.VERBOSE) console.log('   repetida: ' + c.host + ' ' + c.w + 'x' + c.h); continue; }
      if (h) huellas.push(h);
      k = opciones.length + 1;
      const nombre = j.game_id + '-op' + k + '.jpg';
      await sharp(full).jpeg({ quality: 92 }).toFile(path.join(DEST, nombre));
      if (k === 1) { fs.copyFileSync(path.join(DEST, nombre), path.join(DEST, j.game_id + '-original.jpg')); await sharp(full).resize(1080, 1350, { fit: 'cover', position: 'attention' }).jpeg({ quality: 92 }).toFile(path.join(DEST, j.game_id + '.jpg')); }
      const porque = [];
      if (c.goleador) porque.push('nombra a ' + c.quien + ' (' + (c.origen === 'galería' ? 'galería' : 'nota') + ')'); else if (c.quien) porque.push('no nombra a ' + c.quien);
      if (c.equipo) porque.push('nombra al equipo');
      if (c.festejo) porque.push('habla de festejo');
      if (c.oficial) porque.push('sitio oficial del club');
      porque.push(c.escala <= 1.001 ? 'entra sin estirar' : 'se estira ' + c.escala + 'x');
      if (c.h >= c.w) porque.push('vertical');
      if (c.video) porque.push('parece captura de video (penalizada)');
      const como = c.origen === 'galería' ? 'camino D: galería de fotos linkeada desde una nota encontrada por ' + c.via
        : c.origen === 'nota' ? 'camino D: foto principal de la nota, encontrada por ' + c.via + ' buscando «' + c.consulta + '»'
        : 'camino D: Bing Imágenes (última semana) buscando «' + c.consulta + '»';
      opciones.push({ archivo: 'fotos-partido/' + nombre, medio: c.host, tam: c.w + 'x' + c.h, escala: c.escala, url: c.u, nota: c.nota, fuente: c.notaUrl || null,
        que: (c.titulo || '').slice(0, 120), porque: porque.join(' · '), como, pos: await encuadre(full) });
      console.log('   ' + k + '. ' + (c.w + 'x' + c.h).padEnd(11) + c.host.padEnd(28) + 'nota ' + String(c.nota).padEnd(5) + c.origen.padEnd(8) + (c.goleador ? 'GOLEADOR ' : '') + (c.h >= c.w ? 'vertical ' : '') + (c.escala <= 1.001 ? 'sin estirar' : 'estira ' + c.escala + 'x') + ' · ' + (c.titulo || '').slice(0, 50));
    }
    if (!opciones.length) { console.log('   no pude bajar ninguna'); continue; }
    registro[j.game_id] = { partido: titulo, buscado: qs.map(q => q.texto), opciones, elegida: 0, medio: opciones[0].medio, tam: opciones[0].tam, escala: opciones[0].escala, que: opciones[0].que, porque: opciones[0].porque, como: opciones[0].como, url: opciones[0].url, actualizado: new Date().toISOString() };
    fs.writeFileSync(registroPath, JSON.stringify(registro, null, 1));
    console.log('   (' + cands.length + ' candidatas, ' + Math.round((Date.now() - t0) / 1000) + ' s)');
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  log('listo. Registro en fotos-partido/elegidas.json');
})().catch(e => { log('Error: ' + e.message); process.exit(1); });
