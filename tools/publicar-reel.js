#!/usr/bin/env node
/**
 * publicar-reel.js — publica en Instagram un reel ya armado (un video vertical
 * que no sale del Recap), común o como reel de prueba.
 *
 *   node publicar-reel.js <carpeta> [--probar] [--prueba manual|auto]
 *
 *   carpeta     nombre dentro de reels/ en el S3 del sitio. Adentro van un solo
 *               .mp4 (H.264 + AAC, vertical) y caption.txt con el texto; si hay
 *               portada.jpg, va como tapa (si no, el cuadro del segundo 1,5).
 *   --probar    revisa el video y el caption y los muestra, pero no publica
 *   --prueba    lo publica como reel de prueba (solo lo ven no seguidores):
 *               manual = se pasa a los seguidores a mano desde la app de Instagram
 *               auto   = Instagram lo pasa solo si rinde bien
 *               Sin --prueba sale como un reel común, a todos los seguidores.
 *
 * Claves en el ambiente: IG_USER_ID, IG_ACCESS_TOKEN. Lo compartido está en redes.js.
 */

const { spawnSync } = require('child_process');
const redes = require('./redes.js');

const BUCKET = process.env.BUCKET || 's3://winning-com-ar/iloveneuquen';
const log = m => console.log('[publicar-reel] ' + m);

function aws(args) {
  const r = spawnSync('aws', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('aws ' + args.slice(0, 2).join(' ') + ' falló: ' + (r.stderr || '').trim().slice(0, 200));
  return r.stdout;
}

(async () => {
  const a = process.argv.slice(2);
  const carpeta = a[0] && !a[0].startsWith('--') ? a[0] : null;
  const probar = a.includes('--probar');
  const modo = a.includes('--prueba') ? a[a.indexOf('--prueba') + 1] : null;
  const ESTRATEGIA = { manual: 'MANUAL', auto: 'SS_PERFORMANCE' };
  if (!carpeta || !/^[a-z0-9-]+$/.test(carpeta) || (modo !== null && !ESTRATEGIA[modo])) {
    console.error('uso: node publicar-reel.js <carpeta> [--probar] [--prueba manual|auto]   (carpeta: minúsculas, números y guiones)');
    process.exit(2);
  }
  try {
    const base = `${BUCKET}/reels/${carpeta}/`;
    const videos = aws(['s3', 'ls', base]).split('\n').map(l => l.trim().split(/\s+/).pop()).filter(n => /\.mp4$/i.test(n || ''));
    if (videos.length !== 1) throw new Error(`en reels/${carpeta}/ hay ${videos.length} videos .mp4 y tiene que haber uno solo`);
    const caption = aws(['s3', 'cp', base + 'caption.txt', '-']).replace(/\r/g, '').trim();
    if (!caption) throw new Error('caption.txt está vacío');
    if (caption.length > 2200) throw new Error(`el caption tiene ${caption.length} caracteres e Instagram permite 2200`);
    // El sitio responde 200 con la home si el archivo no existe: se comprueba que la dirección devuelva un video.
    const url = `${redes.SITIO}/reels/${carpeta}/${videos[0]}`;
    const r = await fetch(url, { method: 'HEAD' });
    if (!r.ok || !/video\/mp4/.test(r.headers.get('content-type') || '')) throw new Error('no es un MP4 público: ' + url);
    log(`video: ${url} (${Math.round((+r.headers.get('content-length') || 0) / 1048576)} MB)`);
    log(`caption (${caption.length} caracteres):\n${caption}\n`);
    log(modo ? `reel de prueba (${modo}): lo ven solo no seguidores` : 'reel común: lo ven todos los seguidores');
    if (probar) { log('modo prueba: no se publica'); return; }
    // portada.jpg en la misma carpeta (opcional): va como tapa del reel
    const tapa = `${redes.SITIO}/reels/${carpeta}/portada.jpg`, rt = await fetch(tapa, { method: 'HEAD' });
    const portada = rt.ok && /image\/jpeg/.test(rt.headers.get('content-type') || '') ? tapa : null;
    log(portada ? 'portada: ' + portada : 'portada: el cuadro del segundo 1,5');
    log('publicado en Instagram: ' + await redes.publicarReel(caption, url, modo ? ESTRATEGIA[modo] : null, portada));
  } catch (e) {
    console.error('[publicar-reel] ' + (e.message || e));
    process.exit(1);
  }
})();
