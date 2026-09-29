// ¿Cómo suben las entrevistas y conferencias post-partido? Informe para decidir
// qué cuentas vigilar, en qué ventana y cómo reconocer una entrevista.
//
//   node tools/entrevistas-investigar.js <fecha> [--cuentas TNTSportsAR,ESPNArgentina] [--max 300]
//
// Lee con la API de X (claves X_API_KEY… como publicar-x.js; consume crédito: --max
// limita los tuits por cuenta) los tuits CON VIDEO de cada cuenta entre el primer
// partido de la fecha y 30 h después del último, y los cruza con los partidos
// (equipos, jugadores y DTs nombrados + hora). Suma lo que TNT subió a YouTube (RSS).
// Escribe captions/entrevistas-fecha<N>.md y captions/entrevistas-fecha<N>.json.
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = 'https://ketwxvbrhqbemlflmadu.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtldHd4dmJyaHFiZW1sZmxtYWR1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4NjA4MDcsImV4cCI6MjA4NjQzNjgwN30.-qXPLMSFEiRORNk5EUKrD16VDiMXtv-VfcDSWpzWzsg';
const COMPETITION = 724, SEASON = 2026;
const RAIZ = path.resolve(__dirname, '..');
const HORA = 3600e3;
const YT_TNT = 'UCI5RY8G0ar-hLIaUJvx58Lw';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const FECHA = +args.find(a => /^\d+$/.test(a));
const CUENTAS = opt('cuentas', 'TNTSportsAR,ESPNArgentina,TyCSports,LigaProfArg').split(',').map(s => s.trim().replace(/^@/, '')).filter(Boolean);
const MAX = +opt('max', 300);

const H = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY };
async function api(ruta, perfil) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + ruta, { headers: perfil ? { ...H, 'Accept-Profile': perfil } : H });
  if (!r.ok) throw new Error(ruta.split('?')[0] + ' -> HTTP ' + r.status);
  return r.json();
}
const sinAcentos = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const horaAR = d => new Date(new Date(d).getTime() - 3 * HORA).toISOString().replace('T', ' ').slice(5, 16);

/* Palabras que identifican a cada partido: nombres de los equipos (y apodos comunes) y apellidos del plantel. */
const APODOS = {
  'boca': ['xeneize'], 'river': ['millonario'], 'racing': ['academia'], 'independiente': ['rojo'], 'san lorenzo': ['ciclon', 'cuervo'],
  'estudiantes': ['pincha'], 'gimnasia': ['lobo', 'tripero'], 'velez': ['fortin'], 'huracan': ['globo'], 'newell': ['lepra'],
  'rosario central': ['canalla'], 'talleres': ['tallarin'], 'belgrano': ['pirata'], 'lanus': ['granate'], 'banfield': ['taladro'],
};
async function partidos(md) {
  const fx = await api('v_fixtures?select=game_id,matchday,kickoff_ts,home_id,away_id,home_team_display,away_team_display,home_score,away_score' +
    '&competition_id=eq.' + COMPETITION + '&season_id=eq.' + SEASON + '&matchday=eq.' + md + '&order=kickoff_ts');
  const equipos = [...new Set(fx.flatMap(f => [f.home_id, f.away_id]))];
  const plantel = await api('squads?select=player_id,team_id&team_id=in.(' + equipos.join(',') + ')', 'winning_lpf').catch(() => []);
  const ids = [...new Set(plantel.map(p => p.player_id))];
  const nombres = {};
  for (let i = 0; i < ids.length; i += 150) {
    const pu = await api('player_universe?select=player_id,known_name,last_name&player_id=in.(' + ids.slice(i, i + 150).join(',') + ')', 'winning_lpf').catch(() => []);
    pu.forEach(p => { nombres[p.player_id] = p; });
  }
  const porEquipo = {};
  plantel.forEach(p => { const n = nombres[p.player_id]; if (!n) return; const ap = sinAcentos(n.known_name || n.last_name).split(' ').pop(); if (ap && ap.length > 3) (porEquipo[p.team_id] = porEquipo[p.team_id] || new Set()).add(ap); });
  return fx.map(f => {
    const eq = [f.home_team_display, f.away_team_display].map(sinAcentos);
    const claves = new Set();
    eq.forEach(e => { claves.add(e); e.split(' ').filter(w => w.length > 3 && !['club', 'atletico', 'deportivo', 'plate', 'juniors'].includes(w)).forEach(w => claves.add(w)); Object.entries(APODOS).forEach(([k, v]) => { if (e.includes(k)) v.forEach(x => claves.add(x)); }); });
    return { ...f, nombre: f.home_team_display + ' ' + (f.home_score ?? '') + '-' + (f.away_score ?? '') + ' ' + f.away_team_display, claves: [...claves], jugadores: [...(porEquipo[f.home_id] || []), ...(porEquipo[f.away_id] || [])] };
  });
}

