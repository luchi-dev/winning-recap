#!/usr/bin/env node
/**
 * vigilante.js — busca solo las fotos del Recap, en el MOMENTO en que hacen falta.
 *
 *   node vigilante.js            mira si es momento de algo y lo hace
 *   node vigilante.js --mirar    sólo dice qué haría (no baja nada)
 *
 * Corre en GitHub Actions (.github/workflows/fotos.yml), no en la compu de
 * nadie. Es un vigilante DE GUARDIA: mientras haya fútbol que mirar (un partido
 * en las próximas 2 h, en juego o recién terminado, o una fecha esperando que
 * cierre el puntaje) la corrida se queda despierta mirando el fixture cada
 * minuto, y antes de que GitHub la corte (6 h) lanza ella misma la siguiente.
 * El cron de GitHub sólo sirve para arrancar la guardia: el 21-sep-2026 sonó 1
 * vez de 131 y se perdió Lanús-Estudiantes y el cierre de la fecha 10.
 * Sólo se trabaja en los momentos que definió Luchi según cuándo postea:
 *
 *   MINUTO ~75 DEL PARTIDO  pre-búsqueda: foto del partido (los goles y festejos
 *                           ya están publicados) y caras del Top 5, para que al
 *                           pitazo la placa ya esté lista.
 *   PITAZO FINAL            se queda despierto mirando el partido cada 30 s. Si
 *                           un gol sobre la hora cambió goleadores o resultado,
 *                           rehace la búsqueda. Completa las caras del Top 5.
 *   30 MIN DESPUÉS          UN reintento, sólo si la foto quedó floja (chica o
 *                           muy estirada) o no hubo. Después no insiste más.
 *   FIN DEL DÍA             caras de los MVPs del día.
 *   CIERRE DE PUNTAJES      caras de Equipo Ideal, Ganador de la fecha, MVPs y
 *                           Super Suplentes, apenas existe el equipo ideal.
 *                           Y los captions del 11 Ideal escritos como editor
 *                           (tools/captions.js → captions.json), si hay
 *                           ANTHROPIC_API_KEY. Dos intentos por fecha.
 *
 * Fuera de esos momentos dice "no es momento" y termina. La cuenta de lo hecho
 * se lleva en vigilante.json. Una cara se intenta 2 veces como mucho; las
 * dudosas (fotos/_revisar) no se reintentan: hay que mirarlas.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SUPABASE_URL = 'https://ketwxvbrhqbemlflmadu.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtldHd4dmJyaHFiZW1sZmxtYWR1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4NjA4MDcsImV4cCI6MjA4NjQzNjgwN30.-qXPLMSFEiRORNk5EUKrD16VDiMXtv-VfcDSWpzWzsg';

const COMPETITION = 724, SEASON = 2026;
const RAIZ = path.resolve(__dirname, '..');
const ESTADO = path.join(RAIZ, 'vigilante.json');
const REGISTRO = path.join(RAIZ, 'fotos-partido', 'elegidas.json');
const DIR_FOTOS = path.join(RAIZ, 'fotos');
const DIR_REVISAR = path.join(DIR_FOTOS, '_revisar');

const MIN = 60e3, HORA = 3600e3, DIA = 24 * HORA;
const PRE_DESDE = 30 * MIN;        // minutos de segundo tiempo para arrancar la pre-búsqueda (~min 75)
const ESPERA_MAX = 80 * MIN;       // si a los 80' de segundo tiempo no figura terminado, no se lo espera más
const REINTENTO = 30 * MIN;        // el único reintento de una foto floja
const DIAS_PARTIDO = 3;            // pasado esto, un partido ya no se toca
const DIAS_FECHA = 5;              // ni los pósters de una fecha (el scoring cierra hasta 13 h después)
const INTENTOS_CARA = 2, ENTRE_CARA = 30 * MIN;
const MAX_CARAS = 30;              // por pasada
const CORRIDA_MAX = 5 * HORA + 40 * MIN;   // el job de GitHub corta a las 6 h: antes de eso se lanza el relevo
const GUARDIA_ANTES = 2 * HORA;    // desde cuánto antes del kickoff se queda despierto
const GUARDIA_DESPUES = 45 * MIN;  // hasta cuánto después del pitazo (cubre el reintento de los 30 min)
const ESPERA_PUNTAJE = 16 * HORA;  // cuánto se espera el cierre del puntaje tras el último partido

const MIRAR = process.argv.includes('--mirar');
const dormir = ms => new Promise(r => setTimeout(r, ms));
const hora = () => new Date(Date.now() - 3 * HORA).toISOString().slice(11, 16);
const log = m => console.log('[vigilante ' + hora() + '] ' + m);
const leer = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return def; } };

const H = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' };
async function api(ruta, opciones = {}) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + ruta, { ...opciones, headers: { ...H, ...(opciones.headers || {}) } });
  if (!r.ok) throw new Error(ruta.split('?')[0] + ' -> HTTP ' + r.status);
  return r.json();
}
const LPF = { headers: { 'Accept-Profile': 'winning_lpf' } };

function correr(script, argumentos) {
  const r = spawnSync(process.execPath, [path.join(__dirname, script), ...argumentos.map(String)], { cwd: __dirname, stdio: 'inherit', timeout: 40 * MIN });
  return r.status === 0;
}

/* Sube lo encontrado. Sólo en GitHub (ahí está BUCKET); en una compu no publica nada. */
function publicar() {
  if (!process.env.BUCKET) { log('(sin BUCKET: no publico; en GitHub se publica solo)'); return; }
  const B = process.env.BUCKET, nc = ['--cache-control', 'no-cache', '--only-show-errors'];
  correr('lista-fotos.js', []);
  const aws = (...a) => spawnSync('aws', a, { cwd: RAIZ, stdio: 'inherit' }).status === 0;
  const ok = [
    aws('s3', 'sync', 'fotos/', B + '/fotos/', ...nc, '--exclude', 'revisar.html'),
    aws('s3', 'sync', 'fotos-partido/', B + '/fotos-partido/', ...nc, '--exclude', '*', '--include', '*.jpg', '--include', 'elegidas.json', '--exclude', '_*'),
    aws('s3', 'cp', 'vigilante.json', B + '/vigilante.json', ...nc),
    // Los captions escritos por captions.js (si no hay, sync no hace nada)
    !fs.existsSync(path.join(RAIZ, 'captions.json')) || aws('s3', 'cp', 'captions.json', B + '/captions.json', ...nc),
    !fs.existsSync(path.join(RAIZ, 'captions')) || aws('s3', 'sync', 'captions/', B + '/captions/', ...nc),
  ].every(Boolean);
  log(ok ? 'publicado en el sitio' : 'OJO: falló la publicación');
}

