/**
 * youtube.js — lo compartido para subir videos al canal de YouTube de Winning
 * (YouTube Data API v3). Lo usan publicar-youtube.js y youtube-conectar.js.
 *
 *   tituloYDescripcion(caption, titulo)   arma el título (100 caracteres) y la descripción
 *   subirYouTube(video, opciones)         sube un MP4 (Buffer) y confirma cómo quedó.
 *                                         Vertical y de hasta 3 minutos, YouTube lo toma
 *                                         como Short solo: no hay un pedido aparte.
 *
 * Claves, siempre en el ambiente: YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET,
 * YOUTUBE_REFRESH_TOKEN. El repo es público: nunca imprimir un token.
 */

const API = 'https://www.googleapis.com/youtube/v3';
const SUBIDA = 'https://www.googleapis.com/upload/youtube/v3/videos';
const TOKEN = 'https://oauth2.googleapis.com/token';
const SCOPES = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly';
const CATEGORIA_DEPORTES = '17';

const log = m => console.log('[youtube] ' + m);
const dormir = ms => new Promise(r => setTimeout(r, ms));

// En Actions, todo token que pase por acá queda tapado en el log.
const tapar = t => { if (t && process.env.GITHUB_ACTIONS) console.log('::add-mask::' + t); return t; };

async function oauth(params) {
  const { YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET } = process.env;
  if (!YOUTUBE_CLIENT_ID || !YOUTUBE_CLIENT_SECRET) throw new Error('faltan las claves de la app de Google en el ambiente (YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET)');
  const r = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: YOUTUBE_CLIENT_ID, client_secret: YOUTUBE_CLIENT_SECRET, ...params }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) {
    if (d.error === 'invalid_grant') throw new Error('Google no acepta el token largo: volver a conectar el canal (youtube-conectar.js). Si pasó a los 7 días, la app de Google quedó en "Testing" y hay que pasarla a "In production"');
    throw new Error('Google no dio el token (' + r.status + '): ' + (d.error_description || d.error || JSON.stringify(d).slice(0, 200)));
  }
  tapar(d.access_token); tapar(d.refresh_token);
  return d;
}

/* Con el código que devuelve el login → { access_token, refresh_token, scope } */
const tokensDesdeCodigo = (codigo, redirect) => oauth({ code: codigo, grant_type: 'authorization_code', redirect_uri: redirect });

async function tokenNuevo() {
  const rt = process.env.YOUTUBE_REFRESH_TOKEN;
  if (!rt) throw new Error('falta YOUTUBE_REFRESH_TOKEN: el canal de YouTube todavía no está conectado (tools/youtube-conectar.js)');
  return (await oauth({ grant_type: 'refresh_token', refresh_token: rt })).access_token;
}

// Los errores que se esperan, en castellano.
function explicar(status, d) {
  const e = d.error || {};
  const motivo = (e.errors && e.errors[0] && e.errors[0].reason) || e.status || '';
  const ya = {
    quotaExceeded: 'se terminó el cupo diario de la API de YouTube: probar mañana',
    uploadLimitExceeded: 'el canal llegó a su límite de subidas: probar mañana',
    youtubeSignupRequired: 'la cuenta conectada no tiene canal de YouTube: reconectar eligiendo el canal de Winning',
    insufficientPermissions: 'el canal se conectó sin permiso para subir: volver a conectarlo aceptando todo',
    invalidTitle: 'YouTube no acepta el título (no puede estar vacío ni llevar < o >)',
    invalidDescription: 'YouTube no acepta la descripción',
  }[motivo];
  return ya ? `${ya} [${motivo}]` : `YouTube respondió ${status} ${motivo}: ${(e.message || JSON.stringify(d)).slice(0, 300)}`;
}

