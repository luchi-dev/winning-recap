// Buscador de frases post-partido: entrevistas en X → la frase más polémica → frases.json
// (la placa la arma el index, Editorial → Frases; se publica con publicar-auto.js frase).
//
//   node tools/entrevistas.js --partido <game_id> [--dry] [--horas 4]
//   node tools/entrevistas.js --fecha <N> [--dry]         (todos los partidos de la fecha)
//
// Fuentes (ver memoria "entrevistas TNT"): @TNTSportsAR escribe la frase en el tuit
// ("FRASE" Fulano habló luego de…); @juegosimple__ la escribe en un tuit sin video y
// sube el video como respuesta propia (se juntan los dos). Se leen con la API de X
// (claves X_API_KEY…, consume crédito) entre el kickoff y --horas después.
//
// Elige con Claude si hay ANTHROPIC_API_KEY (frase textual, quién la dijo, de quién
// habla, polémica 1-10, formato frase o preguntas); si no, con reglas (palabras
// polémicas). Fotos: tarjeta = quien la dijo (fotos/<id>.png si es de la LPF, si no la
// miniatura del video); fondo = de quién habla (Wikimedia si es alguien de afuera), si
// no la foto del partido (fotos-partido/<game>-original.jpg). Queda estado 'para_aprobar'.
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = 'https://ketwxvbrhqbemlflmadu.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtldHd4dmJyaHFiZW1sZmxtYWR1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4NjA4MDcsImV4cCI6MjA4NjQzNjgwN30.-qXPLMSFEiRORNk5EUKrD16VDiMXtv-VfcDSWpzWzsg';
const COMPETITION = 724, SEASON = 2026;
const RAIZ = path.resolve(__dirname, '..');
const JSON_FRASES = path.join(RAIZ, 'frases.json');
const HORA = 3600e3;
const CUENTAS = (process.env.FRASES_CUENTAS || 'TNTSportsAR,juegosimple__').split(',');
const POLEMICA_MIN = 6;
const REGLAS_MIN = 4;       // sin Claude: puntos mínimos de palabras polémicas (ver puntajeReglas)     // con Claude: menos que esto no se arma placa
const MODELO = process.env.FRASES_MODEL || 'claude-opus-5-5';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const DRY = args.includes('--dry');
const log = m => console.log('[entrevistas] ' + m);

