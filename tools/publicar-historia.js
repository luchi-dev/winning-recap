#!/usr/bin/env node
/* Publica una historia de Instagram con una imagen ya subida al sitio.
   Uso: node tools/publicar-historia.js <url-del-jpg> [--probar]
   Con --probar solo revisa que la imagen exista y sea JPG; no publica. */
const { publicarHistoria } = require('./redes');
(async () => {
  const url = process.argv[2];
  const probar = process.argv.includes('--probar');
  if (!/^https:\/\/winning\.com\.ar\/.+\.jpe?g$/i.test(url || '')) throw new Error('la dirección tiene que ser un JPG de winning.com.ar');
  const r = await fetch(url, { method: 'HEAD' });
  const tipo = r.headers.get('content-type') || '';
  if (!r.ok || !/image\/jpe?g/.test(tipo)) throw new Error(`la imagen no responde bien (${r.status}, ${tipo})`);
  console.log(`[publicar-historia] imagen ok: ${url} (${r.headers.get('content-length')} bytes)`);
  if (probar) { console.log('[publicar-historia] prueba: no se publica'); return; }
  console.log('[publicar-historia] publicada en Instagram: ' + await publicarHistoria(url));
})().catch(e => { console.error('[publicar-historia] ERROR: ' + e.message); process.exit(1); });
