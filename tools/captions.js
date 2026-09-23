#!/usr/bin/env node
/**
 * captions.js — escribe los captions del 11 Ideal de una fecha como editor.
 *
 *   node captions.js <fecha>                  escribe captions.json y captions/fecha-N.md
 *   node captions.js <fecha> --solo-datos     sólo arma y muestra los datos (sin llamar a Claude)
 *   node captions.js <fecha> --solo-ganadores rehace sólo el texto de la placa de Ganadores
 *
 * Escribe dos cosas por fecha:
 *   - 'ideal': los 4 captions del 11 Ideal (brief en captions-brief.md, con
 *     búsqueda web: lee los medios).
 *   - 'ganadores': el texto de dos líneas que acompaña la placa de Ganadores
 *     de la fecha (brief en captions-ganadores-brief.md, sin búsqueda web:
 *     sale todo de la base: provincia, club e historia de los 6 ganadores,
 *     censo de hinchadas y récords/primeras veces del torneo, verificados
 *     contra los podios de todas las fechas anteriores).
 *
 * Lo que hace, en el orden en que lo haría un editor el lunes a la mañana:
 *   1. Junta de la base (clave pública) el 11 Ideal, los resultados, la figura
 *      de la fecha con su recorrido en el torneo, y el análisis de puntajes de
 *      los usuarios (todos los equipos, por el leaderboard de la fecha).
 *   2. Le da eso a Claude con búsqueda web y el brief editorial de
 *      captions-brief.md: lee los medios, elige 2 o 3 historias, verifica el
 *      dato central y escribe 4 captions en máximas.
 *   3. Guarda la fecha en captions.json (el index la muestra al lado del
 *      póster) y el informe completo en captions/fecha-N.md.
 *
 * Corre en GitHub Actions (lo lanza tools/vigilante.js al cierre de puntajes,
 * o el botón de .github/workflows/captions.yml). Necesita ANTHROPIC_API_KEY en
 * el ambiente: nunca en un archivo, el repo es público.
 *
 * Lo que la clave pública NO deja leer, y por eso el brief le dice a Claude
 * que no lo invente: la tenencia (cuántos usuarios tenían a cada jugador) y
 * los capitanes más elegidos.
 */

const fs = require('fs');
const path = require('path');

const SUPABASE_URL = 'https://ketwxvbrhqbemlflmadu.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtldHd4dmJyaHFiZW1sZmxtYWR1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4NjA4MDcsImV4cCI6MjA4NjQzNjgwN30.-qXPLMSFEiRORNk5EUKrD16VDiMXtv-VfcDSWpzWzsg';

const COMPETITION = 724, SEASON = 2026, TORNEO = 'CLAUSURA 2026';
const SEASON_PART = COMPETITION + '-' + SEASON;
const RAIZ = path.resolve(__dirname, '..');
const ARCHIVO = path.join(RAIZ, 'captions.json');
const DIR = path.join(RAIZ, 'captions');
const CACHE = path.join(DIR, 'puntajes.json');
const BRIEF = path.join(__dirname, 'captions-brief.md');
const BRIEF_GANADORES = path.join(__dirname, 'captions-ganadores-brief.md');

const MODEL = process.env.CAPTIONS_MODEL || 'claude-opus-5';
const MAX_BUSQUEDAS = 12, MAX_NOTAS = 15;
const MAX_X = 275;   // X corta en 280; margen por cómo cuenta emojis y acentos

const HORA = 3600e3;
const hora = () => new Date(Date.now() - 3 * HORA).toISOString().slice(11, 16);
const log = m => console.log('[captions ' + hora() + '] ' + m);
const leer = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return def; } };
const r1 = v => Math.round(Number(v) * 10) / 10;
const ar = v => (Number(v) || 0).toFixed(1).replace('.', ',');       // 23,8
const miles = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');   // 43.000

// ── Base (clave pública, igual que el vigilante) ─────────────────────
const H = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' };
async function api(ruta, opciones = {}) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + ruta, { ...opciones, headers: { ...H, ...(opciones.headers || {}) } });
  if (!r.ok) throw new Error(ruta.split('?')[0] + ' -> HTTP ' + r.status);
  return r.json();
}
const LPF = { headers: { 'Accept-Profile': 'winning_lpf' } };
const rpc = (nombre, body, schema) => api('rpc/' + nombre, { method: 'POST', body: JSON.stringify(body), headers: schema ? { 'Content-Profile': schema } : {} });

const recapCache = {};
async function recap(md) {
  if (!recapCache[md]) recapCache[md] = await rpc('get_matchday_recap', { p_competition_id: COMPETITION, p_season_id: SEASON, p_matchday: md }).catch(() => ({}));
  return recapCache[md];
}

/* Todos los puntajes de la fecha, de a 1000 (el RPC no da más por llamada). */
async function puntajesDeLaFecha(md) {
  const todos = [];
  for (let offset = 0; ; offset += 1000) {
    const pag = await rpc('get_global_leaderboard_round', { p_season_part_id: SEASON_PART, p_matchday: md, p_limit: 1000, p_offset: offset }, 'tournaments');
    const filas = Array.isArray(pag) ? pag : [];
    todos.push(...filas);
    if (filas.length < 1000) break;
  }
  return todos;
}

function resumirPuntajes(filas) {
  const pts = filas.map(f => Number(f.matchday_points) || 0).sort((a, b) => b - a);
  if (!pts.length) return null;
  const n = pts.length;
  const pct = q => pts[Math.min(n - 1, Math.max(0, Math.floor((1 - q) * n)))];   // pts ordenado de mayor a menor
  const top = filas.slice(0, 3).map(f => ({ usuario: f.display_name, equipo: f.team_name, puntos: r1(f.matchday_points) }));
  return {
    equipos: n,
    promedio: r1(pts.reduce((a, b) => a + b, 0) / n),
    mediana: r1(pct(0.5)),
    p90: r1(pct(0.9)),
    p99: r1(pct(0.99)),
    maximo: r1(pts[0]),
    segundo: r1(pts[1] || 0),
    diferencia_1_2: r1(pts[0] - (pts[1] || 0)),
    mas_de_100: pts.filter(p => p >= 100).length,
    mas_de_120: pts.filter(p => p >= 120).length,
    top3: top,
  };
}

/* Puntajes de esta fecha (siempre frescos) y de las anteriores (cache: una
   fecha cerrada no cambia y son 40+ llamadas por fecha). */
