#!/usr/bin/env node
/* Foto de cada partido, como la buscaría Luchi: Google Imágenes, con su
   sesión de Chrome (ventana abierta por chrome_winning.js), buscando por
   el goleador (o la figura si no hubo goles), última semana.

   Por partido guarda las 4 mejores opciones:
     fotos-partido/<game_id>-op1.jpg … -op4.jpg   (la 1 también como -original.jpg)
   y en fotos-partido/elegidas.json el registro: qué es, por qué, de dónde,
   y el encuadre sugerido (centrado automático).

   Uso:  node foto-google.js <fecha> [--game <id>] [--comp 724] [--forzar]
   Necesita la ventana de Chrome de Winning abierta (tools/chrome_ws.txt). */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const puppeteer = require('puppeteer-core');
const sharp = require('sharp');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SUPABASE_URL = 'https://ketwxvbrhqbemlflmadu.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtldHd4dmJyaHFiZW1sZmxtYWR1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4NjA4MDcsImV4cCI6MjA4NjQzNjgwN30.-qXPLMSFEiRORNk5EUKrD16VDiMXtv-VfcDSWpzWzsg';
const RAIZ = path.resolve(__dirname, '..');
const DEST = path.join(RAIZ, 'fotos-partido');
const TMP = path.join(DEST, '_tmp');
const WS_FILE = [path.join(__dirname, 'chrome_ws.txt'),
  'C:/Users/lucia/AppData/Local/Temp/claude/C--Users-lucia/0da49e29-1dd2-4287-9c12-59919a03f76b/scratchpad/chrome_ws.txt'].find(f => fs.existsSync(f));
const OPCIONES = 4;

const dormir = ms => new Promise(r => setTimeout(r, ms));
// Corta una promesa que no vuelve (Chrome colgado en un click, una pestaña ajena, etc.).
const conTiempo = (pr, ms, que) => Promise.race([pr, new Promise((_, rj) => setTimeout(() => rj(new Error('se pasó de ' + ms / 1000 + 's: ' + que)), ms))]);
const ahora = () => new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
const log = m => console.log('[' + ahora() + '] ' + m);
const sinAcentos = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

function args() {
  const a = process.argv.slice(2);
  const i = k => a.indexOf(k);
  return {
    matchday: parseInt(a.find(x => /^\d+$/.test(x)), 10),
    competition: i('--comp') >= 0 ? parseInt(a[i('--comp') + 1], 10) : 724,
    season: 2026,
    game: i('--game') >= 0 ? parseInt(a[i('--game') + 1], 10) : null,
    forzar: a.includes('--forzar'),
  };
}

// ── Datos del partido ─────────────────────────────────────────────────
const H = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY };
const HL = { ...H, 'Accept-Profile': 'winning_lpf' };
const rest = async (ruta, h) => { const r = await fetch(SUPABASE_URL + '/rest/v1/' + ruta, { headers: h || H }); if (!r.ok) throw new Error(ruta.split('?')[0] + ': HTTP ' + r.status); return r.json(); };

