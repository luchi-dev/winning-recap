/**
 * tiktok.js — lo compartido para subir videos a la cuenta de TikTok de Winning
 * (Content Posting API). Lo usan publicar-tiktok.js y tiktok-conectar.js.
 *
 *   tokenNuevo()                    pide un token de acceso (dura 24 h) con el
 *                                   TIKTOK_REFRESH_TOKEN (dura 365 días)
 *   subirTikTok(video, opciones)    sube un MP4 (Buffer):
 *                                     modo 'borrador' → llega a la bandeja de la app
 *                                       de TikTok y se publica desde ahí (música, texto)
 *                                     modo 'directo'  → se publica solo con el caption;
 *                                       en público recién cuando TikTok apruebe la app
 *
 * Claves, siempre en el ambiente: TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET,
 * TIKTOK_REFRESH_TOKEN. El repo es público: nunca imprimir un token.
 */

const API = 'https://open.tiktokapis.com/v2';
const REDIRECT = 'https://winning.com.ar/iloveneuquen/tiktok.html';
const SCOPES = 'user.info.basic,video.upload,video.publish';

const log = m => console.log('[tiktok] ' + m);
const dormir = ms => new Promise(r => setTimeout(r, ms));

// En Actions, todo token que pase por acá queda tapado en el log.
const tapar = t => { if (t && process.env.GITHUB_ACTIONS) console.log('::add-mask::' + t); return t; };

async function oauth(params) {
  const { TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET } = process.env;
  if (!TIKTOK_CLIENT_KEY || !TIKTOK_CLIENT_SECRET) throw new Error('faltan las claves de la app de TikTok en el ambiente (TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET)');
  const r = await fetch(API + '/oauth/token/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_key: TIKTOK_CLIENT_KEY, client_secret: TIKTOK_CLIENT_SECRET, ...params }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error || !d.access_token) throw new Error('TikTok no dio el token (' + r.status + '): ' + (d.error_description || d.error || JSON.stringify(d).slice(0, 200)));
  tapar(d.access_token); tapar(d.refresh_token);
  return d;
}

/* Con el código que devuelve el login (tiktok.html) → { access_token, refresh_token, refresh_expires_in, open_id } */
const tokensDesdeCodigo = codigo => oauth({ code: codigo, grant_type: 'authorization_code', redirect_uri: REDIRECT });

async function tokenNuevo() {
  const rt = process.env.TIKTOK_REFRESH_TOKEN;
  if (!rt) throw new Error('falta TIKTOK_REFRESH_TOKEN: la cuenta de TikTok todavía no está conectada (tools/tiktok-conectar.js)');
  const d = await oauth({ grant_type: 'refresh_token', refresh_token: rt });
  const dias = Math.floor((d.refresh_expires_in || 0) / 86400);
  if (d.refresh_token && d.refresh_token !== rt) log(`::warning::TikTok cambió el token largo: hay que volver a conectar la cuenta (tiktok-conectar.js) antes de ${dias} días`);
  else if (dias && dias < 30) log(`::warning::la conexión con TikTok vence en ${dias} días: volver a conectar la cuenta (tiktok-conectar.js)`);
  return d.access_token;
}

async function api(token, ruta, cuerpo) {
  const r = await fetch(API + ruta, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(cuerpo || {}),
  });
  const d = await r.json().catch(() => ({}));
  const e = d.error || {};
  if (!r.ok || (e.code && e.code !== 'ok')) throw new Error(explicar(e.code, e.message || r.status));
  return d.data || {};
}

// Los errores que se esperan, en castellano.
function explicar(codigo, mensaje) {
  const ya = {
    unaudited_client_can_only_post_to_private_accounts: 'TikTok todavía no aprobó la app: en modo directo solo puede publicar en privado (usar modo borrador, o directo con --privado)',
    spam_risk_too_many_posts: 'TikTok frenó la subida: demasiados posteos hoy desde la API',
    spam_risk_user_banned_from_posting: 'TikTok no deja publicar desde esta cuenta por ahora',
    access_token_invalid: 'el token de TikTok no sirve: volver a conectar la cuenta (tiktok-conectar.js)',
    scope_not_authorized: 'la cuenta se conectó sin permiso para subir videos: volver a conectarla aceptando todo',
    url_ownership_unverified: 'TikTok no reconoce el dominio del video',
  }[codigo];
  return ya ? `${ya} [${codigo}]` : `TikTok respondió ${codigo || 'error'}: ${mensaje}`;
}

