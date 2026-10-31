#!/usr/bin/env node
/**
 * publicar-youtube-tanda.js — sube a YouTube los videos de tools/youtube-tanda.json,
 * cada uno con su horario. El primero sale público en el momento, y si no queda
 * público se frena todo. Los demás quedan programados: los publica YouTube solo,
 * así que no hace falta dejar nada corriendo.
 *
 *   node publicar-youtube-tanda.js [--probar] [--inicio <fecha ISO>]
 *
 *   --probar    revisa cada video y muestra títulos y horarios, pero no sube nada
 *   --inicio    hora del primero. Si la tanda se cortó, repetirla con la misma hora
 *               (la imprime al arrancar): sigue donde quedó y mantiene los horarios.
 *
 * Lo ya subido queda anotado en reels/<carpeta>/youtube.txt en el S3, para no repetirlo.
 * Claves en el ambiente: YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const redes = require('./redes.js');
const { subirYouTube, tituloYDescripcion } = require('./youtube.js');

const BUCKET = process.env.BUCKET || 's3://winning-com-ar/iloveneuquen';
const MARGEN_MS = 15 * 60 * 1000;   // YouTube pide que publishAt esté en el futuro; se deja un margen
const log = m => console.log('[youtube-tanda] ' + m);
const hora = d => d.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', dateStyle: 'short', timeStyle: 'short' });

function aws(args, input) {
  const r = spawnSync('aws', args, { encoding: 'utf8', input });
  if (r.status !== 0) throw new Error('aws ' + args.slice(0, 2).join(' ') + ' falló: ' + (r.stderr || '').trim().slice(0, 200));
  return r.stdout;
}

function leer(ruta) {
  try { return aws(['s3', 'cp', ruta, '-']).replace(/\r/g, '').trim(); } catch { return ''; }
}

(async () => {
  const a = process.argv.slice(2);
  const probar = a.includes('--probar');
  const iInicio = a.indexOf('--inicio');
  const inicio = iInicio >= 0 ? new Date(a[iInicio + 1]) : new Date();
  if (isNaN(inicio)) { console.error('uso: node publicar-youtube-tanda.js [--probar] [--inicio <fecha ISO>]'); process.exit(2); }
  try {
    const { horas, videos } = JSON.parse(fs.readFileSync(path.join(__dirname, 'youtube-tanda.json'), 'utf8'));
    log(`inicio ${inicio.toISOString()} · ${videos.length} videos · uno cada ${horas} horas`);
    for (const [i, v] of videos.entries()) {
      const base = `${BUCKET}/reels/${v.carpeta}/`;
      const cuando = new Date(inicio.getTime() + i * horas * 3600000);
      const ya = leer(base + 'youtube.txt');
      if (ya) { log(`${i + 1}. ${v.carpeta}: ya estaba subido (${ya})`); continue; }

      const archivos = aws(['s3', 'ls', base]).split('\n').map(l => l.trim().split(/\s+/).pop()).filter(n => /\.mp4$/i.test(n || ''));
      if (archivos.length !== 1) throw new Error(`en reels/${v.carpeta}/ hay ${archivos.length} videos .mp4 y tiene que haber uno solo`);
      const { titulo, descripcion } = tituloYDescripcion(leer(base + 'caption.txt'), v.titulo);
      const url = `${redes.SITIO}/reels/${v.carpeta}/${archivos[0]}`;
      log(`${i + 1}. ${hora(cuando)} · ${v.carpeta}\n    ${titulo}`);
      if (probar) continue;

      // Solo el primero sale en el momento; un horario vencido cortaría la tanda a mitad de camino.
      const programar = i === 0 ? null : cuando.toISOString();
      if (programar && cuando.getTime() < Date.now() + MARGEN_MS) throw new Error(`el horario de ${v.carpeta} ya pasó: revisar --inicio`);
      const r = await fetch(url);
      if (!r.ok || !/video\/mp4/.test(r.headers.get('content-type') || '')) throw new Error('no es un MP4 público: ' + url);
      const video = Buffer.from(await r.arrayBuffer());
      const s = await subirYouTube(video, { titulo, descripcion, privacidad: 'public', programar });
      aws(['s3', 'cp', '-', base + 'youtube.txt', '--content-type', 'text/plain', '--cache-control', 'no-cache'], `${s.link} ${s.programado || 'publico ' + new Date().toISOString()}\n`);
      log(`    subido: ${s.link} · ${s.programado ? 'programado ' + hora(new Date(s.programado)) : 'público ya'}`);
    }
    log(probar ? 'modo prueba: no se subió nada' : 'tanda terminada');
  } catch (e) {
    console.error('[youtube-tanda] ' + (e.message || e));
    process.exit(1);
  }
})();
