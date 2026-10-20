// Busca en X qué se dijo de unos jugadores y muestra los tuits con más interacciones
// (para escribir los posteos con lo que anda diciendo la gente). Lee tuits con la API
// de X: consume crédito (hasta --max por búsqueda).
//
//   node tools/buscar-x.js --desde 2026-10-16 [--max 100] "Galván=(\"Tomás Galván\" OR Galván) River" "Ávila=..."
//
// Cada búsqueda es "Nombre=consulta de X" (se le agrega -is:retweet). Imprime el top 10
// de cada una ordenado por likes + 2×RT + 2×citas + respuestas.
const { TwitterApi } = require('twitter-api-v2');

const args = process.argv.slice(2);
const opt = (k, def) => { const i = args.indexOf('--' + k); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const desde = opt('desde', null);
const max = Math.min(Number(opt('max', 100)), 500);
const busquedas = args.map(a => { const i = a.indexOf('='); return { nombre: a.slice(0, i), q: a.slice(i + 1) }; });

(async () => {
  const { X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET } = process.env;
  if (!X_API_KEY || !X_ACCESS_TOKEN) throw new Error('faltan las claves de X en el ambiente');
  const client = new TwitterApi({ appKey: X_API_KEY, appSecret: X_API_SECRET, accessToken: X_ACCESS_TOKEN, accessSecret: X_ACCESS_SECRET });
  let leidos = 0;
  for (const b of busquedas) {
    const params = {
      max_results: Math.min(max, 100), sort_order: 'relevancy',
      'tweet.fields': ['created_at', 'public_metrics', 'author_id'], expansions: ['author_id'], 'user.fields': ['username', 'public_metrics'],
    };
    if (desde) params.start_time = new Date(desde).toISOString();
    const pag = await client.v2.search(b.q + ' -is:retweet', params);
    const lista = [];
    for await (const t of pag) {
      const u = pag.includes.author(t) || {};
      const m = t.public_metrics || {};
      lista.push({ cuenta: u.username, seguidores: (u.public_metrics || {}).followers_count, fecha: t.created_at, texto: t.text.replace(/\s+/g, ' '),
        likes: m.like_count, rt: m.retweet_count, citas: m.quote_count, resp: m.reply_count,
        puntaje: m.like_count + 2 * m.retweet_count + 2 * m.quote_count + m.reply_count, url: `https://x.com/${u.username}/status/${t.id}` });
      if (lista.length >= max) break;
    }
    leidos += lista.length;
    lista.sort((a, b) => b.puntaje - a.puntaje);
    console.log(`\n===== ${b.nombre} (${lista.length} tuits) — ${b.q}`);
    for (const t of lista.slice(0, 10)) {
      console.log(`\n♥${t.likes} 🔁${t.rt} 💬${t.resp} ❝${t.citas} | @${t.cuenta} (${t.seguidores} seg.) ${t.fecha}\n${t.texto}\n${t.url}`);
    }
  }
  console.log(`\n[buscar-x] ${leidos} tuits leídos en total`);
})().catch(e => { console.error('[buscar-x] error:', e.data ? JSON.stringify(e.data) : e.message); process.exit(1); });