async function analisisPuntajes(md) {
  const cache = leer(CACHE, {});
  cache.fechas = cache.fechas || {};
  const fechas = {};
  for (let f = 1; f <= md; f++) {
    if (f < md && cache.fechas[f]) { fechas[f] = cache.fechas[f]; continue; }
    const filas = await puntajesDeLaFecha(f);
    const res = resumirPuntajes(filas);
    if (!res) continue;
    fechas[f] = res;
    cache.fechas[f] = res;
    log('puntajes fecha ' + f + ': ' + res.equipos + ' equipos, promedio ' + res.promedio + ', máximo ' + res.maximo);
  }
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify(cache, null, 1));

  const esta = fechas[md];
  if (!esta) return null;
  const otras = Object.keys(fechas).map(Number).filter(f => f !== md);
  const ranking = (campo, mayor = true) => {
    const vals = Object.values(fechas).map(f => f[campo]);
    return 1 + vals.filter(v => mayor ? v > esta[campo] : v < esta[campo]).length;
  };
  const total = Object.keys(fechas).length;
  const notas = [
    `La diferencia entre el 1° y el 2° (${ar(esta.diferencia_1_2)}) es la ${ranking('diferencia_1_2')}ª más grande de ${total} fechas (la mayor fue ${ar(Math.max(...Object.values(fechas).map(f => f.diferencia_1_2)))}).`,
    `El promedio (${ar(esta.promedio)}) es el ${ranking('promedio')}º más alto de ${total} fechas (el mayor fue ${ar(Math.max(...Object.values(fechas).map(f => f.promedio)))}).`,
    `El puntaje del ganador (${ar(esta.maximo)}) es el ${ranking('maximo')}º más alto de ${total} fechas (el récord es ${ar(Math.max(...Object.values(fechas).map(f => f.maximo)))}).`,
    `${Math.round(100 * esta.mas_de_100 / esta.equipos)}% de los equipos pasó los 100 puntos (${miles(esta.mas_de_100)} de ${miles(esta.equipos)}); ${Math.round(100 * esta.mas_de_120 / esta.equipos)}% pasó los 120.`,
  ];
  return {
    fecha: md,
    esta_fecha: esta,
    comparacion_con_otras_fechas: Object.fromEntries(otras.map(f => [f, { equipos: fechas[f].equipos, promedio: fechas[f].promedio, maximo: fechas[f].maximo, segundo: fechas[f].segundo, diferencia_1_2: fechas[f].diferencia_1_2, mas_de_100: fechas[f].mas_de_100 }])),
    lectura: notas,
  };
}

// ── La figura y su recorrido ──────────────────────────────────────────
async function recorridoFigura(p, md) {
  const filas = (await api(`v_fantasy_player_match_points?player_id=eq.${p.player_id}&competition_id=eq.${COMPETITION}&season_id=eq.${SEASON}&matchday=lte.${md}&order=matchday`)) || [];
  const games = filas.map(f => f.game_id).filter(Boolean);
  const inList = games.length ? `in.(${games.join(',')})` : 'eq.0';
  const [stats, fixtures, details] = await Promise.all([
    api(`player_match_stats?player_id=eq.${p.player_id}&game_id=${inList}&select=game_id,goals,goal_assist,mins_played,att_pen_goal`, LPF),
    api(`fixtures?game_id=${inList}&select=game_id,matchday,home_team_id,away_team_id`, LPF),
    api(`match_details?game_id=${inList}&select=game_id,home_score,away_score`, LPF),
  ]);
  const teamIds = [...new Set([...filas.map(f => f.team_id), ...fixtures.flatMap(f => [f.home_team_id, f.away_team_id])])].filter(Boolean);
  const equipos = teamIds.length ? await api(`teams?id=in.(${teamIds.join(',')})&select=id,name,short_name`) : [];
  const nombreEquipo = id => (equipos.find(t => t.id === id) || {}).name || (equipos.find(t => t.id === id) || {}).short_name || ('equipo ' + id);
  const S = Object.fromEntries(stats.map(s => [s.game_id, s]));
  const F = Object.fromEntries(fixtures.map(f => [f.game_id, f]));
  const D = Object.fromEntries(details.map(d => [d.game_id, d]));

  // ¿Estuvo en el 11 Ideal de fechas anteriores?
  const ideales = [];
  for (let f = 1; f <= md; f++) {
    const d = await recap(f);
    if (((d.winning_team || {}).players || []).some(x => x.player_id === p.player_id)) ideales.push(f);
  }

  const partidos = filas.map(f => {
    const s = S[f.game_id] || {}, fx = F[f.game_id] || {}, d = D[f.game_id] || {};
    return {
      fecha: f.matchday,
      club: nombreEquipo(f.team_id),
      partido: fx.home_team_id ? `${nombreEquipo(fx.home_team_id)} ${d.home_score ?? '?'}-${d.away_score ?? '?'} ${nombreEquipo(fx.away_team_id)}` : '',
      minutos: Number(s.mins_played) || 0,
      goles: Number(s.goals) || 0,
      goles_de_penal: Number(s.att_pen_goal) || 0,
      asistencias: Number(s.goal_assist) || 0,
      titular: f.is_starter === true,
      puntos: r1(f.total_points),
      en_11_ideal: ideales.includes(f.matchday),
    };
  });
  const jugados = partidos.filter(x => x.minutos > 0);
  const suma = (arr, k) => arr.reduce((a, x) => a + x[k], 0);
  const golCada = arr => { const g = suma(arr, 'goles'), m = suma(arr, 'minutos'); return g ? Math.round(m / g) : null; };

  const porClub = {};
  jugados.forEach(x => { (porClub[x.club] = porClub[x.club] || []).push(x); });
  const clubes = Object.entries(porClub).map(([club, arr]) => ({
    club, partidos: arr.length, goles: suma(arr, 'goles'), asistencias: suma(arr, 'asistencias'), minutos: suma(arr, 'minutos'),
    un_gol_cada_minutos: golCada(arr), fechas: arr.map(x => x.fecha),
  }));

  // Racha actual: fechas jugadas seguidas con gol, contando desde esta fecha hacia atrás
  let rachaGol = 0;
  for (let i = jugados.length - 1; i >= 0 && jugados[i].goles > 0; i--) rachaGol++;
  let rachaIdeal = 0;
  for (let f = md; f >= 1 && ideales.includes(f); f--) rachaIdeal++;

  const fechasSinJugar = [];
  for (let f = 1; f <= md; f++) if (!jugados.some(x => x.fecha === f)) fechasSinJugar.push(f);

  return {
    nombre: p.player_name, club_actual: p.team_short_name && nombreEquipo(p.team_id), posicion: p.display_position,
    esta_fecha: { puntos: r1(p.total_points), eventos: p.events || {}, entro_desde_el_banco: p.entro_desde_el_banco === true },
    torneo: { partidos_jugados: jugados.length, goles: suma(jugados, 'goles'), asistencias: suma(jugados, 'asistencias'), minutos: suma(jugados, 'minutos'), un_gol_cada_minutos: golCada(jugados) },
    por_club: clubes,
    fechas_seguidas_con_gol: rachaGol,
    veces_en_11_ideal: ideales,
    fechas_seguidas_en_11_ideal: rachaIdeal,
    fechas_que_no_jugo: fechasSinJugar,
    partido_a_partido: partidos,
    nota: 'Los minutos y goles salen de las estadísticas oficiales del partido; "un gol cada X minutos" sólo está calculado si jugó minutos.',
  };
}

