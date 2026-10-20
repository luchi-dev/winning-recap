#!/usr/bin/env node
/**
 * publicar-carrusel.js — publica en Instagram (y en Facebook, si se pide) un
 * carrusel ya armado: las placas no salen del Recap, se suben antes al S3.
 *
 *   node publicar-carrusel.js <carpeta> [--probar] [--facebook]
 *
 *   carpeta     nombre dentro de carruseles/ en el S3 del sitio. Adentro van
 *               las placas en JPG (hasta 10, se publican en orden alfabético:
 *               01-portada.jpg, 02-...) y caption.txt con el texto. Una placa
 *               puede ser un video .mp4 (H.264 + AAC, hasta 60 s; solo Instagram).
 *   --probar    revisa placas y caption y los muestra, pero no publica
 *   --facebook  publica también en la página de Facebook (si están las claves)
 *   --x         publica en X en vez de Instagram: hasta 4 JPG y el texto de
 *               tweet.txt (la cuenta tiene X Premium: admite textos largos;
 *               pasados los 280 caracteres X muestra "Mostrar más"). Con
 *               responde.txt (el número de un tweet) sale como respuesta, y
 *               ahí puede ir sin imágenes: solo el texto
 *
 * Claves en el ambiente: IG_USER_ID, IG_ACCESS_TOKEN y, opcionales, FB_PAGE_ID
 * y FB_PAGE_TOKEN; para X, las cuatro X_*. Lo compartido está en redes.js.
 */

const { spawnSync } = require('child_process');
const redes = require('./redes.js');

const BUCKET = process.env.BUCKET || 's3://winning-com-ar/iloveneuquen';
const log = m => console.log('[publicar-carrusel] ' + m);

