// Tuits con el video de OTRA cuenta puesto adentro (no es cita ni resubida): el texto es
// nuestro y el video sigue siendo del tuit original, con su crédito ("De SportsCenter").
// Se logra pegando al final del tuit el link del original + "/video/1".
//
//   node tools/video-ajeno.js leer --cuentas SC_ESPN,TNTSportsAR --desde 2026-10-11T19:30:00Z
//       → lista los tuits CON VIDEO de esas cuentas desde esa hora (una línea JSON por tuit)
//   X_TEXTO="⚽ GOL de ..." node tools/video-ajeno.js publicar https://x.com/SC_ESPN/status/123 [--probar]
//       → publica el texto + el video de ese tuit
//   node tools/video-ajeno.js borrar <id del tuit nuestro>
//
// Claves de X en el ambiente, como publicar-x.js (X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN,
// X_ACCESS_SECRET). Leer consume crédito de la API: pedir siempre con --desde.
const { TwitterApi } = require('twitter-api-v2');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
// ids ya conocidos: ahorran una lectura por cuenta
const IDS = { sc_espn: '524531680' };

function cliente() {
  const { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET } = process.env;
  if (!X_API_KEY || !X_API_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_SECRET) throw new Error('faltan las claves de X en el ambiente (X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET)');
  return new TwitterApi({ appKey: X_API_KEY, appSecret: X_API_SECRET, accessToken: X_ACCESS_TOKEN, accessSecret: X_ACCESS_SECRET });
}

async function leer() {
  const cuentas = opt('cuentas', 'SC_ESPN').split(',').map(s => s.trim().replace(/^@/, '')).filter(Boolean);
  const desde = new Date(opt('desde', new Date(Date.now() - 15 * 60e3).toISOString()));
  if (isNaN(desde)) throw new Error('--desde tiene que ser una fecha ISO, ej. 2026-10-11T19:30:00Z');
  const client = cliente();
  for (const usuario of cuentas) {
    let id = IDS[usuario.toLowerCase()];
    if (!id) { const u = await client.v2.userByUsername(usuario); id = u.data && u.data.id; console.log(`# ${usuario} = ${id}`); }
    if (!id) { console.log(`# ${usuario}: la cuenta no existe`); continue; }
    const tl = await client.v2.userTimeline(id, {
      start_time: desde.toISOString(), max_results: 100, exclude: ['retweets', 'replies'],
      'tweet.fields': ['created_at', 'attachments'], expansions: ['attachments.media_keys'], 'media.fields': ['type', 'duration_ms'],
    });
    let n = 0;
    for await (const t of tl) {
      n++;
      const video = (tl.includes.medias(t) || []).find(m => m.type === 'video');
      if (!video) continue;
      console.log('TUIT ' + JSON.stringify({ usuario, id: t.id, hora: t.created_at, seg: Math.round((video.duration_ms || 0) / 1000), texto: t.text }));
      if (n >= 100) break;
    }
    console.log(`# ${usuario}: ${n} tuits desde ${desde.toISOString()}`);
  }
}

async function publicar() {
  const link = args.find(a => /^https?:\/\//.test(a)) || '';
  const m = link.match(/^https?:\/\/(?:x|twitter)\.com\/(\w+)\/status\/(\d+)/);
  if (!m) throw new Error('falta el link del tuit original (https://x.com/<cuenta>/status/<id>)');
  const texto = (process.env.X_TEXTO || '').trim();
  if (!texto) throw new Error('falta el texto (X_TEXTO)');
  // X cuenta cualquier link como 23 caracteres
  if (texto.length + 1 + 23 > 280) throw new Error(`el texto tiene ${texto.length} caracteres y con el link se pasa de 280`);
  const tuit = `${texto} https://x.com/${m[1]}/status/${m[2]}/video/1`;
  console.log(tuit);
  if (args.includes('--probar')) return console.log('(prueba: no se publicó)');
  const r = await cliente().v2.tweet({ text: tuit });
  console.log('PUBLICADO https://x.com/i/status/' + (r.data && r.data.id));
}

async function borrar() {
  const id = args.find(a => /^\d+$/.test(a));
  if (!id) throw new Error('falta el id del tuit a borrar');
  await cliente().v2.deleteTweet(id);
  console.log('BORRADO ' + id);
}

const accion = { leer, publicar, borrar }[args[0]];
if (!accion) { console.error('uso: node tools/video-ajeno.js leer|publicar|borrar …'); process.exit(1); }
accion().catch(e => { console.error('ERROR ' + (e.data ? JSON.stringify(e.data) : e.message)); process.exit(1); });