/* Lanza la próxima corrida (sólo en GitHub: hace falta GH_TOKEN y el repo). La
   nueva queda en cola por el grupo de concurrencia y arranca cuando ésta termina. */
function relevo() {
  if (!process.env.GITHUB_REPOSITORY) return;
  const r = spawnSync('gh', ['workflow', 'run', 'fotos.yml', '--repo', process.env.GITHUB_REPOSITORY], { encoding: 'utf8' });
  log(r.status === 0 ? 'relevo lanzado: la próxima corrida sigue la guardia' : 'OJO: no pude lanzar el relevo: ' + (r.stderr || '').trim().slice(0, 150));
}

function avisar(clave, valor) {
  log(clave + ' = ' + valor);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, clave + '=' + valor + '\n');
}

// ── Datos ─────────────────────────────────────────────────────────────
const nombre = j => j.home_team_display + ' - ' + j.away_team_display;
const diaArg = j => new Date(new Date(j.kickoff_ts) - 3 * HORA).toISOString().slice(0, 10);
const terminado = j => j.opta_period === 'FullTime';

async function fixtures() {
  const desde = new Date(Date.now() - (DIAS_FECHA + 6) * DIA).toISOString(), hasta = new Date(Date.now() + DIA).toISOString();
  const cerca = await api('v_fixtures?select=matchday&competition_id=eq.' + COMPETITION + '&season_id=eq.' + SEASON +
    '&kickoff_ts=gte.' + encodeURIComponent(desde) + '&kickoff_ts=lte.' + encodeURIComponent(hasta));
  const fechas = [...new Set(cerca.map(x => x.matchday))];
  if (!fechas.length) return [];
  return api('v_fixtures?select=game_id,matchday,kickoff_ts,opta_period,second_half_start,home_id,away_id,home_team_display,away_team_display,home_score,away_score' +
    '&competition_id=eq.' + COMPETITION + '&season_id=eq.' + SEASON + '&matchday=in.(' + fechas.join(',') + ')&order=kickoff_ts');
}

