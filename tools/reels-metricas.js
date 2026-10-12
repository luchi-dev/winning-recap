#!/usr/bin/env node
/**
 * reels-metricas.js — muestra cómo les va a los últimos reels de la cuenta de Instagram:
 * vistas, alcance, me gusta, comentarios, compartidos, guardados y tiempo medio de reproducción.
 *
 *   node reels-metricas.js [cantidad de publicaciones a mirar, 30 por defecto]
 *
 * Imprime una línea "METRICAS " + JSON por reel (para leerla desde el log del workflow).
 * Claves en el ambiente: IG_USER_ID, IG_ACCESS_TOKEN.
 */

const GRAPH = 'https://graph.instagram.com/v23.0';
const METRICAS = ['views', 'reach', 'likes', 'comments', 'shares', 'saved', 'total_interactions', 'ig_reels_avg_watch_time', 'ig_reels_video_view_total_time'];

async function graph(ruta, params) {
  const url = new URL(GRAPH + ruta);
  Object.entries({ ...params, access_token: process.env.IG_ACCESS_TOKEN }).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url);
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(JSON.stringify(d.error || d).slice(0, 200));
  return d;
}

(async () => {
  const { IG_USER_ID, IG_ACCESS_TOKEN } = process.env;
  if (!IG_USER_ID || !IG_ACCESS_TOKEN) throw new Error('faltan IG_USER_ID / IG_ACCESS_TOKEN');
  const cuantos = Number(process.argv[2]) || 30;
  const lista = await graph(`/${IG_USER_ID}/media`, { fields: 'id,permalink,timestamp,media_product_type,media_type,like_count,comments_count,caption', limit: String(cuantos) });
  for (const m of lista.data || []) {
    if (m.media_product_type !== 'REELS') continue;
    const fila = { link: m.permalink, hora: m.timestamp, likes_lista: m.like_count, comentarios_lista: m.comments_count, caption: (m.caption || '').split('\n')[0].slice(0, 70) };
    // cada métrica por separado: si una no existe para ese reel, las demás igual salen
    for (const k of METRICAS) {
      try { const d = await graph(`/${m.id}/insights`, { metric: k }); fila[k] = d.data && d.data[0] && d.data[0].values && d.data[0].values[0] ? d.data[0].values[0].value : null; }
      catch (e) { fila[k] = 'error: ' + e.message.slice(0, 80); }
    }
    console.log('METRICAS ' + JSON.stringify(fila));
  }
  console.log(`[reels-metricas] ${(lista.data || []).length} publicaciones miradas`);
})().catch(e => { console.error('[reels-metricas] ' + (e.message || e)); process.exit(1); });
