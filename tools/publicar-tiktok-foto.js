#!/usr/bin/env node
/**
 * publicar-tiktok-foto.js — sube a TikTok en MODO FOTO las placas de una carpeta de carruseles/ (la misma de Instagram).
 *
 *   node publicar-tiktok-foto.js <carpeta> [--probar] [--directo] [--privado]
 *
 *   carpeta   nombre dentro de carruseles/ en el S3 del sitio: NN.jpg (en orden) y caption.txt
 *   --probar  muestra las fotos y el texto, no sube nada
 *   (sin flags) borrador: llega a la bandeja de la app de TikTok con el texto cargado y se publica desde ahí
 *   --directo / --privado  como en publicar-tiktok.js
 *
 * Claves en el ambiente: TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_REFRESH_TOKEN.
 */
const { spawnSync } = require('child_process');
const { subirFotosTikTok } = require('./tiktok.js');
const BUCKET = process.env.BUCKET || 's3://winning-com-ar/iloveneuquen';
const WEB = 'https://winning.com.ar/iloveneuquen';
const log = m => console.log('[publicar-tiktok-foto] ' + m);
function aws(args) {
  const r = spawnSync('aws', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('aws ' + args.slice(0, 2).join(' ') + ' falló: ' + (r.stderr || '').trim().slice(0, 200));
  return r.stdout;
}
(async () => {
  const a = process.argv.slice(2);
  const carpeta = a[0] && !a[0].startsWith('--') ? a[0] : null;
  const probar = a.includes('--probar'), directo = a.includes('--directo'), privado = a.includes('--privado');
  if (!carpeta || !/^[a-z0-9-]+$/.test(carpeta)) { console.error('uso: node publicar-tiktok-foto.js <carpeta> [--probar] [--directo] [--privado]'); process.exit(2); }
  try {
    const lista = aws(['s3', 'ls', `${BUCKET}/carruseles/${carpeta}/`]).split('
').map(l => l.trim().split(/s+/).pop()).filter(n => /.jpe?g$/i.test(n)).sort();
    if (!lista.length) throw new Error('no hay JPG en carruseles/' + carpeta);
    const urls = lista.map(n => `${WEB}/carruseles/${carpeta}/${n}`);
    const caption = aws(['s3', 'cp', `${BUCKET}/carruseles/${carpeta}/caption.txt`, '-']).trim();
    const titulo = caption.split('
')[0].trim();
    log('fotos: ' + urls.join(' '));
    log('título: ' + titulo);
    log(`texto (${caption.length} caracteres):
${caption}`);
    if (probar) { log('modo prueba: no se sube'); return; }
    const r = await subirFotosTikTok(urls, { modo: directo ? 'directo' : 'borrador', titulo, caption, privado });
    log(directo ? 'publicado: ' + r.status : 'listo: está en la bandeja de la app de TikTok (' + r.status + ')');
  } catch (e) { console.error('[publicar-tiktok-foto] ERROR: ' + e.message); process.exit(1); }
})();
