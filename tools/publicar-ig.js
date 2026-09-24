#!/usr/bin/env node
/**
 * publicar-ig.js — publica en Instagram (y en la página de Facebook, si están
 * sus claves) una placa del Recap con su caption.
 *
 *   node publicar-ig.js <fecha> <placa> [opcion] [--corta] [--texto "..."] [--probar] [--sin-facebook]
 *
 *   placa    ideal | ganadores (igual que publicar-x.js)
 *   opcion   1..4 para el 11 Ideal, A/B para ganadores (por defecto el primero)
 *   --corta  usa la versión corta del caption (texto_corto) en vez de la completa
 *   --texto  caption propio (o la variable IG_TEXTO), en vez del de captions.json
 *   --probar arma y sube la imagen, muestra el caption, pero no publica
 *   --sin-facebook  no publica en Facebook aunque estén las claves
 *
 * Instagram baja la imagen de una dirección pública: se sube al S3 del sitio
 * (captions/ig-<placa>-fecha<N>-<hora>.jpg). Lo compartido está en redes.js.
 * Claves en el ambiente: IG_USER_ID, IG_ACCESS_TOKEN (vence a los 60 días:
 * lo renueva renovar-ig-token.yml) y, opcionales, FB_PAGE_ID y FB_PAGE_TOKEN.
 */

const fs = require('fs');
const redes = require('./redes.js');
const { imagenDe, opcionDe } = require('./publicar-x.js');

const log = m => console.log('[publicar-ig] ' + m);

function argumentos() {
  const a = process.argv.slice(2);
  const i = a.indexOf('--texto');
  return {
    md: Number(a[0]), placa: a[1], opcion: a[2] && !a[2].startsWith('--') ? a[2] : null,
    corta: a.includes('--corta'), texto: i >= 0 ? a[i + 1] : (process.env.IG_TEXTO || null),
    probar: a.includes('--probar'), sinFacebook: a.includes('--sin-facebook'),
  };
}

function captionDe(md, placa, opcion, corta) {
  const c = opcionDe(md, placa, opcion);
  return ((corta && c.texto_corto) || c.texto || '').trim();
}

(async () => {
  const { md, placa, opcion, corta, texto, probar, sinFacebook } = argumentos();
  if (!md || !['ideal', 'ganadores'].includes(placa)) {
    console.error('uso: node publicar-ig.js <fecha> <ideal|ganadores> [opcion] [--corta] [--texto "..."] [--probar] [--sin-facebook]');
    process.exit(2);
  }
  try {
    const caption = (texto || captionDe(md, placa, opcion, corta)).trim();
    if (caption.length > 2200) throw new Error(`el caption tiene ${caption.length} caracteres e Instagram permite 2200`);
    log(`caption (${caption.length} caracteres):\n${caption}\n`);
    log('armando la imagen desde la página publicada...');
    const jpg = await imagenDe(md, placa);
    const { url, local } = redes.subirS3(jpg, `ig-${placa}-fecha${md}-${Date.now()}.jpg`);
    log(`imagen subida: ${url} (${Math.round(jpg.length / 1024)} KB)`);
    if (probar) { log('modo prueba: no se publica'); return; }
    log('publicado en Instagram: ' + await redes.publicarInstagram(caption, [url]));
    // Facebook va después: si falla, Instagram ya salió y no se repite.
    if (sinFacebook) log('Facebook: salteado (--sin-facebook)');
    else if (!process.env.FB_PAGE_ID || !process.env.FB_PAGE_TOKEN) log('Facebook: sin FB_PAGE_ID / FB_PAGE_TOKEN, no se publica ahí');
    else {
      try { log('publicado en Facebook: ' + await redes.publicarFacebook(caption, [url])); }
      catch (e) { console.log('::warning::Facebook falló: ' + e.message); log('Facebook falló: ' + e.message); }
    }
    fs.unlinkSync(local);
  } catch (e) {
    console.error('[publicar-ig] ' + (e.message || e));
    process.exit(1);
  }
})();
