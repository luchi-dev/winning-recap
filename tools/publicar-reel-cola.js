#!/usr/bin/env node
/**
 * publicar-reel-cola.js — publica como reel de prueba el próximo video de la cola
 * (tools/reels-cola.json), uno por pasada. Lo corre el workflow "Reels en cola", que se queda de guardia y hace una pasada cada media hora.
 *
 *   node publicar-reel-cola.js [--probar]
 *
 * tools/reels-cola.json: { "activa": true, "minutos": 25, "tipo": "manual", "carpetas": ["censo-07-tucuman", ...] }
 * Cada carpeta está en reels/<carpeta>/ del S3 del sitio, con un .mp4 y caption.txt (como publicar-reel.js).
 * El estado va en el mismo S3: intento.txt se escribe antes de publicar y publicado.txt después, con la hora
 * y el link. Una carpeta con intento.txt no se vuelve a intentar (así un fallo a mitad no la sube dos veces).
 * No publica si el reel anterior salió hace menos de "minutos".
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const BUCKET = process.env.BUCKET || 's3://winning-com-ar/iloveneuquen';
const log = m => console.log('[reel-cola] ' + m);

function aws(args, entrada) {
  const r = spawnSync('aws', args, { encoding: 'utf8', input: entrada });
  return { ok: r.status === 0, out: r.stdout || '', err: (r.stderr || '').trim() };
}
const leer = (carpeta, archivo) => { const r = aws(['s3', 'cp', `${BUCKET}/reels/${carpeta}/${archivo}`, '-']); return r.ok ? r.out.trim() : null; };
const escribir = (carpeta, archivo, texto) => { const r = aws(['s3', 'cp', '-', `${BUCKET}/reels/${carpeta}/${archivo}`, '--content-type', 'text/plain; charset=utf-8'], texto); if (!r.ok) throw new Error('no pude escribir ' + archivo + ': ' + r.err.slice(0, 200)); };

(async () => {
  const probar = process.argv.includes('--probar');
  const cola = JSON.parse(fs.readFileSync(path.join(__dirname, 'reels-cola.json'), 'utf8'));
  if (!cola.activa) { log('la cola está apagada (activa: false)'); return; }
  let ultimo = 0, proxima = null;
  for (const carpeta of cola.carpetas) {
    const hecho = leer(carpeta, 'publicado.txt') || leer(carpeta, 'intento.txt');
    if (hecho) { ultimo = Math.max(ultimo, Date.parse(hecho.split('\n')[0]) || 0); continue; }
    proxima = carpeta; break;
  }
  if (!proxima) { log('no queda nada en la cola'); return; }
  const min = (Date.now() - ultimo) / 60000;
  if (ultimo && min < (cola.minutos || 25)) { log(`el anterior salió hace ${Math.round(min)} min: espero a la próxima pasada (sigue ${proxima})`); return; }
  const lista = aws(['s3', 'ls', `${BUCKET}/reels/${proxima}/`]).out;
  if (!/\.mp4\s*$/m.test(lista) || !/caption\.txt/.test(lista)) { log(`${proxima} todavía no tiene video y caption en el sitio: espero`); return; }
  log('sigue: ' + proxima);
  if (probar) { log('modo prueba: no se publica'); return; }
  escribir(proxima, 'intento.txt', new Date().toISOString());
  const r = spawnSync('node', [path.join(__dirname, 'publicar-reel.js'), proxima, '--prueba', cola.tipo || 'manual'], { encoding: 'utf8' });
  process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || '');
  const link = ((r.stdout || '').match(/publicado en Instagram: (\S+)/) || [])[1];
  if (r.status !== 0 || !link) { console.log(`::warning::${proxima} no se pudo publicar; queda marcada y la cola sigue con la próxima`); process.exit(1); }
  escribir(proxima, 'publicado.txt', new Date().toISOString() + '\n' + link);
  log(`publicado ${proxima}: ${link}`);
})().catch(e => { console.error('[reel-cola] ' + (e.message || e)); process.exit(1); });
