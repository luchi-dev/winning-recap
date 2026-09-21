#!/usr/bin/env node
/**
 * vigilante.js — busca solo las fotos que faltan, sin que nadie se lo pida.
 *
 *   node vigilante.js            mira qué falta y lo busca
 *   node vigilante.js --mirar    sólo dice qué haría (no baja nada)
 *
 * Pensado para correr en un server cada media hora (GitHub Actions, ver
 * .github/workflows/fotos.yml), no en la compu de nadie. Cada vez:
 *   1. Partidos terminados (opta_period = FullTime) de los últimos días que
 *      todavía no tienen foto de partido  → foto-fuentes.js
 *   2. Caras que faltan de esas fechas: pósters (equipo ideal y ganador, que
 *      aparecen cuando cierra el scoring), MVPs, super suplentes y el Top 5
 *      de cada partido terminado  → bajar-fotos.js
 *
 * Para no insistirle a nadie lleva la cuenta en vigilante.json: un partido se
 * intenta hasta 4 veces (las notas con buena foto a veces salen más tarde) y
 * una cara hasta 3, con un rato entre intento e intento. Las caras dudosas
 * (fotos/_revisar) no se reintentan: hay que mirarlas.
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
const DIR_REVISAR = path.join(RAIZ, 'fotos', '_revisar');

const HORA = 3600e3;
const DIAS_PARTIDO = 3;          // después de esto ya no se busca la foto de un partido
const DIAS_FECHA = 5;            // ni las caras de una fecha (el scoring cierra hasta 13 h después)
const INTENTOS_PARTIDO = 4, ENTRE_PARTIDO = 0.4 * HORA;
const INTENTOS_CARA = 3, ENTRE_CARA = 2 * HORA;
const MAX_PARTIDOS = 6, MAX_CARAS = 25;   // por corrida, para que ninguna se eternice

const MIRAR = process.argv.includes('--mirar');
const log = m => console.log('[vigilante] ' + m);
const leer = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return def; } };

async function api(ruta) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + ruta, { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY } });
  if (!r.ok) throw new Error(ruta.split('?')[0] + ' -> HTTP ' + r.status);
  return r.json();
}

function correr(script, argumentos, capturar) {
  const r = spawnSync(process.execPath, [path.join(__dirname, script), ...argumentos.map(String)],
    { cwd: __dirname, encoding: 'utf8', stdio: capturar ? ['ignore', 'pipe', 'inherit'] : 'inherit', timeout: 45 * 60e3 });
  return { ok: r.status === 0, salida: r.stdout || '' };
}

/* Deja el resultado donde GitHub Actions lo puede leer (y en pantalla siempre). */
function avisar(clave, valor) {
  log(clave + ' = ' + valor);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, clave + '=' + valor + '\n');
}