/* Con qué se buscó la foto: si después cambia (gol sobre la hora), hay que rehacerla. */
async function firma(j) {
  const g = await api('goal_events?select=scorer_player_id&game_id=eq.' + j.game_id + '&order=minute', LPF).catch(() => []);
  return (j.home_score ?? '') + '-' + (j.away_score ?? '') + '|' + g.map(x => x.scorer_player_id).join(',');
}

/* Puntos de la fecha por jugador, con el partido en que los hizo (la vista de puntos no trae game_id). */
const puntosCache = {};
async function puntosDeLaFecha(md, juegos) {
  const pts = puntosCache[md] || (puntosCache[md] = await api('v_fantasy_player_match_points?select=player_id,player_name,team_id,total_points,is_starter' +
    '&competition_id=eq.' + COMPETITION + '&season_id=eq.' + SEASON + '&matchday=eq.' + md));
  if (!juegos.length) return [];
  const pms = await api('player_match_stats?select=game_id,player_id&game_id=in.(' + juegos.join(',') + ')', LPF);
  const juegoDe = {}; pms.forEach(r => { juegoDe[r.player_id] = r.game_id; });
  return pts.filter(p => juegoDe[p.player_id]).map(p => ({ ...p, game_id: juegoDe[p.player_id] })).sort((a, b) => b.total_points - a.total_points);
}

/* Los 5 mejores de un equipo en el torneo (la placa "TOP 5 <equipo>" del index: misma cuenta que top5EquipoCargar). */
const torneoCache = {};
async function top5Torneo(teamId) {
  if (torneoCache[teamId]) return torneoCache[teamId];
  const filas = await api('v_fantasy_player_match_points?select=player_id,player_name,total_points&competition_id=eq.' + COMPETITION + '&season_id=eq.' + SEASON + '&team_id=eq.' + teamId);
  const por = {};
  filas.forEach(r => { (por[r.player_id] = por[r.player_id] || { player_id: r.player_id, player_name: r.player_name, total_points: 0 }).total_points += Number(r.total_points) || 0; });
  return (torneoCache[teamId] = Object.values(por).sort((a, b) => b.total_points - a.total_points).slice(0, 5));
}

async function postersDe(md) {
  const d = await api('rpc/get_matchday_recap', { method: 'POST', body: JSON.stringify({ p_competition_id: COMPETITION, p_season_id: SEASON, p_matchday: md }) }).catch(() => ({}));
  const ideal = (d.winning_team && d.winning_team.players) || [];
  if (ideal.length < 11) return null;     // el equipo ideal aparece cuando cierra el puntaje; el "ganador" provisorio está desde antes
  return [...ideal, ...((d.winner_team && d.winner_team.players) || [])].map(p => ({ player_id: p.player_id, player_name: p.player_name }));
}