const H = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY };
async function api(ruta, perfil) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + ruta, { headers: perfil ? { ...H, 'Accept-Profile': perfil } : H });
  if (!r.ok) throw new Error(ruta.split('?')[0] + ' -> HTTP ' + r.status);
  return r.json();
}
const sinAcentos = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const normal = s => sinAcentos(s).replace(/[“”"«»'’.,;:!¡?¿…()\-–—]/g, ' ').replace(/\s+/g, ' ').trim();

// ── Partidos y planteles ──────────────────────────────────────────────
const NO_CLAVE = ['club', 'atletico', 'deportivo', 'plate', 'juniors', 'central', 'sarsfield', 'rio', 'mendoza', 'lp'];
const APODOS = {
  'boca': ['xeneize'], 'river': ['millonario'], 'racing': ['academia'], 'independiente': ['rojo'], 'san lorenzo': ['ciclon', 'cuervo'],
  'estudiantes': ['pincha'], 'gimnasia': ['lobo', 'tripero'], 'velez': ['fortin'], 'huracan': ['globo'], 'newell': ['lepra'],
  'rosario central': ['canalla'], 'talleres': ['tallarin', 't'], 'belgrano': ['pirata'], 'lanus': ['granate'], 'banfield': ['taladro'],
};
async function partidos(filtro) {
  const fx = await api('v_fixtures?select=game_id,matchday,kickoff_ts,opta_period,home_id,away_id,home_team_display,away_team_display,home_score,away_score' +
    '&competition_id=eq.' + COMPETITION + '&season_id=eq.' + SEASON + '&' + filtro + '&order=kickoff_ts');
  const equipos = [...new Set(fx.flatMap(f => [f.home_id, f.away_id]))];
  if (!equipos.length) return [];
  const plantel = await api('squads?select=player_id,team_id&team_id=in.(' + equipos.join(',') + ')', 'winning_lpf').catch(() => []);
  const ids = [...new Set(plantel.map(p => p.player_id))];
  const pu = {};
  for (let i = 0; i < ids.length; i += 150) {
    (await api('player_universe?select=player_id,known_name,first_name,last_name&player_id=in.(' + ids.slice(i, i + 150).join(',') + ')', 'winning_lpf').catch(() => []))
      .forEach(p => { pu[p.player_id] = p; });
  }
  return fx.map(f => {
    const claves = new Set();
    [f.home_team_display, f.away_team_display].map(sinAcentos).forEach(e => {
      claves.add(e);
      e.split(' ').filter(w => w.length > 3 && !NO_CLAVE.includes(w)).forEach(w => claves.add(w));
      Object.entries(APODOS).forEach(([k, v]) => { if (e.includes(k)) v.filter(x => x.length > 2).forEach(x => claves.add(x)); });
    });
    const jugadores = plantel.filter(p => p.team_id === f.home_id || p.team_id === f.away_id).map(p => {
      const n = pu[p.player_id] || {};
      const completo = n.known_name || [n.first_name, n.last_name].filter(Boolean).join(' ');
      return { id: p.player_id, team_id: p.team_id, nombre: completo, apellido: sinAcentos((n.last_name || completo).split(' ').pop()) };
    }).filter(j => j.nombre);
    return { ...f, nombre: f.home_team_display + ' vs ' + f.away_team_display, claves: [...claves], jugadores };
  });
}
const conPalabra = (txt, w) => new RegExp('(^|[^a-z])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z]|$)').test(txt);
/* Cuánto nombra un tuit a un partido: equipos (3), jugadores con nombre completo (2) o sólo apellido (1).
   Hace falta nombrar a un equipo o a un jugador con nombre completo: un apellido suelto no alcanza. */
function nombraPartido(texto, p) {
  const t = sinAcentos(texto).replace(/[#@]/g, ' ');
  const eq = p.claves.filter(w => conPalabra(t, w)).length;
  const completos = p.jugadores.filter(j => j.nombre.includes(' ') && conPalabra(t, sinAcentos(j.nombre))).length;
  const apellidos = p.jugadores.filter(j => j.apellido.length > 3 && conPalabra(t, j.apellido)).length;
  return eq || completos ? eq * 3 + completos * 2 + apellidos : 0;
}
/* Cada tuit va a UN partido: el que más nombra entre los que se jugaban a esa hora. */
function repartir(todas, ps, horas) {
  const de = new Map();
  for (const e of todas) {
    const t = new Date(e.fecha).getTime();
    let mejor = null;
    for (const p of ps) {
      const k = new Date(p.kickoff_ts).getTime();
      if (t < k - 30 * 60e3 || t > k + horas * HORA) continue;
      const n = nombraPartido(e.texto, p);
      if (n && (!mejor || n > mejor.n || (n === mejor.n && Math.abs(t - k) < Math.abs(t - mejor.k)))) mejor = { p, n, k };
    }
    if (mejor) { if (!de.has(mejor.p.game_id)) de.set(mejor.p.game_id, []); de.get(mejor.p.game_id).push(e); }
  }
  return de;
}

// ── X ─────────────────────────────────────────────────────────────────
function clienteX() {
  const { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET } = process.env;
  if (!X_API_KEY || !X_ACCESS_TOKEN) throw new Error('faltan las claves de X en el ambiente');
  const { TwitterApi } = require('twitter-api-v2');
  return new TwitterApi({ appKey: X_API_KEY, appSecret: X_API_SECRET, accessToken: X_ACCESS_TOKEN, accessSecret: X_ACCESS_SECRET });
}
const idsCuenta = {};
async function tuits(client, usuario, desde, hasta) {
  if (!idsCuenta[usuario]) idsCuenta[usuario] = (await client.v2.userByUsername(usuario)).data.id;
  const tl = await client.v2.userTimeline(idsCuenta[usuario], {
    start_time: desde.toISOString(), end_time: hasta.toISOString(), max_results: 100, exclude: ['retweets'],
    'tweet.fields': ['created_at', 'conversation_id', 'referenced_tweets', 'in_reply_to_user_id'],
    expansions: ['attachments.media_keys'], 'media.fields': ['type', 'duration_ms', 'variants', 'preview_image_url'],
  });
  const out = [];
  for await (const t of tl) {
    const v = (tl.includes.medias(t) || []).find(m => m.type === 'video');
    const mp4 = v && (v.variants || []).filter(x => x.content_type === 'video/mp4').sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0))[0];
    const padre = (t.referenced_tweets || []).find(r => r.type === 'replied_to');
    out.push({ id: t.id, cuenta: usuario, fecha: t.created_at, texto: t.text, padre: t.in_reply_to_user_id === idsCuenta[usuario] && padre ? padre.id : null,
      video: v ? { seg: Math.round((v.duration_ms || 0) / 1000), mp4: mp4 && mp4.url, miniatura: v.preview_image_url } : null });
    if (out.length >= 600) break;
  }
  log(`@${usuario}: ${out.length} tuits leídos`);
  return out;
}

/* Entrevistas: tuit con frase + video. Juego Simple: texto en el tuit padre y video en la respuesta. */
const LIMPIAR = [/Viví el Torneo[\s\S]*$/i, /#\w+/g, /https:\/\/t\.co\/\S+/g, /📹:?.*$/m, /🎙️:?.*$/m];
const limpio = s => LIMPIAR.reduce((a, r) => a.replace(r, ''), String(s)).replace(/[ \t]+/g, ' ').trim();
const ES_JUGADA = /\b(gol|golazo|atajada|atajad[oó]n|caño|asistencia|expulsad|amonestad|anularon|le gana|empata|doblete|cabezazo|remate|definici[oó]n)\b/i;
const ES_DECLARACION = /[“"«][^”"»]{15,}[”"»]|🗣|firma:|declaraciones|habl[oó]|la palabra de|la respuesta de|conferencia|dijo|se refiri[oó]|analiz[oó]|◉/i;
function entrevistas(lista) {
  const porId = Object.fromEntries(lista.map(t => [t.id, t]));
  const out = [];
  for (const t of lista) {
    let texto = t.texto, video = t.video, base = t;
    if (t.padre && porId[t.padre] && video && limpio(t.texto).length < 20) { base = porId[t.padre]; texto = base.texto; }   // video de Juego Simple
    else if (!video) continue;
    const l = limpio(texto);
    if (!ES_DECLARACION.test(l)) continue;
    if (ES_JUGADA.test(l) && !/[“"«][^”"»]{15,}[”"»]|firma:/i.test(l)) continue;
    out.push({ id: base.id, video_id: t.id, cuenta: t.cuenta, fecha: base.fecha, texto: l, video });
  }
  // Un mismo tuit padre puede tener varias respuestas con video: queda una.
  return out.filter((e, i) => out.findIndex(x => x.id === e.id) === i);
}

// ── Elegir la frase ───────────────────────────────────────────────────
const POLEMICAS = ['arbitr', 'juez', 'var', 'robo', 'robaron', 'vergüenza', 'verguenza', 'bronca', 'renuncia', 'afa', 'tapia', 'dirigente', 'presidente',
  'hinchas', 'insult', 'mentira', 'no me', 'nunca', 'culpa', 'crack', 'inexplicable', 'enojo', 'enojado', 'penal', 'polémic', 'polemic', 'traición', 'traicion', 'humill', 'burla'];
function puntajeReglas(e) {
  const t = sinAcentos(e.texto);
  let p = POLEMICAS.filter(w => t.includes(sinAcentos(w))).length * 2;
  if (/!|\?|🤬|😡|🔥|👀/.test(e.texto)) p += 1;
  if (/\b(dt|entrenador|presidente)\b/.test(t)) p += 1;
  return p;
}
function frasesDe(texto) {
  const q = [...texto.matchAll(/[“"«]([^”"»]{12,})[”"»]/g)].map(m => m[1].trim());
  if (q.length) return q;
  const f = texto.match(/^([\s\S]+?)\s*firma:/i);
  return f ? [f[1].trim()] : [];
}
/* Las frases de TNT vienen en mayúsculas: pasarlas a oración, con los nombres propios que se conocen. */
function aOracion(s, nombres) {
  const letras = s.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ]/g, '');
  if (!letras || letras !== letras.toUpperCase()) return s;
  let o = s.toLowerCase().replace(/(^\s*|[.!?]\s+)([a-záéíóúñ])/g, (m, a, b) => a + b.toUpperCase());
  nombres.forEach(n => n.split(/\s+/).filter(w => w.length > 2).forEach(w => {
    o = o.replace(new RegExp('(^|[^a-záéíóúñ])(' + w.toLowerCase() + ')(?=[^a-záéíóúñ]|$)', 'g'), (m, a) => a + w[0].toUpperCase() + w.slice(1).toLowerCase());
  }));
  return o;
}
function hablanteReglas(e, p) {
  const t = e.texto;
  const firma = t.match(/firma:\s*([^\n.]+)/i);
  if (firma) return firma[1].trim();
  const jug = p.jugadores.find(j => j.nombre.split(' ').length > 1 && sinAcentos(t).includes(sinAcentos(j.nombre)));
  if (jug) return jug.nombre;
  const m = t.replace(/[“"«][^”"»]*[”"»]/g, ' ').match(/(?:palabra de|declaraciones de|respuesta de|bronca de|enojo de|opini[oó]n de|elecciones de|preguntas a)?\s*((?:[A-ZÁÉÍÓÚÑ][a-záéíóúñ'.]+|[A-ZÁÉÍÓÚÑ]{2,})(?:\s+(?:de\s+)?(?:[A-ZÁÉÍÓÚÑ][a-záéíóúñ'.]+|[A-ZÁÉÍÓÚÑ]{3,})){1,3})\s*(?:,|habl|asegur|declar|se refiri|analiz|y su|tras|luego|sobre|cuando|en )/);
  return m ? m[1].trim() : '';
}
function preguntasDe(texto) {
  const rs = [...texto.matchAll(/[◉•-]?\s*¿([^?]{3,80})\?\s*([^\n◉•¿]{2,60})/g)].map(m => ({ pregunta: '¿' + m[1].trim() + '?', respuesta: m[2].trim().replace(/[.]$/, '') }));
  return rs.length >= 3 ? rs : null;
}

async function elegirConClaude(p, cands) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ maxRetries: 3, timeout: 10 * 60e3 });
  const brief = fs.readFileSync(path.join(__dirname, 'frases-brief.md'), 'utf8');
  const entrada = cands.map((e, i) => `#${i} @${e.cuenta} ${e.fecha}\n${e.texto}`).join('\n\n');
  const r = await client.messages.stream({
    model: MODELO, max_tokens: 8000, thinking: { type: 'adaptive' },
    system: brief,
    messages: [{ role: 'user', content: `Partido: ${p.nombre} (${p.home_score ?? ''}-${p.away_score ?? ''}), fecha ${p.matchday} del Clausura 2026.\nJugadores de los dos planteles: ${p.jugadores.map(j => j.nombre).join(', ')}\n\nTuits:\n\n${entrada}` }],
    output_config: { format: { type: 'json_schema', schema: {
      type: 'object', additionalProperties: false, required: ['hay', 'indice', 'frase', 'hablante', 'sujeto', 'sujeto_tipo', 'formato', 'preguntas', 'polemica', 'por_que'],
      properties: {
        hay: { type: 'boolean' }, indice: { type: 'integer' }, frase: { type: 'string' }, hablante: { type: 'string' },
        sujeto: { type: 'string' }, sujeto_tipo: { type: 'string', enum: ['mismo', 'jugador_lpf', 'club', 'arbitro', 'dirigente', 'otra_persona', 'nadie'] },
        formato: { type: 'string', enum: ['frase', 'preguntas'] },
        preguntas: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['pregunta', 'respuesta'], properties: { pregunta: { type: 'string' }, respuesta: { type: 'string' } } } },
        polemica: { type: 'integer' }, por_que: { type: 'string' },
      } } } },
  }).finalMessage();
  const j = JSON.parse(r.content.find(c => c.type === 'text').text);
  log(`Claude: ${j.hay ? '#' + j.indice + ' polémica ' + j.polemica + ' — ' + j.por_que : 'nada que valga la pena: ' + j.por_que}`);
  if (!j.hay || j.polemica < POLEMICA_MIN || !cands[j.indice]) return null;
  // La frase tiene que estar tal cual en el tuit (sin contar mayúsculas, comillas ni puntuación).
  if (j.formato === 'frase' && !normal(cands[j.indice].texto).includes(normal(j.frase))) { log('OJO: la frase de Claude no está textual en el tuit: se descarta'); return null; }
  return { e: cands[j.indice], frase: j.frase, hablante: j.hablante, sujeto: j.sujeto, sujeto_tipo: j.sujeto_tipo, formato: j.formato, preguntas: j.preguntas, polemica: j.polemica, por_que: j.por_que, elegida_por: 'claude' };
}
function elegirConReglas(p, cands) {
  const nombres = [p.home_team_display, p.away_team_display, ...p.jugadores.map(j => j.nombre)];
  const conPuntos = cands.map(e => ({ e, pts: puntajeReglas(e), frases: frasesDe(e.texto) }))
    .filter(x => (x.frases.length || preguntasDe(x.e.texto)) && x.pts >= REGLAS_MIN && hablanteReglas(x.e, p));
  if (!conPuntos.length) return null;
  conPuntos.sort((a, b) => b.pts - a.pts || new Date(a.e.fecha) - new Date(b.e.fecha));
  const { e, pts, frases } = conPuntos[0];
  const preguntas = preguntasDe(e.texto);
  // De TNT: la cita secundaria (🗣️"…") suele venir en minúscula y más completa que el título.
  const frase = aOracion(frases.slice().sort((a, b) => (a === a.toUpperCase()) - (b === b.toUpperCase()) || b.length - a.length)[0] || '', nombres);
  const deArbitro = /arbitr|referi|\bjuez\b/.test(sinAcentos(e.texto));
  return { e, frase, hablante: hablanteReglas(e, p), sujeto: deArbitro ? 'árbitro' : '', sujeto_tipo: deArbitro ? 'arbitro' : 'mismo', formato: preguntas ? 'preguntas' : 'frase', preguntas: preguntas || [], polemica: pts, por_que: 'reglas: ' + pts + ' puntos de palabras polémicas', elegida_por: 'reglas' };
}

// ── Fotos ─────────────────────────────────────────────────────────────
async function bajar(url, destino) {
  const r = await fetch(url, { headers: { 'User-Agent': 'WinningRecap/1.0 (luchi-dev/winning-recap)' } });
  if (!r.ok) throw new Error('no bajó ' + url + ': ' + r.status);
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, Buffer.from(await r.arrayBuffer()));
  return destino;
}
/* El árbitro del partido, de la base (fixtures.referee_id → referee_universe). */
async function arbitroDe(gameId) {
  const f = await api('fixtures?select=referee_id&game_id=eq.' + gameId, 'winning_lpf').catch(() => []);
  if (!f[0] || !f[0].referee_id) return null;
  const r = await api('referee_universe?select=known_name,first_name,last_name&referee_id=eq.' + f[0].referee_id, 'winning_lpf').catch(() => []);
  return r[0] ? (r[0].known_name || r[0].first_name + ' ' + r[0].last_name) : null;
}
/* Retrato libre de Wikimedia Commons para alguien que no es de la LPF. El título del archivo
   tiene que traer el nombre completo (hay homónimos: "Darío Herrera" también es un ministro de
   Ecuador); si es árbitro, además "referee" o "árbitro". */
async function fotoWikimedia(nombre, destino, tipo) {
  const arbitro = tipo === 'arbitro';
  const u = 'https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrlimit=15&prop=imageinfo&iiprop=url|size&iiurlwidth=1600&format=json&gsrsearch=' + encodeURIComponent(nombre + (arbitro ? ' referee' : '') + ' filetype:bitmap');
  const j = await (await fetch(u, { headers: { 'User-Agent': 'WinningRecap/1.0 (luchi-dev/winning-recap)' } })).json();
  const palabras = sinAcentos(nombre).split(/\s+/).filter(w => w.length > 2);
  const fotos = Object.values((j.query || {}).pages || {}).map(x => ({ t: x.title, ...(x.imageinfo || [])[0] }))
    .filter(x => x.width >= 700 && palabras.every(w => sinAcentos(x.t).includes(w)) && (!arbitro || /referee|arbitro|árbitro/i.test(x.t)) && !/logo|escudo|firma|signature|map|mapa/i.test(x.t))
    .sort((a, b) => (b.height / b.width) - (a.height / a.width));
  if (!fotos.length) return null;
  await bajar(fotos[0].thumburl || fotos[0].url, destino);
  return { fuente: 'Wikimedia Commons: ' + fotos[0].t.replace(/^File:/, '') };
}
/* Las caras recortadas de los jugadores: en la compu están en fotos/; en GitHub, se mira la lista del sitio. */
let listaFotos = null;
async function hayFotoJugador(id) {
  if (fs.existsSync(path.join(RAIZ, 'fotos', id + '.png'))) return true;
  if (!listaFotos) { try { listaFotos = new Set((await (await fetch('https://winning.com.ar/iloveneuquen/fotos/lista.json?v=' + Date.now())).json()).ids); } catch (e) { listaFotos = new Set(); } }
  return listaFotos.has(id);
}
async function armarFotos(p, el, dir, rel) {
  const fotos = [], sujetoJug = p.jugadores.find(j => el.sujeto && sinAcentos(el.sujeto).includes(j.apellido) && j.apellido.length > 3);
  // Fondo: de quién habla la frase.
  if (el.sujeto && ['otra_persona', 'dirigente', 'arbitro'].includes(el.sujeto_tipo)) {
    try { const w = await fotoWikimedia(el.sujeto, path.join(dir, 'sujeto.jpg'), el.sujeto_tipo); if (w) fotos.push({ archivo: rel + '/sujeto.jpg', fuente: w.fuente, pos: { x: 50, y: 30, zoom: 1 } }); else log('sin foto libre de ' + el.sujeto + ': queda la del partido (se puede subir a mano)'); } catch (e) { log('wikimedia: ' + e.message); }
  }
  // Declaración propia: la foto grande es del que habla (cuadros del video a buena resolución).
  const propia = !el.sujeto || ['mismo', 'nadie', 'club'].includes(el.sujeto_tipo);
  if (propia && el.e.video && el.e.video.mp4) {
    try {
      const { sacarCuadros } = require('./frases.js');
      (await sacarCuadros(el.e.video.mp4, el.e.video.seg, dir, 4)).slice(1, 3)
        .forEach(c => fotos.push({ archivo: rel + '/' + c.archivo, fuente: 'video de @' + el.e.cuenta + ', ' + c.seg + ' s', pos: { x: 50, y: 10, zoom: 1.35 } }));   // zoom: afuera el zócalo y el marcador de la transmisión
    } catch (e) { log('cuadros del video: ' + e.message); }
  }
  const partido = 'fotos-partido/' + p.game_id + '-original.jpg';
  fotos.push({ archivo: partido, fuente: 'foto del partido' });
  if (el.e.video && el.e.video.miniatura) {
    try { await bajar(el.e.video.miniatura, path.join(dir, 'video.jpg')); fotos.push({ archivo: rel + '/video.jpg', fuente: 'video de @' + el.e.cuenta }); } catch (e) { log(e.message); }
  }
  // Tarjeta: quien la dijo. Recorte del medio-arriba de la miniatura (en las entrevistas la cara va al centro).
  const jug = p.jugadores.find(j => el.hablante && sinAcentos(el.hablante).includes(j.apellido) && j.apellido.length > 3);
  let foto_autor = null;
  if (jug && await hayFotoJugador(jug.id)) foto_autor = { archivo: 'fotos/' + jug.id + '.png', jugador_id: jug.id };
  else if (fotos.some(f => f.archivo === rel + '/video.jpg')) {
    const sharp = require('sharp');
    const m = await sharp(path.join(dir, 'video.jpg')).metadata();
    const h = Math.round(m.height * 0.62), w = Math.round(h * 226 / 181);
    foto_autor = { archivo: rel + '/video.jpg', recorte: [Math.round((m.width - w) / 2), Math.round(m.height * 0.06), w, h] };
  }
  return { fotos, foto_autor, sujeto_jugador_id: sujetoJug && sujetoJug.id, hablante_jugador_id: jug && jug.id };
}

// ── Principal ─────────────────────────────────────────────────────────
async function main() {
  const partido = opt('partido'), fecha = opt('fecha'), horas = +opt('horas', 4);
  if (!partido && !fecha) { console.log('Uso: node tools/entrevistas.js --partido <game_id> | --fecha <N> [--dry] [--horas 4]'); process.exit(1); }
  const ps = await partidos(partido ? 'game_id=eq.' + partido : 'matchday=eq.' + fecha);
  if (!ps.length) throw new Error('no encontré el partido o la fecha');
  const client = clienteX();
  const desde = new Date(new Date(ps[0].kickoff_ts).getTime() - 30 * 60e3);
  const hasta = new Date(Math.min(Date.now() - 60e3, new Date(ps[ps.length - 1].kickoff_ts).getTime() + horas * HORA));
  let lista = [];
  for (const c of CUENTAS) { try { lista = lista.concat(await tuits(client, c.trim(), desde, hasta)); } catch (e) { log(`@${c}: ${e.data ? JSON.stringify(e.data).slice(0, 200) : e.message}`); } }
  const todas = entrevistas(lista);
  log(`${todas.length} tuits parecen entrevista`);

  let todo = { frases: [] };
  try { todo = JSON.parse(fs.readFileSync(JSON_FRASES, 'utf8')); } catch (e) {}
  const usadas = new Set(todo.frases.map(f => f.id));
  const nuevas = [];
  // Para repartir bien, se comparan con todos los partidos de la fecha (no sólo los pedidos).
  const todosLosDeLaFecha = partido ? await partidos('matchday=eq.' + ps[0].matchday) : ps;
  const reparto = repartir(todas, todosLosDeLaFecha, horas);
  for (const p of ps) {
    // Del partido: lo nombra y salió entre el kickoff y `horas` después.
    const cands = (reparto.get(p.game_id) || []).filter(e => !usadas.has('x-' + e.id));
    log(`${p.nombre}: ${cands.length} entrevistas`);
    cands.forEach(e => log(`   · @${e.cuenta} ${e.fecha.slice(11, 16)} ${e.texto.replace(/\s+/g, ' ').slice(0, 150)}`));
    if (!cands.length) continue;
    const el = process.env.ANTHROPIC_API_KEY ? await elegirConClaude(p, cands) : elegirConReglas(p, cands);
    if (!el || (!el.frase && el.formato === 'frase')) { log(`${p.nombre}: nada para armar`); continue; }
    if (el.sujeto_tipo === 'arbitro') { const a = await arbitroDe(p.game_id); if (a) el.sujeto = a; }
    const id = 'x-' + el.e.id, rel = 'frases/' + id, dir = path.join(RAIZ, rel);
    log(`${p.nombre}: ELEGIDA (${el.elegida_por}, ${el.por_que}) → "${el.frase}" — ${el.hablante || '¿?'}${el.sujeto ? ' · habla de ' + el.sujeto + ' (' + el.sujeto_tipo + ')' : ''}`);
    const f = DRY ? { fotos: [], foto_autor: null } : await armarFotos(p, el, dir, rel);
    nuevas.push({
      id, estado: 'para_aprobar', tipo: el.formato, texto: el.frase, texto_corto: '', usar_corto: false, autor: el.hablante, sujeto: el.sujeto || '', sujeto_tipo: el.sujeto_tipo,
      preguntas: el.preguntas && el.preguntas.length ? el.preguntas : undefined,
      game_id: p.game_id, matchday: p.matchday, partido: p.nombre,
      fuente: { red: 'x', url: `https://x.com/${el.e.cuenta}/status/${el.e.id}`, cuenta: '@' + el.e.cuenta, fecha: el.e.fecha, video: el.e.video_id !== el.e.id ? `https://x.com/${el.e.cuenta}/status/${el.e.video_id}` : undefined },
      tuit: el.e.texto, polemica: el.polemica, por_que: el.por_que, elegida_por: el.elegida_por,
      fotos: f.fotos, foto: 0, foto_autor: f.foto_autor, tarjeta: !!(el.sujeto && !['mismo', 'nadie', 'club'].includes(el.sujeto_tipo)), jugador_id: f.hablante_jugador_id, diseno: 'mayus', v: 1,
    });
  }
  if (DRY) { console.log(JSON.stringify(nuevas, null, 2)); return; }
  if (!nuevas.length) { log('ninguna frase nueva'); return; }
  todo.frases = nuevas.concat(todo.frases.filter(f => !nuevas.some(n => n.id === f.id)));
  fs.writeFileSync(JSON_FRASES, JSON.stringify(todo, null, 2) + '\n');
  log(`frases.json: ${nuevas.length} nuevas para aprobar (${nuevas.map(n => n.id).join(', ')})`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'nuevas=' + nuevas.map(n => n.id).join(',') + '\n');
}

if (require.main === module) main().catch(e => { console.error(e.data ? JSON.stringify(e.data) : (e.message || e)); process.exit(1); });
module.exports = { partidos, entrevistas, elegirConReglas, frasesDe, aOracion, hablanteReglas, preguntasDe };