(async () => {
  const ahora = Date.now();
  const estado = leer(ESTADO, {});
  estado.partidos = estado.partidos || {}; estado.caras = estado.caras || {};
  const listo = (e, max, entre) => !e || (e.n < max && ahora - e.t >= entre);

  const desde = new Date(ahora - DIAS_FECHA * 24 * HORA).toISOString();
  const terminados = await api('v_fixtures?select=game_id,matchday,kickoff_ts,home_team_display,away_team_display' +
    '&competition_id=eq.' + COMPETITION + '&season_id=eq.' + SEASON + '&opta_period=eq.FullTime&kickoff_ts=gte.' + encodeURIComponent(desde) + '&order=kickoff_ts');
  if (!terminados.length) { log('no hay partidos terminados en los últimos ' + DIAS_FECHA + ' días'); avisar('trabajo', false); return; }

  // ── 1. Fotos de partido ──
  const registro = leer(REGISTRO, {});
  const conFoto = g => registro[g] && /camino D/.test(registro[g].como || '');
  const sinFoto = terminados
    .filter(j => ahora - new Date(j.kickoff_ts) < DIAS_PARTIDO * 24 * HORA)
    .filter(j => !conFoto(j.game_id) && listo(estado.partidos[j.game_id], INTENTOS_PARTIDO, ENTRE_PARTIDO))
    .slice(0, MAX_PARTIDOS);
  sinFoto.forEach(j => log('falta foto de partido: ' + j.home_team_display + ' - ' + j.away_team_display + ' (' + j.game_id + ')'));

  // ── 2. Caras ──
  const fechas = [...new Set(terminados.map(j => j.matchday))];
  const caras = [];   // { id, nombre, matchday }
  for (const md of fechas) {
    const juegos = terminados.filter(j => j.matchday === md).map(j => j.game_id);
    const r = correr('bajar-fotos.js', [md, '--comp', COMPETITION, ...juegos.flatMap(g => ['--partido', g]), '--listar'], true);
    const linea = r.salida.split(/\r?\n/).find(l => l.startsWith('LISTA='));
    if (!linea) { log('no pude listar las caras de la fecha ' + md); continue; }
    JSON.parse(linea.slice(6)).forEach(c => {
      if (caras.some(x => x.id === c.id)) return;
      if (fs.existsSync(path.join(DIR_REVISAR, c.id + '.png'))) return;        // dudosa: espera que la miren
      if (listo(estado.caras[c.id], INTENTOS_CARA, ENTRE_CARA)) caras.push({ ...c, matchday: md });
    });
  }
  caras.splice(MAX_CARAS);
  if (caras.length) log('faltan ' + caras.length + ' cara(s): ' + caras.map(c => c.nombre).join(', '));

  const hayTrabajo = sinFoto.length > 0 || caras.length > 0;
  if (MIRAR || !hayTrabajo) { if (!hayTrabajo) log('todo al día'); avisar('trabajo', hayTrabajo); return; }

  // ── A trabajar ──
  const guardar = () => fs.writeFileSync(ESTADO, JSON.stringify(estado, null, 1));
  const sumar = (tabla, id) => { tabla[id] = { n: ((tabla[id] || {}).n || 0) + 1, t: Date.now() }; };

  for (const md of [...new Set(sinFoto.map(j => j.matchday))]) {
    const ids = sinFoto.filter(j => j.matchday === md).map(j => j.game_id);
    correr('foto-fuentes.js', [md, '--comp', COMPETITION, '--game', ids.join(',')]);
    ids.forEach(g => sumar(estado.partidos, g)); guardar();
  }
  for (const md of [...new Set(caras.map(c => c.matchday))]) {
    const ids = caras.filter(c => c.matchday === md).map(c => c.id);
    correr('bajar-fotos.js', [md, '--comp', COMPETITION, '--ids', ids.join(',')]);
    ids.forEach(id => sumar(estado.caras, id)); guardar();
  }

  // Limpieza: el estado sólo sirve mientras la fecha está "viva".
  const viejo = ahora - 30 * 24 * HORA;
  for (const t of [estado.partidos, estado.caras]) Object.keys(t).forEach(k => { if (t[k].t < viejo) delete t[k]; });
  guardar();

  const registroDespues = leer(REGISTRO, {});
  const fotosNuevas = sinFoto.filter(j => /camino D/.test((registroDespues[j.game_id] || {}).como || '')).length;
  const carasNuevas = caras.filter(c => fs.existsSync(path.join(RAIZ, 'fotos', c.id + '.png'))).length;
  const dudosas = caras.filter(c => fs.existsSync(path.join(DIR_REVISAR, c.id + '.png'))).length;
  log('resultado: ' + fotosNuevas + '/' + sinFoto.length + ' partidos con foto, ' + carasNuevas + '/' + caras.length + ' caras' + (dudosas ? ' (' + dudosas + ' dudosas, en fotos/_revisar)' : ''));
  avisar('trabajo', true);
})().catch(e => { log('Error: ' + e.message); process.exit(1); });