// ── Todo lo de la fecha, en un JSON para el editor ────────────────────
async function datosDeLaFecha(md) {
  const d = await recap(md);
  const ideal = ((d.winning_team || {}).players || []).slice().sort((a, b) => Number(b.total_points) - Number(a.total_points));
  if (ideal.length < 11) throw new Error('la fecha ' + md + ' todavía no tiene 11 Ideal (no cerró el puntaje)');

  // Quién entró desde el banco: la vista que alimenta la placa de super suplentes
  const ids = ideal.map(p => p.player_id).join(',');
  const suplentes = await api(`v_fantasy_player_match_points?competition_id=eq.${COMPETITION}&season_id=eq.${SEASON}&matchday=eq.${md}&player_id=in.(${ids})&select=player_id,is_starter`).catch(() => []);
  const banco = Object.fromEntries(suplentes.map(s => [s.player_id, s.is_starter === false]));
  ideal.forEach(p => { p.entro_desde_el_banco = banco[p.player_id] === true; });

  const partidos = (d.matches || []).map(m => ({
    partido: `${m.home_team.name} ${m.home_score}-${m.away_score} ${m.away_team.name}`,
    terminado: m.period === 'FullTime',
  }));

  const figura = await recorridoFigura(ideal[0], md);
  const analisis = await analisisPuntajes(md);

  const w = d.winner_team || {};
  const ganador = w.username ? {
    usuario: w.username, puntos: r1(w.total_points),
    capitan: (w.players || []).filter(p => p.is_captain).map(p => `${p.player_name} (${ar(p.total_points)} puntos)`).join(', ') || null,
    jugadores_del_11_ideal_que_tenia: (w.players || []).filter(p => ideal.some(i => i.player_id === p.player_id)).map(p => p.player_name),
  } : null;

  return {
    torneo: TORNEO, fecha: md, hoy: new Date(Date.now() - 3 * HORA).toISOString().slice(0, 10),
    once_ideal: ideal.map(p => ({
      posicion: p.display_position, nombre: p.player_name, club: p.team_short_name, puntos: r1(p.total_points),
      eventos: p.events || {}, entro_desde_el_banco: p.entro_desde_el_banco,
    })),
    total_puntos_del_11: r1((d.winning_team || {}).total_points),
    alguno_entro_desde_el_banco: ideal.some(p => p.entro_desde_el_banco),
    resultados_de_la_fecha: partidos,
    figura_de_la_fecha: figura,
    ganador_de_la_fecha: ganador,
    analisis_de_puntajes: analisis,
    datos_no_disponibles: [
      'tenencia: cuántos usuarios tenían a cada jugador del 11 Ideal (no se puede leer; no usar ni estimar)',
      'capitanes más elegidos de la fecha (no se puede leer)',
    ],
  };
}

// ── Claude ─────────────────────────────────────────────────────────────
const ESQUEMA = {
  type: 'object', additionalProperties: false,
  required: ['historias', 'figura', 'analisis', 'captions'],
  properties: {
    historias: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['titulo', 'dato_central', 'estado', 'links', 'toca_al_11'],
        properties: {
          titulo: { type: 'string' },
          dato_central: { type: 'string' },
          estado: { type: 'string', enum: ['confirmado oficial', 'confirmado en dos fuentes', 'sin confirmar'] },
          links: { type: 'array', items: { type: 'string' } },
          toca_al_11: { type: 'string', description: 'nombre del jugador del 11 Ideal que toca, o vacío' },
        },
      },
    },
    figura: { type: 'string', description: 'datos de la figura y el ángulo elegido, en prosa corta' },
    analisis: { type: 'string', description: 'análisis de puntajes: qué extremo hubo o que no hubo, y qué datos faltaron' },
    captions: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['titulo', 'texto', 'texto_corto', 'texto_x'],
        properties: {
          titulo: { type: 'string', description: 'qué historias combina y qué cierre usa, para la caja del editor' },
          texto: { type: 'string', description: 'el caption completo para Instagram, con saltos de línea entre párrafos' },
          texto_corto: { type: 'string', description: 'el mismo caption, mismas historias, figura y cierre, con menos palabras (60% del largo o menos)' },
          texto_x: { type: 'string', description: 'versión para X sin el título (lo pone el sistema): la figura en una frase y el cierre con la pregunta, hasta 220 caracteres' },
        },
      },
    },
  },
};

