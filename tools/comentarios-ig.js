/**
 * comentarios-ig.js — leer y responder comentarios de @winning en Instagram.
 *
 *   node tools/comentarios-ig.js listar [N]             los últimos N posteos (10 si no se dice)
 *                                                       con sus comentarios y si ya les respondimos
 *   node tools/comentarios-ig.js responder <id> "texto"  responde un comentario como @winning
 *
 * El id y el texto también pueden venir por ambiente (COMENTARIO_ID, TEXTO),
 * que es como los pasa el workflow "Comentarios IG".
 * Claves en el ambiente: IG_USER_ID, IG_ACCESS_TOKEN.
 */

const GRAPH_IG = 'https://graph.instagram.com/v21.0';

async function graphIG(ruta, params = {}, metodo = 'GET') {
  const url = new URL(GRAPH_IG + ruta);
  Object.entries({ ...params, access_token: process.env.IG_ACCESS_TOKEN }).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url, { method: metodo });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error('Instagram respondió ' + r.status + ': ' + JSON.stringify(d.error || d).slice(0, 300));
  return d;
}

async function todos(ruta, params) {
  const out = [];
  let d = await graphIG(ruta, params);
  for (;;) {
    out.push(...(d.data || []));
    if (!d.paging || !d.paging.next) return out;
    const r = await fetch(d.paging.next);
    d = await r.json();
    if (d.error) return out;
  }
}

const corto = (t, n = 90) => (t || '').replace(/\s+/g, ' ').trim().slice(0, n);

async function listar(n) {
  const yo = await graphIG('/me', { fields: 'username' });
  const posteos = (await graphIG(`/${process.env.IG_USER_ID}/media`, {
    fields: 'id,caption,timestamp,permalink,comments_count,media_type', limit: n,
  })).data || [];
  console.log(`Cuenta: @${yo.username} · últimos ${posteos.length} posteos\n`);
  for (const p of posteos) {
    console.log('━'.repeat(70));
    console.log(`${p.timestamp.slice(0, 10)} · ${p.media_type} · ${p.comments_count} comentarios · ${p.permalink}`);
    console.log(`«${corto(p.caption, 140)}»`);
    if (!p.comments_count) continue;
    const comentarios = await todos(`/${p.id}/comments`, { fields: 'id,text,username,timestamp,like_count,replies{username,text}', limit: 50 });
    for (const c of comentarios) {
      const respuestas = (c.replies && c.replies.data) || [];
      const nuestra = respuestas.some(r => r.username === yo.username);
      console.log(`  [${c.id}] @${c.username} (${c.timestamp.slice(0, 16).replace('T', ' ')} UTC, ${c.like_count || 0}♥)${nuestra ? ' ✔ respondido' : ''}`);
      console.log(`      ${corto(c.text, 300)}`);
      for (const r of respuestas) console.log(`      ↳ @${r.username}: ${corto(r.text, 200)}`);
    }
  }
}

async function responder(id, texto) {
  if (!id || !texto) throw new Error('falta el id del comentario o el texto');
  const r = await graphIG(`/${id}/replies`, { message: texto }, 'POST');
  console.log(`Respondido (${r.id}): ${texto}`);
}

(async () => {
  if (!process.env.IG_USER_ID || !process.env.IG_ACCESS_TOKEN) throw new Error('faltan IG_USER_ID / IG_ACCESS_TOKEN');
  const [modo, a, b] = process.argv.slice(2);
  if (modo === 'responder') await responder(process.env.COMENTARIO_ID || a, process.env.TEXTO || b);
  else await listar(Number(a) || 10);
})().catch(e => { console.error('Error: ' + e.message); process.exit(1); });