// ── Una pasada: ver qué momento es y hacerlo ──────────────────────────
const postersHechos = {};   // fechas cuyo equipo ideal ya apareció (en esta corrida)
async function pasada(estado) {
  const ahora = Date.now();
  for (const c of [puntosCache, torneoCache]) Object.keys(c).forEach(k => delete c[k]);   // los puntos cambian mientras se espera el pitazo
  const fx = await fixtures();
  const registro = leer(REGISTRO, {});
  const P = g => (estado.partidos[g] = estado.partidos[g] || {});
  const floja = g => { const o = ((registro[g] || {}).opciones || [])[0]; return !o || o.escala > 1.5 || parseInt(o.tam, 10) < 1000; };
  const reciente = j => ahora - new Date(j.kickoff_ts) < DIAS_PARTIDO * DIA;
  const min2T = j => j.second_half_start ? ahora - new Date(j.second_half_start) : -1;

  // Lo que ya estaba hecho antes de que existieran los momentos (fotos buscadas a mano) no se rehace.
  fx.filter(j => terminado(j) && !P(j.game_id).final && !P(j.game_id).pre && /camino D/.test((registro[j.game_id] || {}).como || ''))
    .forEach(j => Object.assign(P(j.game_id), { final: ahora, cerrado: true, heredado: true }));

  const fotos = [];            // { j, motivo, forzar }
  const caras = new Map();     // player_id -> { id, nombre, md, motivo }
  const pedirCara = (p, md, motivo) => {
    const id = p.player_id; if (!id || caras.has(id)) return;
    if (fs.existsSync(path.join(DIR_FOTOS, id + '.png')) || fs.existsSync(path.join(DIR_REVISAR, id + '.png'))) return;
    const e = estado.caras[id];
    if (e && (e.n >= INTENTOS_CARA || ahora - e.t < ENTRE_CARA)) return;
    caras.set(id, { id, nombre: p.player_name || String(id), md, motivo });
  };
  const carasDelPartido = async (j, cuantos, motivo) => {
    (await puntosDeLaFecha(j.matchday, [j.game_id])).slice(0, cuantos).forEach(p => pedirCara(p, j.matchday, motivo));
    for (const t of [j.home_id, j.away_id]) (await top5Torneo(t)).forEach(p => pedirCara(p, j.matchday, motivo));
  };

  for (const j of fx.filter(reciente)) {
    const p = P(j.game_id), t = nombre(j);
    if (p.cerrado) continue;
    if (!terminado(j)) {
      // MINUTO ~75: pre-búsqueda
      if (!p.pre && min2T(j) >= PRE_DESDE && min2T(j) < ESPERA_MAX) {
        fotos.push({ j, motivo: 'segundo tiempo avanzado de ' + t + ' → pre-búsqueda para tenerla al pitazo', paso: 'pre' });
        await carasDelPartido(j, 8, 'Top 5 de ' + t);
      }
    } else if (!p.final) {
      // PITAZO FINAL
      const f = await firma(j);
      if (!p.pre) fotos.push({ j, motivo: 'terminó ' + t + ' (sin pre-búsqueda) → foto', paso: 'final', firma: f });
      else if (p.firma !== f) fotos.push({ j, motivo: 'terminó ' + t + ' y cambió el resultado o los goleadores desde la pre-búsqueda → rehago la foto', paso: 'final', forzar: true, firma: f });
      else fotos.push({ j, motivo: 'terminó ' + t + ', la foto de la pre-búsqueda sigue valiendo', paso: 'final', nada: true, firma: f });
      await carasDelPartido(j, 5, 'Top 5 de ' + t);
    } else if (ahora - p.final >= REINTENTO) {
      // 30 MIN DESPUÉS
      if (floja(j.game_id)) fotos.push({ j, motivo: '30 min después de ' + t + ': la foto quedó floja → único reintento', paso: 'reintento', forzar: true });
      else fotos.push({ j, motivo: '30 min después de ' + t + ': la foto está bien, cierro el partido', paso: 'reintento', nada: true });
      await carasDelPartido(j, 5, 'Top 5 de ' + t);
    }
  }

  // FIN DEL DÍA: MVPs del día
  const porDia = {};
  fx.forEach(j => { (porDia[diaArg(j)] = porDia[diaArg(j)] || []).push(j); });
  for (const [dia, js] of Object.entries(porDia)) {
    if (!js.every(terminado) || ahora - new Date(js[js.length - 1].kickoff_ts) > DIAS_PARTIDO * DIA) continue;
    (await puntosDeLaFecha(js[0].matchday, js.map(j => j.game_id))).slice(0, 5).forEach(p => pedirCara(p, js[0].matchday, 'MVPs del día ' + dia));
  }

  // CIERRE DE PUNTAJES: pósters, MVPs y Super Suplentes de la fecha
  const captionsPendientes = [];
  for (const md of [...new Set(fx.map(j => j.matchday))]) {
    const js = fx.filter(j => j.matchday === md);
    if (!js.every(terminado) || ahora - new Date(js[js.length - 1].kickoff_ts) > DIAS_FECHA * DIA) continue;
    const posters = await postersDe(md);
    if (!posters) { if (!estado._avisoCierre) log('fecha ' + md + ': terminaron todos los partidos, todavía no cerró el puntaje'); estado._avisoCierre = true; continue; }
    postersHechos[md] = true;
    const pts = await puntosDeLaFecha(md, js.map(j => j.game_id));
    [...posters, ...pts.slice(0, 5), ...pts.filter(p => p.is_starter === false).slice(0, 5)].forEach(p => pedirCara(p, md, 'cierre de la fecha ' + md));
    // Captions del 11 Ideal escritos como editor: una vez por fecha, dos intentos como mucho.
    const c = estado.captions[md] || {};
    if (process.env.ANTHROPIC_API_KEY && !c.ok && (c.n || 0) < 2) captionsPendientes.push(md);
  }

  const listaCaras = [...caras.values()].slice(0, MAX_CARAS);
  const esperando = fx.filter(j => reciente(j) && !terminado(j) && min2T(j) >= PRE_DESDE && min2T(j) < ESPERA_MAX);
  // ¿Hay que quedarse de guardia? Partidos por empezar (2 h), en juego o recién
  // terminados (45 min), o una fecha ya jugada cuyo puntaje todavía no cerró.
  const vigilar = [];
  fx.forEach(j => {
    const k = new Date(j.kickoff_ts).getTime();
    if (!terminado(j) && k - ahora < GUARDIA_ANTES && ahora - k < 4 * HORA) vigilar.push('partido: ' + nombre(j));
    else if (terminado(j) && !P(j.game_id).cerrado && ahora - k < 3 * HORA + GUARDIA_DESPUES) vigilar.push('reintento: ' + nombre(j));
  });
  for (const md of [...new Set(fx.map(j => j.matchday))]) {
    const js = fx.filter(j => j.matchday === md);
    const ultimo = Math.max(...js.map(j => new Date(j.kickoff_ts).getTime()));
    if (js.every(terminado) && ahora - ultimo < ESPERA_PUNTAJE && !postersHechos[md]) vigilar.push('cierre del puntaje de la fecha ' + md);
  }
  fotos.forEach(f => log('momento: ' + f.motivo));
  const motivos = [...new Set(listaCaras.map(c => c.motivo))];
  motivos.forEach(m => log('momento: caras de ' + m + ' → ' + listaCaras.filter(c => c.motivo === m).map(c => c.nombre).join(', ')));
  captionsPendientes.forEach(md => log('momento: captions del 11 Ideal de la fecha ' + md));

  const hayTrabajo = fotos.length > 0 || listaCaras.length > 0 || captionsPendientes.length > 0;   // anotar un pitazo o cerrar un partido también es trabajo: hay que guardarlo
  if (MIRAR) return { hayTrabajo, esperando, vigilar };

  // ── A trabajar ──
  const guardar = () => fs.writeFileSync(ESTADO, JSON.stringify({ partidos: estado.partidos, caras: estado.caras, captions: estado.captions }, null, 1));
  for (const f of fotos) {
    const p = P(f.j.game_id);
    if (!f.nada) correr('foto-fuentes.js', [f.j.matchday, '--comp', COMPETITION, '--game', f.j.game_id, ...(f.forzar ? ['--forzar'] : [])]);
    if (f.paso === 'pre') { p.pre = Date.now(); p.firma = await firma(f.j); }
    if (f.paso === 'final') { p.final = Date.now(); p.firma = f.firma; }
    if (f.paso === 'reintento') p.cerrado = true;
    guardar();
    if (!f.nada) publicar();     // la foto sale al sitio ya, sin esperar a las caras
  }
  for (const md of [...new Set(listaCaras.map(c => c.md))]) {
    const ids = listaCaras.filter(c => c.md === md).map(c => c.id);
    correr('bajar-fotos.js', [md, '--comp', COMPETITION, '--ids', ids.join(',')]);
    ids.forEach(id => { estado.caras[id] = { n: ((estado.caras[id] || {}).n || 0) + 1, t: Date.now() }; });
    guardar();
  }
  if (listaCaras.length) {
    const ok = listaCaras.filter(c => fs.existsSync(path.join(DIR_FOTOS, c.id + '.png'))).length;
    log('caras: ' + ok + '/' + listaCaras.length + ' bajadas');
    publicar();
  }
  // Captions del 11 Ideal: el editor (Claude) lee los medios y escribe; tarda unos minutos.
  for (const md of captionsPendientes) {
    const ok = correr('captions.js', [md]);
    estado.captions[md] = { n: ((estado.captions[md] || {}).n || 0) + 1, t: Date.now(), ok };
    guardar();
    log('captions de la fecha ' + md + ': ' + (ok ? 'escritos' : 'fallaron (se reintenta en la próxima corrida)'));
    if (ok) publicar();
  }

  // Limpieza: lo de hace más de un mes ya no sirve.
  const viejo = Date.now() - 30 * DIA;
  Object.keys(estado.partidos).forEach(k => { const e = estado.partidos[k]; if ((e.final || e.pre || 0) < viejo) delete estado.partidos[k]; });
  Object.keys(estado.caras).forEach(k => { if (estado.caras[k].t < viejo) delete estado.caras[k]; });
  guardar();
  return { hayTrabajo, esperando, vigilar };
}