function aws(args) {
  const r = spawnSync('aws', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('aws ' + args.slice(0, 2).join(' ') + ' falló: ' + (r.stderr || '').trim().slice(0, 200));
  return r.stdout;
}

/* X con video: un solo MP4 (H.264 + AAC), sin imágenes, y el texto de tweet.txt. */
async function publicarVideoEnX(carpeta, base, placas, probar) {
  if (placas.length !== 1) throw new Error('para X con video la carpeta lleva un solo .mp4, sin imágenes');
  const texto = aws(['s3', 'cp', base + 'tweet.txt', '-']).replace(/\r/g, '').trim();
  if (!texto) throw new Error('tweet.txt está vacío');
  const u = `${redes.SITIO}/carruseles/${carpeta}/${placas[0]}`;
  const r = await fetch(u + '?v=' + Date.now());
  if (!r.ok || !/video\/mp4/.test(r.headers.get('content-type') || '')) throw new Error('no es un MP4 público: ' + u);
  const mp4 = Buffer.from(await r.arrayBuffer());
  log(`video ${u} (${(mp4.length / 1048576).toFixed(1)} MB)`);
  log(`texto (${texto.length} caracteres):\n${texto}\n`);
  if (probar) { log('modo prueba: no se publica'); return; }
  log('publicado en X: ' + await redes.publicarX(texto, [], null, mp4));
}

/* X: una a cuatro imágenes y el texto de tweet.txt. Las imágenes se bajan del sitio. */
async function publicarEnX(carpeta, base, placas, probar) {
  if (placas.some(n => /\.mp4$/i.test(n))) return await publicarVideoEnX(carpeta, base, placas, probar);
  if (placas.length > 4) throw new Error(`hay ${placas.length} imágenes y X acepta hasta 4 por posteo`);
  const texto = aws(['s3', 'cp', base + 'tweet.txt', '-']).replace(/\r/g, '').trim();
  if (!texto) throw new Error('tweet.txt está vacío');
  if (texto.length > 4000) throw new Error(`el texto tiene ${texto.length} caracteres: demasiado largo para un posteo`);
  if (texto.length > 280) log('aviso: pasa los 280 caracteres; en X se ve cortado con "Mostrar más"');
  const jpgs = [];
  for (const n of placas) {
    const u = `${redes.SITIO}/carruseles/${carpeta}/${n}`;
    const r = await fetch(u + '?v=' + Date.now());
    if (!r.ok || !/image\/jpeg/.test(r.headers.get('content-type') || '')) throw new Error('no es un JPG público: ' + u);
    jpgs.push(Buffer.from(await r.arrayBuffer()));
    log(`imagen ${u} (${Math.round(jpgs[jpgs.length - 1].length / 1024)} KB)`);
  }
  // responde.txt (opcional): id del tweet al que se contesta, para armar un hilo.
  let responde = null;
  try { responde = aws(['s3', 'cp', base + 'responde.txt', '-']).trim() || null; } catch (e) { /* sin responde.txt es un posteo suelto */ }
  if (responde && !/^\d+$/.test(responde)) throw new Error('responde.txt tiene que ser solo el número del tweet');
  // cita.txt (opcional): id del tweet que se cita (quote tweet).
  let cita = null;
  try { cita = aws(['s3', 'cp', base + 'cita.txt', '-']).trim() || null; } catch (e) { /* sin cita.txt no cita nada */ }
  if (cita && !/^\d+$/.test(cita)) throw new Error('cita.txt tiene que ser solo el número del tweet');
  // sin imágenes solo vale como respuesta: un texto suelto debajo de un tweet nuestro
  if (!placas.length && !responde) throw new Error(`en carruseles/${carpeta}/ no hay ningún JPG`);
  log(`texto (${texto.length} caracteres):\n${texto}\n`);
  if (responde) log('en respuesta a https://x.com/i/status/' + responde);
  if (cita) log('citando https://x.com/i/status/' + cita);
  if (probar) { log('modo prueba: no se publica'); return; }
  log('publicado en X: ' + await redes.publicarX(texto, jpgs, responde, null, cita));
}

(async () => {
  const a = process.argv.slice(2);
  const carpeta = a[0] && !a[0].startsWith('--') ? a[0] : null;
  const probar = a.includes('--probar'), facebook = a.includes('--facebook'), enX = a.includes('--x');
  if (!carpeta || !/^[a-z0-9-]+$/.test(carpeta)) {
    console.error('uso: node publicar-carrusel.js <carpeta> [--probar] [--facebook]   (carpeta: minúsculas, números y guiones)');
    process.exit(2);
  }
  try {
    const base = `${BUCKET}/carruseles/${carpeta}/`;
    const placas = aws(['s3', 'ls', base]).split('\n').map(l => l.trim().split(/\s+/).pop()).filter(n => /\.(jpe?g|mp4)$/i.test(n || '')).sort();
    if (enX) return await publicarEnX(carpeta, base, placas, probar);
    if (facebook && placas.some(n => /\.mp4$/i.test(n))) throw new Error('el carrusel tiene un video: a Facebook no se puede mandar así, publicar sin --facebook');
    // Con una sola placa sale como foto común (publicarInstagram acepta 1 a 10).
    if (placas.length < 1) throw new Error(`en carruseles/${carpeta}/ no hay JPG`);
    if (placas.length > 10) throw new Error(`hay ${placas.length} placas e Instagram acepta hasta 10 por carrusel`);
    const caption = aws(['s3', 'cp', base + 'caption.txt', '-']).replace(/\r/g, '').trim();
    if (!caption) throw new Error('caption.txt está vacío');
    if (caption.length > 2200) throw new Error(`el caption tiene ${caption.length} caracteres e Instagram permite 2200`);
    // El sitio responde 200 con la home si el archivo no existe: se comprueba que cada dirección devuelva un JPG.
    const urls = placas.map(n => `${redes.SITIO}/carruseles/${carpeta}/${n}`);
    for (const u of urls) {
      const r = await fetch(u, { method: 'HEAD' });
      const tipo = /\.mp4$/i.test(u) ? /video\/mp4/ : /image\/jpeg/;
      if (!r.ok || !tipo.test(r.headers.get('content-type') || '')) throw new Error('no es un JPG o MP4 público: ' + u);
    }
    log(`${placas.length} placas:\n${urls.join('\n')}\n`);
    log(`caption (${caption.length} caracteres):\n${caption}\n`);
    if (probar) { log('modo prueba: no se publica'); return; }
    log('publicado en Instagram: ' + await redes.publicarInstagram(caption, urls));
    // Facebook va después: si falla, Instagram ya salió y no se repite.
    if (!facebook) log('Facebook: no se pidió');
    else if (!process.env.FB_PAGE_ID || !process.env.FB_PAGE_TOKEN) log('Facebook: sin FB_PAGE_ID / FB_PAGE_TOKEN, no se publica ahí');
    else {
      try { log('publicado en Facebook: ' + await redes.publicarFacebook(caption, urls)); }
      catch (e) { console.log('::warning::Facebook falló: ' + e.message); log('Facebook falló: ' + e.message); }
    }
  } catch (e) {
    console.error('[publicar-carrusel] ' + (e.message || e));
    process.exit(1);
  }
})();