async function partidos(cfg) {
  const f = await rest('v_fixtures?select=game_id,home_id,away_id,home_team_display,away_team_display,home_score,away_score' +
    '&competition_id=eq.' + cfg.competition + '&season_id=eq.' + cfg.season + '&matchday=eq.' + cfg.matchday);
  return cfg.game ? f.filter(x => x.game_id === cfg.game) : f;
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

/* Qué buscar: la búsqueda que haría Luchi. Con goles, el goleador más
   relevante (el último del ganador; en empate, el último). Sin goles, la
   figura. Una segunda búsqueda con otro goleador si lo hay. */
function consultas(j, goles, fig) {
  const local = j.home_team_display, visita = j.away_team_display;
  const q = [];
  if (goles.length) {
    const ganador = j.home_score > j.away_score ? j.home_id : j.away_score > j.home_score ? j.away_id : null;
    const delGanador = ganador ? goles.filter(g => g.team === ganador) : goles;
    const vistos = new Set();
    // Los goleadores del ganador, del último al primero (hasta dos), y uno del otro equipo.
    for (const g of [...(delGanador.length ? delGanador : goles)].reverse()) {
      if (vistos.has(g.apellido) || vistos.size >= 2) continue; vistos.add(g.apellido);
      q.push({ texto: `${g.nombre} gol ${local} ${visita} festejo`, quien: g.apellido, motivo: 'goleador' });
    }
    const otro = goles.filter(g => !vistos.has(g.apellido)).slice(-1)[0];
    if (otro) q.push({ texto: `${otro.nombre} gol ${local} ${visita}`, quien: otro.apellido, motivo: 'goleador' });
  } else if (fig) {
    q.push({ texto: `${fig.nombre} ${local} ${visita}`, quien: fig.apellido, motivo: 'figura' });
    q.push({ texto: `${local} ${visita} ${j.home_score}-${j.away_score}`, quien: null, motivo: 'partido' });
  }
  return q;
}

// ── Google Imágenes con la sesión ─────────────────────────────────────
async function buscarGoogle(p, texto) {
  await p.goto('https://www.google.com/search?tbm=isch&hl=es&gl=ar&q=' + encodeURIComponent(texto) + '&tbs=qdr:w', { waitUntil: 'networkidle2', timeout: 90000 });
  await dormir(2000);
  await p.evaluate(async () => { for (let y = 0; y < 3000; y += 600) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 350)); } });
  const visibles = await p.evaluate(() => [...document.querySelectorAll('img')].filter(i => i.width > 80 && i.height > 80).length);
  if (/\/sorry\//.test(p.url()) || visibles < 5) throw new Error('Google pidió captcha: resolvelo en la ventana de Chrome y volvé a correr');
  const html = await p.content();
  // Títulos visibles de los resultados, para saber de qué es cada foto (en orden).
  const titulos = await p.evaluate(() => [...document.querySelectorAll('img')].filter(i => i.width > 80 && i.height > 80)
    .map(i => { let c = i; for (let k = 0; k < 6 && c; k++) { c = c.parentElement; if (c && /\S/.test(c.innerText || '') && (c.innerText || '').length > 15) break; } return (c && c.innerText || '').replace(/\s+/g, ' ').slice(0, 120); }));
  let urls = [...new Set((html.match(/https?:\/\/[^"'\\\s<>]+\.(?:jpe?g|png|webp)(?:\?[^"'\\\s<>]*)?/gi) || [])
    .map(u => u.replace(/\\u003d/g, '=').replace(/\\u0026/g, '&'))
    .filter(u => !/google\.|gstatic|googleusercontent|ytimg|youtube|\/logo|icon|avatar|sprite/i.test(u)))];
  // A veces Google no pone los originales en la página: se abren los
  // primeros resultados uno por uno y se lee la imagen grande del panel.
  if (urls.length < 6) {
    const porClick = [];
    const miniaturas = await p.$$('img');
    const antes = new Set(await p.browser().pages());
    let abiertas = 0;
    for (const im of miniaturas) {
      const ok = await im.evaluate(i => i.width > 80 && i.height > 80 && i.offsetParent !== null).catch(() => false);
      if (!ok) continue;
      // Los resultados que son videos o redes (Facebook, Instagram, YouTube…) abren otra pestaña y dejan colgado el click: se saltean.
      const destino = await im.evaluate(i => { const a = i.closest('a'); return a ? (a.href || '') : ''; }).catch(() => '');
      if (/facebook\.|fb\.watch|instagram\.|youtube\.|youtu\.be|tiktok\.|twitter\.|(^|\/)x\.com/i.test(destino)) continue;
      // Click desde la página (el click nativo de puppeteer se cuelga en Google Imágenes); si igual falla, se abandona el camino por click.
      try { await conTiempo(im.evaluate(i => i.click()), 5000, 'click en resultado'); } catch (e) { console.log('   click colgado: sigo sin abrir más resultados'); break; }
      await dormir(1400);
      let src = null;
      try { src = await conTiempo(p.evaluate(() => { const c = [...document.querySelectorAll('img')].filter(i => i.naturalWidth > 400 && /^https?:/.test(i.src) && !/gstatic|google/.test(i.src)); return c.length ? c[c.length - 1].src : null; }), 5000, 'leer panel'); } catch (e) {}
      if (src && !porClick.includes(src)) porClick.push(src);
      if (++abiertas >= 5) break;
    }
    // Si algún click abrió una pestaña, se cierra para no dejar basura.
    for (const otra of await p.browser().pages().catch(() => [])) if (!antes.has(otra)) await otra.close().catch(() => {});
    urls = [...new Set([...urls, ...porClick])];
  }
  return { urls, titulos };
}

function bajar(u, f) {
  try { execSync(`curl -sL -A "${UA}" --max-time 25 "${u.replace(/"/g, '%22')}" -o "${f}"`, { stdio: 'ignore' }); return fs.existsSync(f) && fs.statSync(f).size > 8000; } catch (e) { return false; }
}

/* Puntaje con los criterios de Luchi: del partido correcto (lo garantiza la
   búsqueda + última semana), del goleador (nombre en URL/título), lo más
   grande y nítida, sin barrera de tamaño. */
const MEDIOS_BUENOS = /tycsports|ole\.com|infobae|lanacion|lavoz|ellitoral|eldia\.com|lagaceta|velez\.com|gimnasia\.org|belgrano\.com|\.org\.ar|cariverplate|bocajuniors|sanlorenzo|racingclub|independiente|cloudinary|fbsbx|cdninstagram/i;
function puntuar(c, quien, titulo, equipos) {
  const anchoUtil = Math.min(c.w, c.h * 1080 / 1350);
  const escala = 1080 / anchoUtil;
  const t = sinAcentos(c.u + ' ' + (titulo || ''));
  const goleador = !!(quien && t.includes(sinAcentos(quien)));
  const equipo = (equipos || []).some(e => t.includes(e));
  const festejo = /festej|celebr|grit|abraz/.test(t);
  const video = /captura|video|screenshot|jwplayer|poster/.test(t);
  let nota = 0;
  nota += Math.min(3, 1 / escala) * 30;            // tamaño: hasta 90
  nota += c.h >= c.w ? 20 : 0;                      // vertical ayuda
  nota += goleador ? 40 : 0;
  nota += equipo ? 15 : 0;
  nota += festejo ? 15 : 0;
  nota += MEDIOS_BUENOS.test(c.u) ? 10 : 0;
  nota -= video ? 60 : 0;
  // Sin ninguna señal del partido en el texto, casi seguro es de otra cosa.
  if (!goleador && !equipo) nota -= 100;
  // Muy chica: no puede ganar por el nombre.
  if (c.w < 700) nota -= 80; else if (c.w < 900) nota -= 35;
  return { nota: Math.round(nota), escala: +escala.toFixed(2), goleador, equipo, festejo, video };
}
/* Palabras de los equipos que sirven para reconocerlos en un título o URL. */
const RELLENO = new Set(['club', 'atletico', 'de', 'la', 'del', 'los', 'las', 'old', 'boys', 'plate', 'juniors', 'sarsfield', 'central', 'deportivo', 'rio', 'iv']);
const palabrasEquipo = nombre => sinAcentos(nombre).split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !RELLENO.has(w));

/* Encuadre sugerido: dónde cae el recorte 4:5 que sharp considera más
   interesante (caras y contraste), pasado a background-position en %. */
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

// ── Main ──────────────────────────────────────────────────────────────
(async () => {
  const cfg = args();
  if (!cfg.matchday) { console.error('Uso: node foto-google.js <fecha> [--game <id>] [--forzar]'); process.exit(2); }
  if (!WS_FILE) { console.error('No está abierta la ventana de Chrome de Winning (falta chrome_ws.txt). Abrila con chrome_winning.js.'); process.exit(2); }
  fs.mkdirSync(TMP, { recursive: true });
  const registroPath = path.join(DEST, 'elegidas.json');
  let registro = {}; try { registro = JSON.parse(fs.readFileSync(registroPath, 'utf8')); } catch (e) {}

  let browser;
  try { browser = await puppeteer.connect({ browserWSEndpoint: fs.readFileSync(WS_FILE, 'utf8').trim(), defaultViewport: null }); }
  catch (e) { console.error('No pude conectar con la ventana de Chrome. Abrila de nuevo con chrome_winning.js.'); process.exit(2); }
  let page = await browser.newPage();
  await page.setUserAgent(UA);

  const juegos = await partidos(cfg);
  log('fecha ' + cfg.matchday + ': ' + juegos.length + ' partido(s)');
  for (const j of juegos) {
    const titulo = `${j.home_team_display} ${j.home_score ?? ''}-${j.away_score ?? ''} ${j.away_team_display}`;
    if (registro[j.game_id] && registro[j.game_id].opciones && !cfg.forzar) { console.log('\n── ' + titulo + '  ya tiene opciones (--forzar para rehacer)'); continue; }
    console.log('\n── ' + titulo + '  (' + j.game_id + ')');
    const goles = await goleadores(j.game_id);
    const fig = goles.length ? null : await figura(j.game_id, cfg);
    const qs = consultas(j, goles, fig);
    if (!qs.length) { console.log('   sin goleador ni figura: no busco'); continue; }

    const cands = []; const vistos = new Set();
    for (const q of qs) {
      // Una búsqueda alcanza casi siempre; las siguientes sólo si la anterior no trajo nada útil.
      if (cands.filter(c => c.nota > 0).length >= 3) break;
      console.log('   Google: «' + q.texto + '»');
      let res;
      try { res = await conTiempo(buscarGoogle(page, q.texto), 150000, 'búsqueda en Google'); }
      catch (e) {
        console.log('   ' + e.message);
        if (/se pasó de/.test(e.message)) { try { await page.close(); } catch (x) {} page = await browser.newPage(); await page.setUserAgent(UA); }
        break;
      }
      let bajadas = 0;
      for (let i = 0; i < res.urls.length && bajadas < 14; i++) {
        const u = res.urls[i]; if (vistos.has(u)) continue; vistos.add(u);
        const f = path.join(TMP, j.game_id + '_' + cands.length + '.img');
        if (!bajar(u, f)) continue;
        let m; try { m = await sharp(f).metadata(); } catch (e) { continue; }
        if (m.width < 500 || m.height < 400) continue;
        const c = { u, f, w: m.width, h: m.height, host: u.replace(/^https?:\/\/(www\.)?/, '').split('/')[0], titulo: res.titulos[i] || '', consulta: q.texto, quien: q.quien, motivo: q.motivo };
        Object.assign(c, puntuar(c, q.quien, c.titulo, [...palabrasEquipo(j.home_team_display), ...palabrasEquipo(j.away_team_display)]));
        cands.push(c); bajadas++;
      }
      await dormir(25000 + Math.random() * 10000);   // ritmo de persona: 25-35 s entre búsquedas
    }
    // Lo que se había elegido a mano (respaldo) entra como candidata más, con su nota.
    try {
      const manual = JSON.parse(fs.readFileSync(path.join(DEST, 'elegidas-manual-fecha8.json'), 'utf8'))[j.game_id];
      if (manual && manual.url && !vistos.has(manual.url)) {
        const f = path.join(TMP, j.game_id + '_manual.img');
        if (bajar(manual.url, f)) { const m = await sharp(f).metadata(); const c = { u: manual.url, f, w: m.width, h: m.height, host: manual.medio || 'a mano', titulo: manual.que || '', consulta: 'elegida a mano antes', quien: null, motivo: 'manual' }; Object.assign(c, puntuar(c, null, c.titulo, [])); c.nota += 60; c.goleador = !!manual.goleador; cands.push(c); }
      }
    } catch (e) {}
    if (!cands.length) { console.log('   no encontré fotos'); continue; }
    cands.sort((a, b) => b.nota - a.nota);
    const mejores = cands.slice(0, OPCIONES);
    const opciones = [];
    for (let k = 0; k < mejores.length; k++) {
      const c = mejores[k];
      const nombre = j.game_id + '-op' + (k + 1) + '.jpg';
      await sharp(c.f).jpeg({ quality: 92 }).toFile(path.join(DEST, nombre));
      if (k === 0) { fs.copyFileSync(path.join(DEST, nombre), path.join(DEST, j.game_id + '-original.jpg')); await sharp(c.f).resize(1080, 1350, { fit: 'cover', position: 'attention' }).jpeg({ quality: 92 }).toFile(path.join(DEST, j.game_id + '.jpg')); }
      const porque = [];
      if (c.goleador) porque.push('nombra a ' + c.quien + ' (' + c.motivo + ')'); else if (c.quien) porque.push('no nombra a ' + c.quien + ' en el título ni la URL');
      if (c.festejo) porque.push('parece un festejo (por el texto)');
      porque.push(c.escala <= 1.001 ? 'entra sin estirar' : 'se estira ' + c.escala + 'x');
      if (c.h >= c.w) porque.push('vertical');
      if (c.video) porque.push('parece captura de video (penalizada)');
      opciones.push({ archivo: 'fotos-partido/' + nombre, medio: c.host, tam: c.w + 'x' + c.h, escala: c.escala, url: c.u, nota: c.nota,
        que: 'Resultado ' + (k + 1) + ' de Google para «' + c.consulta + '»' + (c.titulo ? ': ' + c.titulo.slice(0, 90) : ''),
        porque: porque.join(' · '), como: 'Google Imágenes con la sesión de Luchi, última semana', pos: await encuadre(c.f) });
      console.log('   ' + (k + 1) + '. ' + (c.w + 'x' + c.h).padEnd(11) + c.host.padEnd(26) + 'nota ' + String(c.nota).padEnd(4) + (c.goleador ? 'GOLEADOR ' : '') + (c.h >= c.w ? 'vertical ' : '') + (c.escala <= 1.001 ? 'sin estirar' : 'estira ' + c.escala + 'x'));
    }
    registro[j.game_id] = { partido: titulo, buscado: qs.map(q => q.texto), opciones, elegida: 0, medio: opciones[0].medio, tam: opciones[0].tam, escala: opciones[0].escala, que: opciones[0].que, porque: opciones[0].porque, como: opciones[0].como, url: opciones[0].url, actualizado: new Date().toISOString() };
    fs.writeFileSync(registroPath, JSON.stringify(registro, null, 1));
  }
  await page.close(); browser.disconnect();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  log('listo. Registro en fotos-partido/elegidas.json');
})().catch(e => { log('Error: ' + e.message); process.exit(1); });
