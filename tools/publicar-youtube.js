#!/usr/bin/env node
/**
 * publicar-youtube.js — sube a YouTube un video ya armado, el mismo que va como reel.
 * Si es vertical y dura hasta 3 minutos, YouTube lo toma como Short.
 *
 *   node publicar-youtube.js <carpeta> [--probar] [--publico | --oculto]
 *
 *   carpeta     nombre dentro de reels/ en el S3 del sitio (la misma carpeta del
 *               reel de Instagram): un solo .mp4, caption.txt y, si se quiere un
 *               título distinto a la primera línea del caption, titulo.txt
 *   --probar    revisa el video, el título y la descripción, pero no sube nada
 *   (sin flags) sube en privado
 *   --oculto    sube como "no listado": solo lo ve quien tiene el link
 *   --publico   sube en público
 *   --miniatura <id>  no sube video: pone reels/<carpeta>/portada.jpg en el video <id>
 *
 * Claves en el ambiente: YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN.
 */

const { spawnSync } = require('child_process');
const redes = require('./redes.js');
const { subirYouTube, ponerMiniatura, tituloYDescripcion } = require('./youtube.js');

const BUCKET = process.env.BUCKET || 's3://winning-com-ar/iloveneuquen';
const log = m => console.log('[publicar-youtube] ' + m);

function aws(args) {
  const r = spawnSync('aws', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('aws ' + args.slice(0, 2).join(' ') + ' falló: ' + (r.stderr || '').trim().slice(0, 200));
  return r.stdout;
}

// Un archivo de texto de la carpeta, o vacío si no está.
function texto(ruta) {
  try { return aws(['s3', 'cp', ruta, '-']).replace(/\r/g, '').trim(); } catch { return ''; }
}

(async () => {
  const a = process.argv.slice(2);
  const carpeta = a[0] && !a[0].startsWith('--') ? a[0] : null;
  const probar = a.includes('--probar'), publico = a.includes('--publico'), oculto = a.includes('--oculto');
  if (!carpeta || !/^[a-z0-9-]+$/.test(carpeta) || (publico && oculto)) {
    console.error('uso: node publicar-youtube.js <carpeta> [--probar] [--publico | --oculto]   (carpeta: minúsculas, números y guiones)');
    process.exit(2);
  }
  try {
    const iMini = a.indexOf('--miniatura');
    if (iMini >= 0) {
      const url = `${redes.SITIO}/reels/${carpeta}/portada.jpg`;
      const r = await fetch(url);
      if (!r.ok || !/image\/jpeg/.test(r.headers.get('content-type') || '')) throw new Error('falta la portada: ' + url);
      await ponerMiniatura(a[iMini + 1], Buffer.from(await r.arrayBuffer()));
      log(`miniatura puesta en ${a[iMini + 1]}`);
      return;
    }
    const base = `${BUCKET}/reels/${carpeta}/`;
    const videos = aws(['s3', 'ls', base]).split('\n').map(l => l.trim().split(/\s+/).pop()).filter(n => /\.mp4$/i.test(n || ''));
    if (videos.length !== 1) throw new Error(`en reels/${carpeta}/ hay ${videos.length} videos .mp4 y tiene que haber uno solo`);
    const { titulo, descripcion } = tituloYDescripcion(texto(base + 'caption.txt'), texto(base + 'titulo.txt'));
    // El sitio responde 200 con la home si el archivo no existe: se comprueba que la dirección devuelva un video.
    const url = `${redes.SITIO}/reels/${carpeta}/${videos[0]}`;
    const r = await fetch(url);
    if (!r.ok || !/video\/mp4/.test(r.headers.get('content-type') || '')) throw new Error('no es un MP4 público: ' + url);
    const video = Buffer.from(await r.arrayBuffer());
    const privacidad = publico ? 'public' : oculto ? 'unlisted' : 'private';
    log(`video: ${url} (${Math.round(video.length / 1048576)} MB)`);
    log(`título (${titulo.length} caracteres): ${titulo}`);
    log(`descripción (${descripcion.length} caracteres):\n${descripcion}\n`);
    log(`privacidad: ${privacidad}`);
    if (probar) { log('modo prueba: no se sube'); return; }
    const v = await subirYouTube(video, { titulo, descripcion, privacidad });
    log(`subido: ${v.link} · quedó ${v.privacidad} · estado ${v.estado}`);
  } catch (e) {
    console.error('[publicar-youtube] ' + (e.message || e));
    process.exit(1);
  }
})();