function textoDe(msg) {
  return (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}
function extraerJSON(texto) {
  try { return JSON.parse(texto); } catch (e) { /* sigue */ }
  const m = texto.match(/```json\s*([\s\S]*?)```/) || texto.match(/(\{[\s\S]*\})/);
  return m ? JSON.parse(m[1]) : null;
}

function problemas(res, md) {
  const p = [];
  const caps = (res && res.captions) || [];
  if (caps.length !== 4) p.push('tienen que ser exactamente 4 captions (vinieron ' + caps.length + ')');
  const titulo = `🔥 11 IDEAL — FECHA ${md} | ${TORNEO}`;
  caps.forEach((c, i) => {
    const t = (c.texto || '').trim();
    if (!t.startsWith(titulo)) p.push(`el caption ${i + 1} tiene que empezar con "${titulo}"`);
    if (/#\w/.test(t)) p.push(`el caption ${i + 1} tiene hashtags`);
    if (t.includes('⭐')) p.push(`el caption ${i + 1} tiene la estrella; "La figura de la fecha:" va sin estrella`);
    if (!/La figura de la fecha:/.test(t)) p.push(`al caption ${i + 1} le falta "La figura de la fecha:"`);
    // La apertura va con una historia por párrafo: antes de la figura tiene que haber
    // al menos dos bloques separados por renglón vacío (sin contar el título).
    const apertura = t.split(/La figura de la fecha:/)[0].split(/\n\s*\n/).map(s => s.trim()).filter(Boolean).slice(1);
    if (apertura.length < 2) p.push(`el caption ${i + 1} tiene las historias de la apertura en un solo párrafo: va una historia por párrafo, con un renglón vacío entre ellas`);
    if (!/\?\s*$/.test(t)) p.push(`el caption ${i + 1} tiene que terminar con la pregunta a ustedes`);
    // La versión corta: mismo caption con menos palabras (mismo título, misma figura, misma pregunta).
    const c2 = (c.texto_corto || '').trim();
    if (!c2) p.push(`al caption ${i + 1} le falta la versión corta (texto_corto)`);
    else {
      if (!c2.startsWith(titulo)) p.push(`la versión corta del caption ${i + 1} tiene que empezar con "${titulo}"`);
      if (!/La figura de la fecha:/.test(c2)) p.push(`a la versión corta del caption ${i + 1} le falta "La figura de la fecha:"`);
      if (!/\?\s*$/.test(c2)) p.push(`la versión corta del caption ${i + 1} tiene que terminar con la pregunta a ustedes`);
      if (c2.length > t.length * 0.75) p.push(`la versión corta del caption ${i + 1} no es corta: tiene ${c2.length} caracteres contra ${t.length} de la completa; apuntá al 60%`);
      if (/#\w|⭐/.test(c2)) p.push(`la versión corta del caption ${i + 1} tiene hashtags o estrella`);
    }
    // La versión para X: sin título (lo agrega el sistema), con la pregunta, y que entre en 280 con el título puesto.
    const cx = (c.texto_x || '').trim();
    if (!cx) p.push(`al caption ${i + 1} le falta la versión para X (texto_x)`);
    else {
      if (cx.startsWith('🔥')) p.push(`la versión para X del caption ${i + 1} no lleva el título: lo agrega el sistema`);
      if (!/\?\s*$/.test(cx)) p.push(`la versión para X del caption ${i + 1} tiene que terminar con la pregunta a ustedes`);
      if (titulo.length + 2 + cx.length > MAX_X) p.push(`la versión para X del caption ${i + 1} es larga: con el título suma ${titulo.length + 2 + cx.length} caracteres y X permite 280; apuntá a 220 sin título`);
      if (/#\w|⭐/.test(cx)) p.push(`la versión para X del caption ${i + 1} tiene hashtags o estrella`);
    }
  });
  return p;
}

async function escribirConClaude(datos) {
  const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('falta ANTHROPIC_API_KEY en el ambiente');
  const client = new Anthropic({ maxRetries: 3, timeout: 20 * 60e3 });
  const brief = fs.readFileSync(BRIEF, 'utf8');
  const md = datos.fecha;

  const messages = [{
    role: 'user',
    content: `Fecha ${md} del ${TORNEO}. Hoy es ${datos.hoy}. Estos son los datos de la base de Winning:\n\n\`\`\`json\n${JSON.stringify(datos, null, 1)}\n\`\`\`\n\nHacé el trabajo del editor y devolvé el JSON pedido.`,
  }];
  const params = {
    model: MODEL,
    max_tokens: 64000,
    thinking: { type: 'adaptive' },
    system: brief,
    tools: [
      { type: 'web_search_20260209', name: 'web_search', max_uses: MAX_BUSQUEDAS, user_location: { type: 'approximate', country: 'AR', timezone: 'America/Argentina/Buenos_Aires' } },
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: MAX_NOTAS },
    ],
    output_config: { format: { type: 'json_schema', schema: ESQUEMA } },
    messages,
  };

  const uso = { input: 0, output: 0, busquedas: 0, notas: 0 };
  const sumarUso = u => {
    if (!u) return;
    uso.input += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    uso.output += u.output_tokens || 0;
    uso.busquedas += (u.server_tool_use || {}).web_search_requests || 0;
    uso.notas += (u.server_tool_use || {}).web_fetch_requests || 0;
  };

  let final = null;
  for (let intento = 1; intento <= 2 && !final; intento++) {
    // Una vuelta de trabajo del editor. Si el server corta el turno largo
    // (pause_turn) se le devuelve su propio turno y sigue.
    let msg;
    for (let vuelta = 0; vuelta < 8; vuelta++) {
      log(`Claude (${MODEL}), intento ${intento}, vuelta ${vuelta + 1}...`);
      const stream = client.messages.stream({ ...params, messages });
      msg = await stream.finalMessage();
      sumarUso(msg.usage);
      if (msg.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: msg.content }); continue; }
      break;
    }
    if (msg.stop_reason === 'refusal') throw new Error('Claude no quiso hacer el trabajo (refusal): ' + JSON.stringify(msg.stop_details || {}));
    if (msg.stop_reason === 'max_tokens') throw new Error('la respuesta se cortó por largo (max_tokens)');

    const res = extraerJSON(textoDe(msg));
    const fallas = res ? problemas(res, md) : ['la respuesta no es JSON'];
    if (!fallas.length) { final = res; break; }
    log('la respuesta tiene problemas: ' + fallas.join('; '));
    if (intento === 2) throw new Error('la respuesta siguió con problemas: ' + fallas.join('; '));
    messages.push({ role: 'assistant', content: msg.content });
    messages.push({ role: 'user', content: 'Corregí estos problemas y devolvé el JSON completo de nuevo, sin volver a buscar en internet:\n- ' + fallas.join('\n- ') });
  }

  // Costo aproximado, para mirar en el log de la corrida
  const precios = { 'claude-opus-5': [5, 25], 'claude-sonnet-5': [2, 10] }[MODEL] || [5, 25];
  const usd = uso.input / 1e6 * precios[0] + uso.output / 1e6 * precios[1] + uso.busquedas * 0.01;
  log(`uso: ${miles(uso.input)} tokens de entrada, ${miles(uso.output)} de salida, ${uso.busquedas} búsquedas, ${uso.notas} notas leídas → ~US$ ${usd.toFixed(2)}`);
  return final;
}

// ── Ganadores de la fecha: los 6 ganadores y los récords de la gente de Winning ──
// El texto de la placa habla de los usuarios, no de los futbolistas (el equipo
// ganador ya tiene su propio posteo). La línea 2 es un récord o una primera vez
// del torneo, verificado contra los podios y los perfiles de todas las fechas
// anteriores. Los podios y perfiles se cachean en captions/podios.json.
const PROVINCIAS = { BA: 'Buenos Aires', CABA: 'Ciudad de Buenos Aires', COR: 'Córdoba', SF: 'Santa Fe', MEN: 'Mendoza', TUC: 'Tucumán', ER: 'Entre Ríos', SAL: 'Salta', MIS: 'Misiones', CHA: 'Chaco', COR2: 'Corrientes', CTES: 'Corrientes', SDE: 'Santiago del Estero', SJ: 'San Juan', JUJ: 'Jujuy', RN: 'Río Negro', NEU: 'Neuquén', NQN: 'Neuquén', FOR: 'Formosa', CHU: 'Chubut', SL: 'San Luis', CAT: 'Catamarca', LR: 'La Rioja', LP: 'La Pampa', SC: 'Santa Cruz', TF: 'Tierra del Fuego' };
const PODIOS = path.join(DIR, 'podios.json');
const TOP_N = 10;

async function podiosHasta(md) {
  const cache = leer(PODIOS, {});
  cache.fechas = cache.fechas || {}; cache.perfiles = cache.perfiles || {};
  for (let f = 1; f <= md; f++) {
    if (f < md && cache.fechas[f]) continue;   // una fecha cerrada no cambia; la actual siempre fresca
    const [fantasy, prode] = await Promise.all([
      rpc('get_global_leaderboard_round', { p_season_part_id: SEASON_PART, p_matchday: f, p_limit: TOP_N, p_offset: 0 }, 'tournaments'),
      rpc('get_prediction_leaderboard_round', { p_season_part_id: SEASON_PART, p_matchday: f, p_limit: TOP_N, p_offset: 0 }, 'predictions'),
    ]);
    const fila = r => ({ rank: r.rank, user_id: r.user_id, usuario: r.display_name, puntos: r1(r.matchday_points) });
    cache.fechas[f] = { fantasy: (Array.isArray(fantasy) ? fantasy : []).map(fila), prode: (Array.isArray(prode) ? prode : []).map(fila) };
  }
  // Perfil de cada ganador (1°) del torneo y de los 6 del podio de esta fecha
  const necesarios = new Set();
  for (const f in cache.fechas) for (const j of ['fantasy', 'prode']) {
    const lista = cache.fechas[f][j];
    lista.filter(r => r.rank === 1).forEach(r => necesarios.add(r.user_id));   // todos los 1° (en el prode hay empates en la punta)
    if (Number(f) === md) lista.slice(0, 3).forEach(r => necesarios.add(r.user_id));
  }
  for (const id of necesarios) {
    if (cache.perfiles[id] && !cache.fechas[md].fantasy.concat(cache.fechas[md].prode).slice(0, 3).some(r => r.user_id === id)) continue;
    const p = await rpc('get_user_full_profile', { p_user_id: id, p_season_part_id: SEASON_PART }).catch(() => ({}));
    cache.perfiles[id] = {
      usuario: p.username || null, provincia: PROVINCIAS[p.province_code] || p.province_code || null,
      club: p.supported_team_name || null, club_id: p.supported_team_id || null, alta: (p.created_at || '').slice(0, 10) || null,
      fantasy_total: r1((p.fantasy_stats || {}).total_points), fantasy_puesto_general: (p.fantasy_stats || {}).global_rank || null,
      prode_total: (p.prode_stats || {}).total_points ?? null, prode_fechas: p.prode_matchdays || [],
    };
  }
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(PODIOS, JSON.stringify(cache, null, 1));
  return cache;
}

async function datosGanadores(md) {
  const [cache, censo, fixtures] = await Promise.all([
    podiosHasta(md),
    rpc('get_censo_hinchadas', {}),
    api(`fixtures?competition_id=eq.${COMPETITION}&season_id=eq.${SEASON}&matchday=lte.${md}&select=matchday,kickoff_utc`, LPF).catch(() => []),
  ]);
  const inicioDe = {};   // primer partido de cada fecha (hora argentina), para saber si un ganador se anotó "la semana anterior"
  fixtures.forEach(x => { const d = new Date(new Date(x.kickoff_utc) - 3 * HORA).toISOString().slice(0, 10); if (!inicioDe[x.matchday] || d < inicioDe[x.matchday]) inicioDe[x.matchday] = d; });
  const dias = (a, b) => Math.round((new Date(b) - new Date(a)) / (24 * HORA));
  const pctClub = id => { const c = (censo || []).find(x => x.team_id === id); return c ? Number(c.fan_pct) : null; };
  const F = cache.fechas, P = cache.perfiles;
  const esta = F[md];
  const anteriores = Object.keys(F).map(Number).filter(f => f < md).sort((a, b) => a - b);
  const juegos = ['fantasy', 'prode'];

  // Los 6 del podio de esta fecha, con su historia en el torneo
  const ganadores = [];
  for (const j of juegos) for (const r of esta[j].slice(0, 3)) {
    const p = P[r.user_id] || {};
    const podiosAntes = anteriores.filter(f => F[f][j].slice(0, 3).some(x => x.user_id === r.user_id));
    const top10Antes = anteriores.filter(f => F[f][j].some(x => x.user_id === r.user_id));
    const otroJuego = j === 'fantasy' ? 'prode' : 'fantasy';
    const podiosOtro = anteriores.concat([md]).filter(f => F[f][otroJuego].slice(0, 3).some(x => x.user_id === r.user_id));
    ganadores.push({
      juego: j, puesto: r.rank, puntos_de_la_fecha: r.puntos,
      provincia: p.provincia, hincha_de: p.club, pct_de_usuarios_hinchas_de_ese_club: pctClub(p.club_id),
      se_anoto_el: p.alta, dias_entre_el_alta_y_el_inicio_de_la_fecha: p.alta && inicioDe[md] ? dias(p.alta, inicioDe[md]) : null,
      primera_fecha_con_puntos_en_fantasy: j === 'fantasy' && Math.abs(Number(p.fantasy_total) - Number(r.puntos)) < 0.05 ? md : null,
      fechas_de_prode_jugadas: p.prode_fechas, puesto_general_fantasy: p.fantasy_puesto_general,
      podios_anteriores_en_este_juego: podiosAntes, top10_anteriores_en_este_juego: top10Antes, podios_en_el_otro_juego: podiosOtro,
    });
  }

  // Récords y primeras veces del torneo, cada uno con su dato verificado.
  // "Ganador" = todos los que terminaron 1° (en el prode suele haber empates en la punta).
  const hechos = [];
  const primeros = j => Object.keys(F).map(Number).sort((a, b) => a - b).flatMap(f => F[f][j].filter(r => r.rank === 1).map(r => ({ fecha: f, ...r, perfil: P[r.user_id] || {} })));
  for (const j of juegos) {
    const lista = primeros(j);
    const actuales = lista.filter(x => x.fecha === md); if (!actuales.length) continue;
    const actual = actuales[0];
    const previos = lista.filter(x => x.fecha < md);
    const fechasN = new Set(lista.map(x => x.fecha)).size;
    const unoPorFecha = [...new Map(lista.map(x => [x.fecha, x])).values()];
    const empates = [...new Set(lista.filter(x => lista.filter(y => y.fecha === x.fecha).length > 1).map(x => x.fecha))];
    // Empate en la punta en esta fecha
    if (actuales.length > 1) hechos.push({ tipo: 'empate-en-la-punta', juego: j, dato: `En el ${j} hubo empate en la punta: ${actuales.length} usuarios con ${ar(actual.puntos)} puntos. ${empates.filter(f => f < md).length ? 'Ya había pasado en las fechas ' + empates.filter(f => f < md).join(', ') + '.' : 'Es el primer empate en la punta del torneo.'}` });
    // Puntaje del ganador comparado con los ganadores anteriores (uno por fecha)
    const previosPorFecha = unoPorFecha.filter(x => x.fecha < md);
    const mayores = previosPorFecha.filter(x => x.puntos > actual.puntos).length;
    const record = previosPorFecha.reduce((m, x) => Math.max(m, x.puntos), 0);
    hechos.push({ tipo: 'puntaje-ganador', juego: j, dato: `El ganador del ${j} hizo ${ar(actual.puntos)}: ${mayores === 0 ? 'el puntaje ganador más alto del torneo' : `el ${mayores + 1}º puntaje ganador más alto de ${fechasN} fechas`} (récord: ${ar(record > actual.puntos ? record : actual.puntos)} en la fecha ${(record > actual.puntos ? previosPorFecha.find(x => x.puntos === record) : actual).fecha}; el más bajo: ${ar(Math.min(...unoPorFecha.map(x => x.puntos)))}).` });
    // Repetidos: ¿alguien ganó dos veces?
    const veces = {}; lista.forEach(x => { veces[x.user_id] = (veces[x.user_id] || 0) + 1; });
    const dobles = Object.values(veces).filter(n => n > 1).length;
    hechos.push({ tipo: 'nadie-gano-dos-veces', juego: j, dato: dobles ? `En el ${j} ya hay ${dobles} usuario(s) que ganaron más de una fecha.` : `En ${fechasN} fechas de ${j}, ${Object.keys(veces).length} ganadores distintos${empates.length ? ` (con empate en la punta en las fechas ${empates.join(', ')})` : ''}: nadie ganó dos veces.` });
    for (const a of actuales) {
      const quien = actuales.length > 1 ? `Uno de los ganadores del ${j}` : `El ganador del ${j}`;
      // Provincia y club del ganador: ¿primera vez?
      const prov = a.perfil.provincia, club = a.perfil.club;
      if (prov) { const antes = [...new Set(previos.filter(x => x.perfil.provincia === prov).map(x => x.fecha))]; hechos.push({ tipo: 'primera-vez-provincia', juego: j, dato: antes.length ? `${quien} es de ${prov}: ya habían ganado desde ${prov} en las fechas ${antes.join(', ')}.` : `Primer ganador del ${j} de ${prov} en el torneo (provincias de los ganadores anteriores: ${[...new Set(previos.map(x => x.perfil.provincia).filter(Boolean))].join(', ')}).` }); }
      if (club) { const antes = [...new Set(previos.filter(x => x.perfil.club === club).map(x => x.fecha))]; hechos.push({ tipo: 'primera-vez-club', juego: j, dato: antes.length ? `${quien} es hincha de ${club}: ya habían ganado hinchas de ${club} en las fechas ${antes.join(', ')}.` : `Primer hincha de ${club} que gana el ${j} en el torneo (clubes de los ganadores anteriores: ${[...new Set(previos.map(x => x.perfil.club).filter(Boolean))].join(', ')}).` }); }
      // Ganador recién anotado: ¿ya había pasado?
      const nuevo = a.perfil.alta && inicioDe[md] ? dias(a.perfil.alta, inicioDe[md]) : null;
      if (nuevo !== null && nuevo <= 10) {
        const otros = [...new Set(previos.filter(x => x.perfil.alta && inicioDe[x.fecha] && dias(x.perfil.alta, inicioDe[x.fecha]) <= 10).map(x => x.fecha))];
        hechos.push({ tipo: 'ganador-recien-anotado', juego: j, dato: `${quien} se anotó ${nuevo} días antes del inicio de la fecha. ${otros.length ? 'Ya había pasado con ganadores de las fechas ' + otros.join(', ') + '.' : 'Es la primera vez en el torneo que gana alguien recién anotado.'}` });
      }
    }
    // Diferencia con el segundo (con empate en la punta es 0)
    const segundo = (F[md][j][1] || {}).puntos;
    if (segundo != null) {
      const difs = anteriores.map(f => (F[f][j][0] && F[f][j][1]) ? r1(F[f][j][0].puntos - F[f][j][1].puntos) : null).filter(x => x !== null);
      const dif = r1(actual.puntos - segundo);
      hechos.push({ tipo: 'diferencia-con-el-segundo', juego: j, dato: `En el ${j} el 1° le sacó ${ar(dif)} al 2° (la mayor del torneo fue ${ar(Math.max(...difs, dif))}, la menor ${ar(Math.min(...difs, dif))}).` });
    }
  }
  // Debutantes en el podio / repetidos
  const debutantes = ganadores.filter(g => !g.top10_anteriores_en_este_juego.length).length;
  hechos.push({ tipo: 'debutantes-en-el-podio', dato: debutantes === 6 ? 'Los seis del podio de esta fecha nunca habían estado ni en un top 10 de una fecha.' : `${debutantes} de los seis del podio nunca habían estado en un top 10; los otros ya tenían historia en el torneo.` });
  const repes = ganadores.filter(g => g.podios_anteriores_en_este_juego.length).map(g => `${g.puesto}° del ${g.juego}, que ya había sido podio en la(s) fecha(s) ${g.podios_anteriores_en_este_juego.join(', ')}`);
  if (repes.length) hechos.push({ tipo: 'repite-podio', dato: 'Repiten podio: ' + repes.join('; ') + '.' });
  const dobleJuego = ganadores.filter(g => g.podios_en_el_otro_juego.length).map(g => `${g.puesto}° del ${g.juego}, también podio de ${g.juego === 'fantasy' ? 'prode' : 'fantasy'} en la(s) fecha(s) ${g.podios_en_el_otro_juego.join(', ')}`);
  if (dobleJuego.length) hechos.push({ tipo: 'podio-en-los-dos-juegos', dato: 'Podio en los dos juegos: ' + dobleJuego.join('; ') + '.' });
  // Clubes del podio contra el censo
  const porClub = {}; ganadores.forEach(g => { if (g.hincha_de) porClub[g.hincha_de] = porClub[g.hincha_de] || { n: 0, pct: g.pct_de_usuarios_hinchas_de_ese_club }; if (g.hincha_de) porClub[g.hincha_de].n++; });
  hechos.push({ tipo: 'clubes-del-podio', dato: 'Clubes de los seis: ' + Object.entries(porClub).map(([c, v]) => `${c} ${v.n} (${v.pct}% de los usuarios)`).join(', ') + '.' });

  // Qué tipos se usaron en las últimas fechas, para no repetir siempre lo mismo
  const todo = leer(ARCHIVO, {});
  const usados = anteriores.slice(-3).map(f => ({ fecha: f, tipos: ((todo[`${COMPETITION}-${SEASON}-${f}`] || {}).ganadores || []).map(g => g.tipo).filter(Boolean) })).filter(x => x.tipos.length);

  return {
    torneo: TORNEO, fecha: md, hoy: new Date(Date.now() - 3 * HORA).toISOString().slice(0, 10), fechas_jugadas: Object.keys(F).length,
    ganadores,
    nombres_de_usuario_de_los_ganadores_NO_NOMBRAR: [...new Set(esta.fantasy.slice(0, 3).concat(esta.prode.slice(0, 3)).flatMap(r => [r.usuario, (P[r.user_id] || {}).usuario]).filter(Boolean))],
    records_y_primeras_veces: hechos,
    tipos_usados_en_fechas_anteriores: usados,
    censo_hinchadas: { clubes_mas_grandes: (censo || []).slice(0, 8).map(c => ({ club: c.team_name, pct: Number(c.fan_pct) })) },
    datos_no_disponibles: [
      'tenencia: cuántos usuarios tenían a cada jugador (no se puede leer)',
      'distribución de provincias de todos los usuarios (sólo se sabe la de los ganadores)',
    ],
  };
}

const TIPOS = ['empate-en-la-punta', 'puntaje-ganador', 'nadie-gano-dos-veces', 'primera-vez-provincia', 'primera-vez-club', 'ganador-recien-anotado', 'diferencia-con-el-segundo', 'debutantes-en-el-podio', 'repite-podio', 'podio-en-los-dos-juegos', 'clubes-del-podio', 'sin-record'];
const ESQUEMA_GANADORES = {
  type: 'object', additionalProperties: false,
  required: ['versiones', 'nota'],
  properties: {
    versiones: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['tipo', 'titulo', 'linea1', 'linea2', 'texto_x'],
        properties: {
          tipo: { type: 'string', enum: TIPOS, description: 'el tipo de récord o primera vez que usa la línea 2' },
          titulo: { type: 'string', description: 'para la caja del editor: "Opción A · récord: ..." / "Opción B · primera vez: ..."' },
          linea1: { type: 'string', description: 'la conclusión sobre los seis ganadores, o que no hubo nada llamativo' },
          linea2: { type: 'string', description: 'el récord o la primera vez, como dato' },
          texto_x: { type: 'string', description: 'versión para X sin el encabezado (lo pone el sistema): una sola línea con lo esencial de las dos, hasta 200 caracteres' },
        },
      },
    },
    nota: { type: 'string', description: 'qué datos usaste y cuáles faltaban' },
  },
};