(async () => {
  const inicio = Date.now();
  const estado = leer(ESTADO, {});
  estado.partidos = estado.partidos || {}; estado.caras = estado.caras || {}; estado.captions = estado.captions || {};
  // El estado viejo contaba intentos ({n,t}); ya no se usa.
  Object.keys(estado.partidos).forEach(k => { if ('n' in estado.partidos[k]) delete estado.partidos[k]; });

  let hubo = false, vueltas = 0, ultimoAviso = '';
  for (;;) {
    const r = await pasada(estado);
    hubo = hubo || r.hayTrabajo;
    if (MIRAR) {
      if (r.vigilar.length) log('de guardia por: ' + r.vigilar.join(' · '));
      if (!r.hayTrabajo && !r.vigilar.length) log('no es momento de nada');
      avisar('trabajo', r.hayTrabajo || r.vigilar.length > 0); return;
    }
    if (!r.vigilar.length) break;
    if (Date.now() - inicio > CORRIDA_MAX) { log('llevo ' + Math.round((Date.now() - inicio) / HORA * 10) / 10 + ' h: paso la guardia'); relevo(); break; }
    const aviso = r.vigilar.join(' · ');
    if (aviso !== ultimoAviso || vueltas++ % 30 === 0) log('de guardia por: ' + aviso);
    ultimoAviso = aviso;
    // Con un pitazo por venir se mira cada 30 s; el resto del tiempo, cada minuto;
    // esperando sólo el cierre del puntaje, cada 5 minutos.
    const soloPuntaje = r.vigilar.every(v => v.startsWith('cierre'));
    await dormir(r.esperando.length ? 30e3 : soloPuntaje ? 5 * MIN : MIN);
  }
  if (!hubo) log('no es momento de nada');
  avisar('trabajo', hubo);
})().catch(e => { log('Error: ' + e.message); process.exit(1); });