async function api(token, ruta) {
  const r = await fetch(API + ruta, { headers: { Authorization: 'Bearer ' + token } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(explicar(r.status, d));
  return d;
}

/* El canal al que entra el token: sirve para confirmar que se conectó el correcto. */
async function canalPropio(token) {
  const d = await api(token, '/channels?part=snippet&mine=true');
  const c = (d.items || [])[0];
  return c ? { id: c.id, nombre: c.snippet.title, handle: c.snippet.customUrl || '' } : null;
}

/* YouTube pide título (máx. 100, sin < ni >). Se usa titulo si viene (titulo.txt);
   si no, la primera línea del caption, y el resto queda como descripción (máx. 5000). */
function tituloYDescripcion(caption, titulo) {
  const limpiar = s => (s || '').replace(/\r/g, '').replace(/[<>]/g, '').trim();
  const lineas = limpiar(caption).split('\n');
  let t = limpiar(titulo);
  let desc = lineas.join('\n').trim();
  if (!t) { t = lineas[0].trim(); desc = lineas.slice(1).join('\n').trim(); }
  t = t.replace(/\s+/g, ' ');
  if (!t) throw new Error('hace falta título: ni titulo.txt ni la primera línea de caption.txt tienen texto');
  if (t.length > 100) t = t.slice(0, 100).replace(/\s+\S*$/, '').replace(/[\s,;:.-]+$/, '');
  if (desc.length > 5000) throw new Error(`la descripción tiene ${desc.length} caracteres y YouTube permite 5000`);
  return { titulo: t, descripcion: desc };
}

/* Espera a que YouTube termine de tomar el video y devuelve su estado real. */
async function confirmar(token, id) {
  let v = null;
  for (let i = 0; i < 24; i++) {   // hasta 2 minutos
    const d = await api(token, `/videos?part=status&id=${encodeURIComponent(id)}`);
    v = (d.items || [])[0] || v;
    const s = v && v.status;
    if (s && ['failed', 'rejected', 'deleted'].includes(s.uploadStatus)) {
      throw new Error(`YouTube no aceptó el video (${s.uploadStatus}): ${s.failureReason || s.rejectionReason || 'sin motivo'}`);
    }
    if (s && s.uploadStatus === 'processed') break;
    await dormir(5000);
  }
  return v && v.status;
}

/* video: Buffer del MP4. privacidad: 'private', 'unlisted' o 'public'. */
async function subirYouTube(video, { titulo, descripcion = '', privacidad = 'private' } = {}) {
  if (!['private', 'unlisted', 'public'].includes(privacidad)) throw new Error('privacidad tiene que ser private, unlisted o public');
  const token = await tokenNuevo();
  const cuerpo = JSON.stringify({
    snippet: { title: titulo, description: descripcion, categoryId: CATEGORIA_DEPORTES, defaultLanguage: 'es-419', defaultAudioLanguage: 'es-419' },
    status: { privacyStatus: privacidad, selfDeclaredMadeForKids: false, embeddable: true },
  });
  const ini = await fetch(`${SUBIDA}?uploadType=resumable&part=snippet,status`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'video/mp4',
      'X-Upload-Content-Length': String(video.length),
    },
    body: cuerpo,
  });
  if (!ini.ok) throw new Error(explicar(ini.status, await ini.json().catch(() => ({}))));
  const url = ini.headers.get('location');
  if (!url) throw new Error('YouTube no devolvió la dirección de subida');

  log(`subiendo ${Math.round(video.length / 1048576)} MB`);
  const r = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(video.length) },
    body: video,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.id) throw new Error(explicar(r.status, d));

  // Se lee cómo quedó de verdad: Google puede dejar privado lo que se pidió público.
  const s = await confirmar(token, d.id);
  const quedo = (s && s.privacyStatus) || (d.status && d.status.privacyStatus) || '?';
  const link = 'https://www.youtube.com/shorts/' + d.id;
  if (quedo !== privacidad) throw new Error(`se subió pero quedó "${quedo}" y se pidió "${privacidad}": ${link}`);
  return { id: d.id, link, privacidad: quedo, estado: s && s.uploadStatus };
}

function linkLogin(state, redirect) {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search = new URLSearchParams({
    client_id: process.env.YOUTUBE_CLIENT_ID || '',
    redirect_uri: redirect,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',   // sin esto, Google no vuelve a dar el token largo
    state,
  }).toString();
  return u.toString();
}

module.exports = { subirYouTube, tituloYDescripcion, tokenNuevo, tokensDesdeCodigo, canalPropio, linkLogin };