/* Partes para FILE_UPLOAD: hasta 64 MB va en una sola; si no, de 10 MB y la última se lleva el resto. */
function partes(tam) {
  const MB = 1048576;
  if (tam <= 64 * MB) return { chunk: tam, total: 1 };
  const chunk = 10 * MB;
  return { chunk, total: Math.floor(tam / chunk) };
}

async function subirArchivo(url, video, { chunk, total }) {
  for (let i = 0; i < total; i++) {
    const desde = i * chunk, hasta = i === total - 1 ? video.length : desde + chunk;
    const r = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(hasta - desde), 'Content-Range': `bytes ${desde}-${hasta - 1}/${video.length}` },
      body: video.subarray(desde, hasta),
    });
    if (!r.ok) throw new Error(`TikTok no aceptó la parte ${i + 1}/${total} del video (${r.status}): ${(await r.text()).slice(0, 200)}`);
  }
}

async function esperar(token, publishId, modo) {
  for (let i = 0; i < 60; i++) {   // hasta 5 minutos
    const s = await api(token, '/post/publish/status/fetch/', { publish_id: publishId });
    if (s.status === 'FAILED') throw new Error('TikTok no pudo procesar el video: ' + (s.fail_reason || 'sin motivo'));
    if (modo === 'borrador' && s.status === 'SEND_TO_USER_INBOX') return s;
    if (s.status === 'PUBLISH_COMPLETE') return s;
    await dormir(5000);
  }
  throw new Error('TikTok sigue procesando el video después de 5 minutos (publish_id ' + publishId + ')');
}

/* video: Buffer del MP4. caption: solo se usa en modo directo (en borrador TikTok no lo acepta: se pega en la app).
   privado: en directo, publica en "Solo yo" (lo único que permite TikTok antes de aprobar la app). */
async function subirTikTok(video, { modo = 'borrador', caption = '', privado = false } = {}) {
  if (!['borrador', 'directo'].includes(modo)) throw new Error('modo tiene que ser borrador o directo');
  if (caption.length > 2200) throw new Error(`el caption tiene ${caption.length} caracteres y TikTok permite 2200`);
  const token = await tokenNuevo();
  const p = partes(video.length);
  const source_info = { source: 'FILE_UPLOAD', video_size: video.length, chunk_size: p.chunk, total_chunk_count: p.total };
  let init;
  if (modo === 'borrador') {
    init = await api(token, '/post/publish/inbox/video/init/', { source_info });
  } else {
    // TikTok pide consultar antes qué permite la cuenta (privacidad, duración máxima).
    const c = await api(token, '/post/publish/creator_info/query/');
    const nivel = privado ? 'SELF_ONLY' : 'PUBLIC_TO_EVERYONE';
    if (!(c.privacy_level_options || []).includes(nivel)) throw new Error(`la cuenta @${c.creator_username} no permite publicar como ${nivel} (permite: ${(c.privacy_level_options || []).join(', ')})`);
    log(`cuenta: @${c.creator_username} · privacidad: ${nivel}`);
    init = await api(token, '/post/publish/video/init/', {
      post_info: { title: caption, privacy_level: nivel, disable_comment: false, disable_duet: false, disable_stitch: false, video_cover_timestamp_ms: 1500 },
      source_info,
    });
  }
  log(`subiendo ${Math.round(video.length / 1048576)} MB en ${p.total} parte(s)`);
  await subirArchivo(init.upload_url, video, p);
  const s = await esperar(token, init.publish_id, modo);
  return modo === 'borrador'
    ? 'en la bandeja de TikTok: abrir la notificación en la app para terminarlo y publicarlo'
    : 'publicado en TikTok' + (s.publicaly_available_post_id && s.publicaly_available_post_id[0] ? ' (id ' + s.publicaly_available_post_id[0] + ')' : '');
}

function linkLogin(state) {
  const u = new URL('https://www.tiktok.com/v2/auth/authorize/');
  u.search = new URLSearchParams({ client_key: process.env.TIKTOK_CLIENT_KEY || '', scope: SCOPES, response_type: 'code', redirect_uri: REDIRECT, state }).toString();
  return u.toString();
}

module.exports = { subirTikTok, tokenNuevo, tokensDesdeCodigo, linkLogin, REDIRECT };
