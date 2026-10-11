#!/usr/bin/env node
/**
 * publicar-carrusel.js — publica en Instagram (y en Facebook, si se pide) un
 * carrusel ya armado: las placas no salen del Recap, se suben antes al S3.
 *
 *   node publicar-carrusel.js <carpeta> [--probar] [--facebook]
 *
 *   carpeta     nombre dentro de carruseles/ en el S3 del sitio. Adentro van
 *               las placas en JPG (hasta 10, se publican en orden alfabético:
 *               01-portada.jpg, 02-...) y caption.txt con el texto.
 *   --probar    revisa placas y caption y los muestra, pero no publica
 *   --facebook  publica también en la página de Facebook (si están las claves)
 *
 * Claves en el ambiente: IG_USER_ID, IG_ACCESS_TOKEN y, opcionales, FB_PAGE_ID
 * y FB_PAGE_TOKEN. Lo compartido está en redes.js.
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

(async () => {
  const a = process.argv.slice(2);
  const carpeta = a[0] && !a[0].startsWith('--') ? a[0] : null;
  const probar = a.includes('--probar'), facebook = a.includes('--facebook');
  if (!carpeta || !/^[a-z0-9-]+$/.test(carpeta)) {
    console.error('uso: node publicar-carrusel.js <carpeta> [--probar] [--facebook]   (carpeta: minúsculas, números y guiones)');
    process.exit(2);
  }
  try {
    const base = `${BUCKET}/carruseles/${carpeta}/`;
    const placas = aws(['s3', 'ls', base]).split('\n').map(l => l.trim().split(/\s+/).pop()).filter(n => /\.jpe?g$/i.test(n || '')).sort();
    if (placas.length < 2) throw new Error(`en carruseles/${carpeta}/ hay ${placas.length} JPG y un carrusel necesita al menos 2`);
    if (placas.length > 10) throw new Error(`hay ${placas.length} placas e Instagram acepta hasta 10 por carrusel`);
    const caption = aws(['s3', 'cp', base + 'caption.txt', '-']).replace(/\r/g, '').trim();
    if (!caption) throw new Error('caption.txt está vacío');
    if (caption.length > 2200) throw new Error(`el caption tiene ${caption.length} caracteres e Instagram permite 2200`);
    // El sitio responde 200 con la home si el archivo no existe: se comprueba que cada dirección devuelva un JPG.
    const urls = placas.map(n => `${redes.SITIO}/carruseles/${carpeta}/${n}`);
    for (const u of urls) {
      const r = await fetch(u, { method: 'HEAD' });
      if (!r.ok || !/image\/jpeg/.test(r.headers.get('content-type') || '')) throw new Error('no es un JPG público: ' + u);
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