function problemasGanadores(res, datos) {
  const p = [];
  const vs = (res && res.versiones) || [];
  if (vs.length !== 2) p.push('tienen que ser exactamente 2 versiones (vinieron ' + vs.length + ')');
  vs.forEach((v, i) => {
    const l1 = (v.linea1 || '').trim(), l2 = (v.linea2 || '').trim(), q = 'versión ' + (i + 1) + ': ';
    if (!l1 || !l2) p.push(q + 'faltan las dos líneas');
    if (/\?\s*$/.test(l2) || /\?\s*$/.test(l1)) p.push(q + 'sin pregunta final');
    if (/#\w/.test(l1 + l2)) p.push(q + 'sin hashtags');
    if (/\b(pon[eé]|sum[aá]|conviene|recomend|met[eé]lo|comprá|comprar)\b/i.test(l2)) p.push(q + 'la línea 2 es un dato, no una recomendación');
    const lx = (v.texto_x || '').trim();
    if (!lx) p.push(q + 'falta la versión para X (texto_x)');
    else if (lx.startsWith('🏆')) p.push(q + 'la versión para X no lleva el encabezado: lo agrega el sistema');
    else if (44 + lx.length > MAX_X) p.push(q + `la versión para X es larga: con el encabezado suma ${44 + lx.length} caracteres y X permite 280; apuntá a 200`);
    (datos.nombres_de_usuario_de_los_ganadores_NO_NOMBRAR || []).forEach(n => {
      const limpio = String(n).replace(/^@/, '').replace(/_+$/, '');
      if (limpio.length >= 4 && (l1 + ' ' + l2 + ' ' + lx).toLowerCase().includes(limpio.toLowerCase())) p.push(q + 'no nombrar a los ganadores (' + n + ')');
    });
  });
  if (vs.length === 2 && vs[0].tipo === vs[1].tipo && vs[0].tipo !== 'sin-record') p.push('las dos versiones tienen que usar récords de tipo distinto');
  const recientes = new Set((datos.tipos_usados_en_fechas_anteriores || []).slice(-1).flatMap(x => x.tipos));
  vs.forEach((v, i) => { if (recientes.has(v.tipo) && recientes.size < TIPOS.length - 2) p.push(`versión ${i + 1}: el tipo "${v.tipo}" ya se usó en la fecha anterior; elegí otro para que no sea siempre igual`); });
  return p;
}

async function escribirGanadoresConClaude(datos) {
  const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('falta ANTHROPIC_API_KEY en el ambiente');
  const client = new Anthropic({ maxRetries: 3, timeout: 10 * 60e3 });
  const brief = fs.readFileSync(BRIEF_GANADORES, 'utf8');
  const messages = [{ role: 'user', content: `Fecha ${datos.fecha} del ${TORNEO}. Hoy es ${datos.hoy}. Datos de la base:\n\n\`\`\`json\n${JSON.stringify(datos, null, 1)}\n\`\`\`\n\nEscribí las dos líneas y devolvé el JSON pedido.` }];
  const params = { model: MODEL, max_tokens: 8000, thinking: { type: 'adaptive' }, system: brief, output_config: { format: { type: 'json_schema', schema: ESQUEMA_GANADORES } } };
  for (let intento = 1; intento <= 2; intento++) {
    log(`Claude (${MODEL}), texto de ganadores, intento ${intento}...`);
    const msg = await client.messages.stream({ ...params, messages }).finalMessage();
    if (msg.stop_reason === 'refusal') throw new Error('Claude no quiso escribir el texto de ganadores (refusal)');
    const res = extraerJSON(textoDe(msg));
    const fallas = res ? problemasGanadores(res, datos) : ['la respuesta no es JSON'];
    if (!fallas.length) return res;
    log('el texto de ganadores tiene problemas: ' + fallas.join('; '));
    if (intento === 2) throw new Error('el texto de ganadores siguió con problemas: ' + fallas.join('; '));
    messages.push({ role: 'assistant', content: msg.content });
    messages.push({ role: 'user', content: 'Corregí estos problemas y devolvé el JSON completo de nuevo:\n- ' + fallas.join('\n- ') });
  }
}

// ── Guardar ───────────────────────────────────────────────────────────
function guardar(md, datos, res, resGanadores) {
  const clave = `${COMPETITION}-${SEASON}-${md}`;
  const todo = leer(ARCHIVO, {});
  if (!todo._) todo._ = "Captions escritos (no los del template) por fecha. Clave: <torneo>-<temporada>-<fecha>. Cada entrada de 'ideal' es una versión del caption del 11 Ideal para Instagram: 'titulo' es el ángulo (solo para la caja), 'texto' es lo que se copia. Subir 'v' cada vez que se cambia el texto: descarta lo que se haya editado a mano en el navegador. Si una fecha no está acá, la página arma el caption con el template de siempre. Los escribe tools/captions.js al cierre de cada fecha.";
  const antes = todo[clave] || {};
  const entrada = { ...antes, v: (antes.v || 0) + 1, escrito: new Date().toISOString(), modelo: MODEL };
  if (res) entrada.ideal = res.captions.map(c => ({ titulo: c.titulo, texto: c.texto.trim(), texto_corto: (c.texto_corto || '').trim() || undefined,
    texto_x: c.texto_x ? `🔥 11 IDEAL — FECHA ${md} | ${TORNEO}\n\n` + c.texto_x.trim() : undefined }));
  // El encabezado lo pone el código, no el editor: anuncia de qué es el posteo, como el título del 11 Ideal.
  if (resGanadores) entrada.ganadores = resGanadores.versiones.map(v => ({
    tipo: v.tipo, titulo: v.titulo || 'Ganadores de la fecha',
    texto: `🏆 GANADORES DE LA FECHA ${md} | ${TORNEO}\n\n` + v.linea1.trim() + '\n\n' + v.linea2.trim(),
    texto_x: v.texto_x ? `🏆 GANADORES DE LA FECHA ${md} | ${TORNEO}\n\n` + v.texto_x.trim() : undefined,
  }));
  todo[clave] = entrada;
  fs.writeFileSync(ARCHIVO, JSON.stringify(todo, null, 2) + '\n');

  const informe = path.join(DIR, `fecha-${md}.md`);
  fs.mkdirSync(DIR, { recursive: true });
  const seccionGanadores = resGanadores ? [
    '## 5. Texto de la placa de Ganadores', '',
    ...resGanadores.versiones.flatMap(v => [`### ${v.titulo || 'Versión'} (${v.tipo})`, '', '```', `🏆 GANADORES DE LA FECHA ${md} | ${TORNEO}`, '', v.linea1.trim(), '', v.linea2.trim(), '```', '']),
    'Nota del editor: ' + resGanadores.nota, '',
  ] : [];
  if (!res) {
    // Sólo se rehizo el texto de ganadores: se reemplaza esa sección del informe, si existe.
    let viejo = ''; try { viejo = fs.readFileSync(informe, 'utf8'); } catch (e) { viejo = `# Captions 11 Ideal — Fecha ${md} | ${TORNEO}\n\n`; }
    const sinSeccion = viejo.replace(/\n## 5\. Texto de la placa de Ganadores[\s\S]*$/, '\n');
    fs.writeFileSync(informe, sinSeccion.replace(/\s*$/, '\n\n') + seccionGanadores.join('\n'));
    log(`guardado: captions.json (${clave} v${entrada.v}, ganadores) y ${path.relative(RAIZ, informe)}`);
    return;
  }

  const f = datos.figura_de_la_fecha;
  const a = datos.analisis_de_puntajes;
  const est = e => e === 'sin confirmar' ? '**sin confirmar** (no se usa)' : '**' + e + '**';
  const lineas = [
    `# Captions 11 Ideal — Fecha ${md} | ${TORNEO}`, '',
    `Escrito solo por tools/captions.js el ${datos.hoy} con ${MODEL}. Goles, asistencias, minutos y puntos salen de la base; las historias, de las notas leídas.`, '',
    '## El 11 Ideal (base)', '',
    '| Pos | Jugador | Club | Puntos | Eventos |', '|---|---|---|---|---|',
    ...datos.once_ideal.map(p => `| ${p.posicion} | ${p.nombre}${p.entro_desde_el_banco ? ' (banco)' : ''} | ${p.club} | ${ar(p.puntos)} | ${Object.entries(p.eventos).filter(([, v]) => v).map(([k, v]) => k + (v === true ? '' : ' ' + v)).join(', ')} |`),
    '', `Total del 11: ${ar(datos.total_puntos_del_11)}. ${datos.alguno_entro_desde_el_banco ? 'Alguno entró desde el banco.' : 'Nadie entró desde el banco.'}`, '',
    '## 1. Historias', '',
    ...res.historias.flatMap(h => [
      `### ${h.titulo}`, '',
      `- Dato central: ${h.dato_central}`,
      `- Estado: ${est(h.estado)}`,
      h.toca_al_11 ? `- Toca al 11: ${h.toca_al_11}` : null,
      `- Fuentes: ${h.links.map(l => `<${l}>`).join(', ')}`, '',
    ].filter(x => x !== null)),
    '## 2. Datos de la figura (base)', '',
    `**${f.nombre}**, ${f.club_actual || ''}. ${res.figura}`, '',
    `- Torneo: ${f.torneo.goles} goles en ${f.torneo.partidos_jugados} partidos, ${f.torneo.minutos} minutos${f.torneo.un_gol_cada_minutos ? `, un gol cada ${f.torneo.un_gol_cada_minutos} minutos` : ''}.`,
    ...f.por_club.map(c => `- Con ${c.club}: ${c.goles} goles en ${c.partidos} partidos (fechas ${c.fechas.join(', ')})${c.un_gol_cada_minutos ? `, un gol cada ${c.un_gol_cada_minutos} minutos` : ''}.`),
    `- Fechas seguidas con gol: ${f.fechas_seguidas_con_gol}. En el 11 Ideal: ${f.veces_en_11_ideal.length ? 'fechas ' + f.veces_en_11_ideal.join(', ') : 'nunca antes'}.`,
    f.fechas_que_no_jugo.length ? `- No jugó las fechas ${f.fechas_que_no_jugo.join(', ')}.` : null, '',
    '| Fecha | Club | Partido | Min | Goles | Asist. | Puntos | 11 Ideal |', '|---|---|---|---|---|---|---|---|',
    ...f.partido_a_partido.map(x => `| ${x.fecha} | ${x.club} | ${x.partido} | ${x.minutos} | ${x.goles} | ${x.asistencias} | ${ar(x.puntos)} | ${x.en_11_ideal ? 'sí' : ''} |`), '',
    '## 3. Análisis de puntajes (base)', '',
    res.analisis, '',
    ...(a ? [
      `- Fecha ${md}: ${miles(a.esta_fecha.equipos)} equipos, promedio ${ar(a.esta_fecha.promedio)}, mediana ${ar(a.esta_fecha.mediana)}, p90 ${ar(a.esta_fecha.p90)}, p99 ${ar(a.esta_fecha.p99)}.`,
      `- Ganador: ${a.esta_fecha.top3.map(t => `${t.usuario} ${ar(t.puntos)}`).join(' · ')}. Diferencia 1°-2°: ${ar(a.esta_fecha.diferencia_1_2)}.`,
      ...a.lectura.map(l => '- ' + l), '',
      '| Fecha | Equipos | Promedio | Máximo | Segundo | Dif. 1°-2° | +100 |', '|---|---|---|---|---|---|---|',
      ...Object.entries({ ...a.comparacion_con_otras_fechas, [md]: a.esta_fecha }).sort((x, y) => Number(x[0]) - Number(y[0]))
        .map(([k, v]) => `| ${k} | ${miles(v.equipos)} | ${ar(v.promedio)} | ${ar(v.maximo)} | ${ar(v.segundo)} | ${ar(v.diferencia_1_2)} | ${Math.round(100 * v.mas_de_100 / v.equipos)}% |`),
    ] : ['(no se pudieron leer los puntajes de los usuarios)']),
    '', `Datos no disponibles: ${datos.datos_no_disponibles.join('; ')}.`, '',
    '## 4. Los 4 captions', '',
    ...res.captions.flatMap((c, i) => [`### Caption ${i + 1} — ${c.titulo}`, '', '```', c.texto.trim(), '```', '',
      ...(c.texto_corto ? ['Versión corta:', '', '```', c.texto_corto.trim(), '```', ''] : [])]),
    ...seccionGanadores,
  ].filter(x => x !== null);
  fs.writeFileSync(informe, lineas.join('\n'));
  log(`guardado: captions.json (${clave} v${entrada.v}) y ${path.relative(RAIZ, informe)}`);
}

// ── Main ──────────────────────────────────────────────────────────────
(async () => {
  const md = Number(process.argv[2]);
  if (!md) { console.error('uso: node captions.js <fecha> [--solo-datos] [--solo-ganadores]'); process.exit(2); }
  const soloDatos = process.argv.includes('--solo-datos');
  const soloGanadores = process.argv.includes('--solo-ganadores');
  try {
    // Texto de la placa de Ganadores (barato: sin búsqueda web). Si falla no
    // tira abajo los captions del 11 Ideal: queda en el log y se rehace con --solo-ganadores.
    let resGanadores = null;
    const ganadores = async () => {
      log('fecha ' + md + ': datos de los ganadores y rachas...');
      const dg = await datosGanadores(md);
      if (soloDatos) { console.log(JSON.stringify(dg, null, 1)); return null; }
      return escribirGanadoresConClaude(dg);
    };
    if (soloGanadores) {
      resGanadores = await ganadores();
      if (resGanadores) guardar(md, null, null, resGanadores);
      return;
    }
    log('fecha ' + md + ': juntando los datos de la base...');
    const datos = await datosDeLaFecha(md);
    log(`11 Ideal: ${datos.once_ideal.map(p => p.nombre).join(', ')}`);
    log(`figura: ${datos.figura_de_la_fecha.nombre} (${ar(datos.figura_de_la_fecha.esta_fecha.puntos)})`);
    if (soloDatos) { console.log(JSON.stringify(datos, null, 1)); await ganadores(); return; }
    const res = await escribirConClaude(datos);
    try { resGanadores = await ganadores(); } catch (e) { log('OJO: el texto de ganadores falló: ' + (e.message || e) + ' (rehacer con --solo-ganadores)'); }
    guardar(md, datos, res, resGanadores);
  } catch (e) {
    console.error('[captions] ' + (e.message || e));
    process.exit(1);
  }
})();