/* A qué partido apunta un tuit: por palabras; si empata, el más cercano en el tiempo. */
function partidoDe(t, ps) {
  const txt = ' ' + sinAcentos(t.text).replace(/[#@]/g, ' ') + ' ';
  const pal = w => new RegExp('[^a-z]' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^a-z]').test(txt);
  let mejor = null;
  for (const p of ps) {
    const eq = p.claves.filter(pal), ju = p.jugadores.filter(pal);
    const puntos = eq.length * 2 + ju.length;
    if (!puntos) continue;
    const dist = Math.abs(new Date(t.created_at) - new Date(p.kickoff_ts));
    if (!mejor || puntos > mejor.puntos || (puntos === mejor.puntos && dist < mejor.dist)) mejor = { p, puntos, dist, por: eq.concat(ju) };
  }
  return mejor;
}
function tipo(t) {
  const s = sinAcentos(t.text);
  const marcas = [];
  if (/🗣/.test(t.text)) marcas.push('🗣️');
  if (/[“"«][^”"»]{12,}[”"»]/.test(t.text)) marcas.push('frase entre comillas');
  if (/conferencia/.test(s)) marcas.push('conferencia');
  if (/hablo|palabras de|dijo|declaraciones|entrevista|mano a mano|en zona mixta|zona mixta|post ?partido|postpartido/.test(s)) marcas.push('habló/entrevista');
  if (/\bgol\b|golazo|golaz|atajad|jugada|resumen|highlights|lo que no se vio/.test(s)) marcas.push('jugada/gol');
  return marcas;
}

async function tuitsDe(client, usuario, desde, hasta) {
  let u;
  try { u = await client.v2.userByUsername(usuario); } catch (e) { return { usuario, error: 'no se pudo leer la cuenta: ' + (e.data && e.data.detail || e.message) }; }
  if (!u.data) return { usuario, error: 'la cuenta no existe' };
  const out = [];
  const tl = await client.v2.userTimeline(u.data.id, {
    start_time: desde.toISOString(), end_time: hasta.toISOString(), max_results: 100, exclude: ['retweets', 'replies'],
    'tweet.fields': ['created_at', 'public_metrics', 'attachments'], expansions: ['attachments.media_keys'], 'media.fields': ['type', 'duration_ms', 'variants'],
  });
  for await (const t of tl) {
    const media = tl.includes.medias(t) || [];
    const video = media.find(m => m.type === 'video');
    out.push({ id: t.id, created_at: t.created_at, text: t.text, likes: (t.public_metrics || {}).like_count, vistas: (t.public_metrics || {}).impression_count, video: video ? Math.round((video.duration_ms || 0) / 1000) : null });
    if (out.length >= MAX) break;
  }
  return { usuario, nombre: u.data.name, leidos: out.length, tope: out.length >= MAX, tuits: out };
}

async function youtubeTNT() {
  try {
    const x = await (await fetch('https://www.youtube.com/feeds/videos.xml?channel_id=' + YT_TNT)).text();
    const re = /<entry>[\s\S]*?<yt:videoId>(.*?)<\/yt:videoId>[\s\S]*?<title>(.*?)<\/title>[\s\S]*?<published>(.*?)<\/published>/g;
    const out = []; let m; while ((m = re.exec(x))) out.push({ id: m[1], titulo: m[2].replace(/&amp;/g, '&').replace(/&quot;/g, '"'), fecha: m[3] });
    return out;
  } catch (e) { return []; }
}

async function main() {
  if (!FECHA) { console.log('Uso: node tools/entrevistas-investigar.js <fecha> [--cuentas A,B] [--max 300]'); process.exit(1); }
  const { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET } = process.env;
  if (!X_API_KEY) throw new Error('faltan las claves de X en el ambiente');
  const { TwitterApi } = require('twitter-api-v2');
  const client = new TwitterApi({ appKey: X_API_KEY, appSecret: X_API_SECRET, accessToken: X_ACCESS_TOKEN, accessSecret: X_ACCESS_SECRET });

  const ps = await partidos(FECHA);
  if (!ps.length) throw new Error('no hay partidos de la fecha ' + FECHA);
  const desde = new Date(new Date(ps[0].kickoff_ts).getTime() - 2 * HORA);
  const hasta = new Date(Math.min(Date.now() - 60e3, new Date(ps[ps.length - 1].kickoff_ts).getTime() + 30 * HORA));
  console.log(`Fecha ${FECHA}: ${ps.length} partidos, de ${horaAR(desde)} a ${horaAR(hasta)} (hora AR)`);

  const cuentas = [];
  for (const c of CUENTAS) {
    const r = await tuitsDe(client, c, desde, hasta);
    console.log('@' + c + ': ' + (r.error || r.leidos + ' tuits leídos' + (r.tope ? ' (tope --max)' : '')));
    cuentas.push(r);
  }

  // Cada tuit con video, con su partido y cuánto después del final salió.
  const filas = [];
  cuentas.filter(c => c.tuits).forEach(c => c.tuits.filter(t => t.video != null).forEach(t => {
    const m = partidoDe(t, ps);
    const fin = m && new Date(m.p.kickoff_ts).getTime() + 115 * 60e3;   // pitazo aproximado
    filas.push({ cuenta: c.usuario, ...t, partido: m ? m.p.nombre : null, game_id: m && m.p.game_id, por: m ? m.por.slice(0, 4) : [], min_desde_final: m ? Math.round((new Date(t.created_at) - fin) / 60e3) : null, marcas: tipo(t) });
  }));
  const esEntrevista = f => f.marcas.some(x => x !== 'jugada/gol') && !f.marcas.includes('jugada/gol') || f.marcas.includes('🗣️');
  const yt = await youtubeTNT();

  // ── Informe ──
  const L = [];
  L.push(`# Entrevistas post-partido en X — fecha ${FECHA} del Clausura 2026`, '');
  L.push(`Ventana: ${horaAR(desde)} a ${horaAR(hasta)} (hora argentina). Solo tuits propios con video (sin retuits ni respuestas).`, '');
  L.push('## Por cuenta', '', '| cuenta | tuits leídos | con video | parecen entrevista | con partido identificado |', '|---|---|---|---|---|');
  cuentas.forEach(c => {
    if (c.error) { L.push(`| @${c.usuario} | ${c.error} | | | |`); return; }
    const v = filas.filter(f => f.cuenta === c.usuario);
    L.push(`| @${c.usuario} | ${c.leidos}${c.tope ? ' (tope)' : ''} | ${v.length} | ${v.filter(esEntrevista).length} | ${v.filter(f => f.partido).length} |`);
  });
  L.push('', '## Por partido (entrevistas encontradas)', '');
  ps.forEach(p => {
    const e = filas.filter(f => f.game_id === p.game_id && esEntrevista(f)).sort((a, b) => a.created_at.localeCompare(b.created_at));
    L.push(`### ${p.nombre} — ${horaAR(p.kickoff_ts)}`, e.length ? '' : '_Nada que parezca entrevista._', '');
    e.forEach(f => L.push(`- **@${f.cuenta}** ${horaAR(f.created_at)} (${f.min_desde_final >= 0 ? '+' : ''}${f.min_desde_final} min del final aprox.), video ${f.video} s, ${f.marcas.join(', ')} — [link](https://x.com/${f.cuenta}/status/${f.id})`, `  > ${f.text.replace(/\s+/g, ' ').slice(0, 280)}`));
    L.push('');
  });
  const demoras = filas.filter(f => f.partido && esEntrevista(f) && f.min_desde_final != null).map(f => f.min_desde_final).sort((a, b) => a - b);
  if (demoras.length) L.push('## Demora', '', `Desde el final aprox. (kickoff + 115 min): mínima ${demoras[0]} min, mediana ${demoras[Math.floor(demoras.length / 2)]} min, máxima ${demoras[demoras.length - 1]} min.`, '');
  const sueltos = filas.filter(f => !f.partido && esEntrevista(f));
  if (sueltos.length) { L.push('## Parecen entrevista pero no se identificó el partido', ''); sueltos.slice(0, 30).forEach(f => L.push(`- @${f.cuenta} ${horaAR(f.created_at)} — ${f.text.replace(/\s+/g, ' ').slice(0, 200)} — [link](https://x.com/${f.cuenta}/status/${f.id})`)); L.push(''); }
  L.push('## Otros videos (goles, jugadas, etc.)', '');
  filas.filter(f => !esEntrevista(f)).slice(0, 40).forEach(f => L.push(`- @${f.cuenta} ${horaAR(f.created_at)} ${f.partido ? '[' + f.partido + '] ' : ''}${f.marcas.join(', ')} — ${f.text.replace(/\s+/g, ' ').slice(0, 140)}`));
  L.push('', '## YouTube de TNT Sports (últimos 15 videos, RSS)', '');
  yt.forEach(v => L.push(`- ${horaAR(v.fecha)} — ${v.titulo} — https://youtu.be/${v.id}`));

  const dir = path.join(RAIZ, 'captions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `entrevistas-fecha${FECHA}.md`), L.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, `entrevistas-fecha${FECHA}.json`), JSON.stringify({ fecha: FECHA, desde, hasta, cuentas: cuentas.map(c => ({ usuario: c.usuario, error: c.error, leidos: c.leidos })), filas, youtube: yt }, null, 2));
  console.log(`Listo: captions/entrevistas-fecha${FECHA}.md (${filas.length} videos, ${filas.filter(esEntrevista).length} parecen entrevista)`);
  console.log('Tuits leídos en total: ' + cuentas.reduce((s, c) => s + (c.leidos || 0), 0));
}

main().catch(e => { console.error(e.data ? JSON.stringify(e.data) : (e.message || e)); process.exit(1); });
