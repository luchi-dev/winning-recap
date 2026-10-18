#!/usr/bin/env node
/**
 * publicar-tiktok.js — sube a TikTok un video ya armado, el mismo que va como reel.
 *
 *   node publicar-tiktok.js <carpeta> [--probar] [--directo] [--privado]
 *
 *   carpeta     nombre dentro de reels/ en el S3 del sitio (la misma carpeta del
 *               reel de Instagram): un solo .mp4 vertical y caption.txt
 *   --probar    revisa el video y el caption y los muestra, pero no sube nada
 *   (sin flags) borrador: llega a la bandeja de la app de TikTok de Winning y se
 *               publica desde ahí, con la música y el texto que se quiera
 *   --directo   se publica solo, con caption.txt como texto (en público recién
 *               cuando TikTok apruebe la app; antes, solo con --privado)
 *   --privado   con --directo: sale en "Solo yo"
 *
 * Claves en el ambiente: TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET, TIKTOK_REFRESH_TOKEN.
 */

const { spawnSync } = require('child_process');
const redes = require('./redes.js');
const { subirTikTok } = require('./tiktok.js');

const BUCKET = process.env.BUCKET || 's3://winning-com-ar/iloveneuquen';
const log = m => console.log('[publicar-tiktok] ' + m);

function aws(args) {
  const r = spawnSync('aws', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('aws ' + args.slice(0, 2).join(' ') + ' falló: ' + (r.stderr || '').trim().slice(0, 200));
  return r.stdout;
}

(async () => {
  const a = process.argv.slice(2);
  const carpeta = a[0] && !a[0].startsWith('--') ? a[0] : null;
  const probar = a.includes('--probar'), directo = a.includes('--directo'), privado = a.includes('--privado');
  if (!carpeta || !/^[a-z0-9-]+$/.test(carpeta)) {
    console.error('uso: node publicar-tiktok.js <carpeta> [--probar] [--directo] [--privado]   (carpeta: minúsculas, números y guiones)');
    process.exit(2);
  }
  try {
    const base = `${BUCKET}/reels/${carpeta}/`;
    const videos = aws(['s3', 'ls', base]).split('\n').map(l => l.trim().split(/\s+/).pop()).filter(n => /\.mp4$/i.test(n || ''));
    if (videos.length !== 1) throw new Error(`en reels/${carpeta}/ hay ${videos.length} videos .mp4 y tiene que haber uno solo`);
    let caption = '';
    try { caption = aws(['s3', 'cp', base + 'caption.txt', '-']).replace(/\r/g, '').trim(); } catch (e) { if (directo) throw e; }
    if (directo && !caption) throw new Error('caption.txt está vacío');
    // El sitio responde 200 con la home si el archivo no existe: se comprueba que la dirección devuelva un video.
    const url = `${redes.SITIO}/reels/${carpeta}/${videos[0]}`;
    const r = await fetch(url);
    if (!r.ok || !/video\/mp4/.test(r.headers.get('content-type') || '')) throw new Error('no es un MP4 público: ' + url);
    const video = Buffer.from(await r.arrayBuffer());
    log(`video: ${url} (${Math.round(video.length / 1048576)} MB)`);
    if (caption) log(`caption (${caption.length} caracteres):\n${caption}\n`);
    log(directo ? `directo: se publica solo${privado ? ', en "Solo yo"' : ', en público'}` : 'borrador: va a la bandeja de la app de TikTok (el caption se pega a mano)');
    if (probar) { log('modo prueba: no se sube'); return; }
    log(await subirTikTok(video, { modo: directo ? 'directo' : 'borrador', caption, privado }));
  } catch (e) {
    console.error('[publicar-tiktok] ' + (e.message || e));
    process.exit(1);
  }
})();
