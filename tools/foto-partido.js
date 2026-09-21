#!/usr/bin/env node
/* Foto de cada partido de una fecha, por el camino corto que funcionó:
   la foto PRINCIPAL (og:image) de las notas que hablan del partido, en el
   tamaño más grande que dé el CDN. Nada de rastrear todas las imágenes de
   la página — ahí se colaban las miniaturas de otras notas.

   Criterios (de Luchi): que se estire lo mínimo, y que sea del goleador o
   de lo destacado. Las capturas de video quedan al final.

   Uso:  node foto-partido.js <fecha> [--game <id>] [--comp 724] [--forzar]
   Deja: fotos-partido/<game_id>-original.jpg   (la foto entera, para mover)
         fotos-partido/<game_id>.jpg            (recorte 4:5 centrado)
         fotos-partido/elegidas.json            (de dónde salió cada una)  */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SUPABASE_URL = 'https://ketwxvbrhqbemlflmadu.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtldHd4dmJyaHFiZW1sZmxtYWR1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4NjA4MDcsImV4cCI6MjA4NjQzNjgwN30.-qXPLMSFEiRORNk5EUKrD16VDiMXtv-VfcDSWpzWzsg';

const SITEMAPS = [
  ['TyC',     'https://www.tycsports.com/sitemap_news_48hs.xml'],
  ['Olé',     'https://www.ole.com.ar/sitemaps/sitemap_google_news.xml'],
  ['DobleAm', 'https://www.dobleamarilla.com.ar/sitemap-news.xml'],
  ['LaNación','https://www.lanacion.com.ar/sitemap-news.xml'],
  ['UnoSF',   'https://www.unosantafe.com.ar/sitemap-news.xml'],
  ['Litoral', 'https://www.ellitoral.com/sitemaps/sitemap_google_news.xml'],
];

const RAIZ = path.resolve(__dirname, '..');
const DEST = path.join(RAIZ, 'fotos-partido');
const TMP = path.join(DEST, '_tmp');
const dormir = ms => new Promise(r => setTimeout(r, ms));
const ahora = () => new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
const log = m => console.log('[' + ahora() + '] ' + m);
const sinAcentos = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

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

// ── Datos ─────────────────────────────────────────────────────────────
const H = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY };
async function partidos(cfg) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/v_fixtures?select=game_id,home_team_display,away_team_display,home_score,away_score' +
    '&competition_id=eq.' + cfg.competition + '&season_id=eq.' + cfg.season + '&matchday=eq.' + cfg.matchday, { headers: H });
  if (!r.ok) throw new Error('no pude leer el fixture: HTTP ' + r.status);
  const filas = await r.json();
  return cfg.game ? filas.filter(f => f.game_id === cfg.game) : filas;
}
async function goleadores(gameId) {
  const h = { ...H, 'Accept-Profile': 'winning_lpf' };
  try {
    const g = await (await fetch(SUPABASE_URL + '/rest/v1/goal_events?select=scorer_player_id&game_id=eq.' + gameId, { headers: h })).json();
    const ids = [...new Set((g || []).map(x => x.scorer_player_id).filter(Boolean))];
    if (!ids.length) return [];
    const p = await (await fetch(SUPABASE_URL + '/rest/v1/player_universe?select=last_name,known_name&player_id=in.(' + ids.join(',') + ')', { headers: h })).json();
    return (p || []).map(x => x.last_name || (x.known_name || '').split(' ').pop() || '').filter(x => x.length >= 4);
  } catch (e) { return []; }
}

// ── Notas ─────────────────────────────────────────────────────────────
const RELLENO = new Set(['de', 'del', 'la', 'el', 'club', 'atletico', 'ca', 'aa', 'y', 'plate', 'juniors', 'central', 'sarsfield', 'old', 'boys']);
const palabras = s => sinAcentos(s).split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !RELLENO.has(w));

function get(url) {
  return execSync(`curl -sL -A "${UA}" --compressed --max-time 40 "${url}"`, { encoding: 'utf8', maxBuffer: 40e6 });
}
function pesoNota(slug, goles) {
  let p = 0;
  if (/galeria|fotos|imagenes/.test(slug)) p += 30;
  if (goles.some(g => slug.includes(sinAcentos(g)))) p += 20;
  if (/festej|gol|triunf|gano|victoria|figura|resumen/.test(slug)) p += 5;
  if (/video|vivo|formacion|previa|arbitro|entrada|puntaje|donde-ver|hora/.test(slug)) p -= 15;
  return p;
}

// ── Fotos ─────────────────────────────────────────────────────────────
function bajar(u, f) {
  try {
    execSync(`curl -sL -A "${UA}" --max-time 40 "${u.replace(/"/g, '%22')}" -o "${f}"`, { stdio: 'ignore' });
    return fs.existsSync(f) && fs.statSync(f).size > 5000;
  } catch (e) { return false; }
}
/* Del recorte que muestra la nota al original: cada CDN tiene su forma. */
function variantes(u) {
  const l = u.split('?')[0];
  const out = [];
  const ole = l.replace(/_\d{3,4}x\d{1,4}__\d(?=\.\w+$)/, '_2000x1500__1'); if (ole !== l) out.push(ole);
  const lit = l.replace(/_\d{3,4}x\d{1,4}__\d(?=\.\w+$)/, '_1565x0__1');    if (lit !== l) out.push(lit);
  const tyc = l.replace(/_\d{3,4}x\d{3,4}(?=\.\w+$)/, '');                   if (tyc !== l) out.push(tyc);
  out.push(l);                                                              // La Voz: sin query ya es el original
  return [...new Set(out)];
}
async function medir(f) {
  try { const m = await require('sharp')(f).metadata(); return { w: m.width, h: m.height }; } catch (e) { return null; }
}
function puntuar(w, h, texto, url, goles) {
  const anchoUtil = Math.min(w, h * 1080 / 1350);
  if (anchoUtil * 1350 / 1080 > h + 1) return null;
  const escala = 1080 / anchoUtil;
  if (escala > 2.2) return null;
  const t = sinAcentos(texto + ' ' + url);
  const goleador = goles.some(g => t.includes(sinAcentos(g)));
  const destacado = /festej|gol|celebr|abraz|grit|expuls|roja|ataj|figura|triunf/.test(t);
  const video = /video|captura|jwplayer|poster\.jpg|\/video\//.test(t);
  const escalon = escala <= 1.001 ? 300 : escala <= 1.2 ? 200 : escala <= 1.6 ? 100 : 50;
  const nota = escalon + Math.min(3, 1 / escala) * 10 + (goleador ? 40 : 0) + (destacado ? 15 : 0) - (video ? 250 : 0);
  return { escala, nota, goleador, destacado, video };
}

