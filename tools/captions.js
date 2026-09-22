#!/usr/bin/env node
/**
 * captions.js — escribe los captions del 11 Ideal de una fecha como editor.
 *
 *   node captions.js <fecha>              escribe captions.json y captions/fecha-N.md
 *   node captions.js <fecha> --solo-datos sólo arma y muestra los datos (sin llamar a Claude)
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

const MODEL = process.env.CAPTIONS_MODEL || 'claude-opus-5';
const MAX_BUSQUEDAS = 12, MAX_NOTAS = 15;

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
        required: ['titulo', 'texto'],
        properties: {
          titulo: { type: 'string', description: 'qué historias combina y qué cierre usa, para la caja del editor' },
          texto: { type: 'string', description: 'el caption completo para Instagram, con saltos de línea entre párrafos' },
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

// ── Guardar ───────────────────────────────────────────────────────────
function guardar(md, datos, res) {
  const clave = `${COMPETITION}-${SEASON}-${md}`;
  const todo = leer(ARCHIVO, {});
  if (!todo._) todo._ = "Captions escritos (no los del template) por fecha. Clave: <torneo>-<temporada>-<fecha>. Cada entrada de 'ideal' es una versión del caption del 11 Ideal para Instagram: 'titulo' es el ángulo (solo para la caja), 'texto' es lo que se copia. Subir 'v' cada vez que se cambia el texto: descarta lo que se haya editado a mano en el navegador. Si una fecha no está acá, la página arma el caption con el template de siempre. Los escribe tools/captions.js al cierre de cada fecha.";
  const antes = todo[clave] || {};
  todo[clave] = {
    v: (antes.v || 0) + 1,
    escrito: new Date().toISOString(),
    modelo: MODEL,
    ideal: res.captions.map(c => ({ titulo: c.titulo, texto: c.texto.trim() })),
  };
  fs.writeFileSync(ARCHIVO, JSON.stringify(todo, null, 2) + '\n');

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
    ...res.captions.flatMap((c, i) => [`### Caption ${i + 1} — ${c.titulo}`, '', '```', c.texto.trim(), '```', '']),
  ].filter(x => x !== null);
  fs.mkdirSync(DIR, { recursive: true });
  const informe = path.join(DIR, `fecha-${md}.md`);
  fs.writeFileSync(informe, lineas.join('\n'));
  log(`guardado: captions.json (${clave} v${todo[clave].v}) y ${path.relative(RAIZ, informe)}`);
}

// ── Main ──────────────────────────────────────────────────────────────
(async () => {
  const md = Number(process.argv[2]);
  if (!md) { console.error('uso: node captions.js <fecha> [--solo-datos]'); process.exit(2); }
  const soloDatos = process.argv.includes('--solo-datos');
  try {
    log('fecha ' + md + ': juntando los datos de la base...');
    const datos = await datosDeLaFecha(md);
    log(`11 Ideal: ${datos.once_ideal.map(p => p.nombre).join(', ')}`);
    log(`figura: ${datos.figura_de_la_fecha.nombre} (${ar(datos.figura_de_la_fecha.esta_fecha.puntos)})`);
    if (soloDatos) { console.log(JSON.stringify(datos, null, 1)); return; }
    const res = await escribirConClaude(datos);
    guardar(md, datos, res);
  } catch (e) {
    console.error('[captions] ' + (e.message || e));
    process.exit(1);
  }
})();