// ── Main ──────────────────────────────────────────────────────────────
(async () => {
  const cfg = args();
  if (!cfg.matchday) { console.error('Uso: node foto-partido.js <fecha> [--game <id>] [--forzar]'); process.exit(2); }
  fs.mkdirSync(TMP, { recursive: true });
  const juegos = await partidos(cfg);
  log('fecha ' + cfg.matchday + ': ' + juegos.length + ' partido(s)');

  const notas = [];
  for (const [medio, sm] of SITEMAPS) {
    try {
      const xml = get(sm);
      const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
      locs.forEach(u => notas.push({ medio, url: u, slug: sinAcentos(u) }));
    } catch (e) { log(medio + ': no pude leer el sitemap'); }
  }
  log(notas.length + ' notas en los sitemaps');

  const elegidasPath = path.join(DEST, 'elegidas.json');
  let elegidas = {}; try { elegidas = JSON.parse(fs.readFileSync(elegidasPath, 'utf8')); } catch (e) {}

  for (const j of juegos) {
    const titulo = j.home_team_display + ' ' + (j.home_score ?? '') + '-' + (j.away_score ?? '') + ' ' + j.away_team_display;
    const destino = path.join(DEST, j.game_id + '-original.jpg');
    if (fs.existsSync(destino) && !cfg.forzar) { console.log('\n── ' + titulo + '  ya tiene foto (usá --forzar para rehacer)'); continue; }
    console.log('\n── ' + titulo + '  (' + j.game_id + ')');

    const local = palabras(j.home_team_display), visita = palabras(j.away_team_display);
    const goles = await goleadores(j.game_id);
    const cands = notas
      .filter(n => local.some(k => n.slug.includes(k)) && visita.some(k => n.slug.includes(k)))
      .sort((a, b) => pesoNota(b.slug, goles) - pesoNota(a.slug, goles))
      .slice(0, 8);
    if (!cands.length) { console.log('   sin notas que nombren a los dos equipos'); continue; }

    const fotos = [];
    for (const c of cands) {
      let html = ''; try { html = get(c.url); } catch (e) { continue; }
      const og = (html.match(/property="og:image"\s+content="([^"]+)"/) || html.match(/content="([^"]+)"\s+property="og:image"/) || [])[1];
      const tit = (html.match(/property="og:title"\s+content="([^"]+)"/) || html.match(/<title>([^<]+)/) || [, ''])[1];
      if (!og) continue;
      let mejor = null;
      for (const v of variantes(og)) {
        const f = path.join(TMP, 'f' + fotos.length + '.img');
        if (!bajar(v, f)) continue;
        const m = await medir(f);
        if (m && (!mejor || m.w > mejor.w)) { mejor = { ...m, url: v, archivo: f + '.ok' }; fs.copyFileSync(f, mejor.archivo); }
        if (mejor && mejor.w >= 1500) break;
        await dormir(900);
      }
      if (!mejor) continue;
      const p = puntuar(mejor.w, mejor.h, tit, c.url, goles);
      if (!p) continue;
      fotos.push({ ...mejor, ...p, medio: c.medio, titulo: tit, nota: c.url });
      console.log('   ' + c.medio.padEnd(8) + (mejor.w + 'x' + mejor.h).padEnd(11) +
        (p.escala <= 1.001 ? 'no se estira' : 'estira ' + p.escala.toFixed(2) + 'x').padEnd(14) +
        (p.video ? 'VIDEO ' : '') + (p.goleador ? 'goleador ' : '') + (p.destacado ? 'destacado ' : '') + '· ' + tit.slice(0, 55));
      await dormir(1200);
    }
    if (!fotos.length) { console.log('   ninguna nota tenía foto usable'); continue; }
    fotos.sort((a, b) => b.nota - a.nota);
    const e = fotos[0];
    const sharp = require('sharp');
    await sharp(e.archivo).jpeg({ quality: 92 }).toFile(destino);
    await sharp(e.archivo).resize(1080, 1350, { fit: 'cover', position: 'centre' }).jpeg({ quality: 92 })
      .toFile(path.join(DEST, j.game_id + '.jpg'));
    elegidas[j.game_id] = { partido: titulo, medio: e.medio, tam: e.w + 'x' + e.h, escala: +e.escala.toFixed(2), titulo: e.titulo, nota: e.nota, url: e.url };
    fs.writeFileSync(elegidasPath, JSON.stringify(elegidas, null, 1));
    console.log('   → ' + e.medio + ' ' + e.w + 'x' + e.h + ' · ' + e.titulo.slice(0, 60));
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  console.log('\nListo. fotos-partido/<game_id>-original.jpg por partido, y elegidas.json con el detalle.');
})().catch(e => { log('Error: ' + e.message); process.exit(1); });
