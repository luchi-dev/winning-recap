#!/usr/bin/env node
/**
 * publicar-x.js — publica en X (Twitter) una placa del Recap con su texto.
 *
 *   node publicar-x.js <fecha> <placa> [opcion] [--texto "..."] [--probar]
 *
 *   placa    ideal      póster del 11 Ideal (equipo_ideal_fechaN)
 *            ganadores  placa de Ganadores de la fecha (ganadores_fechaN)
 *   opcion   qué texto de captions.json usar: 1..4 para el 11 Ideal, A/B para
 *            ganadores (por defecto el primero). Se publica el 'texto_x' de esa
 *            opción (la versión de 280 caracteres); si la opción no tiene
 *            texto_x, se usa la versión corta recortada con puntos suspensivos.
 *   --texto  texto propio, en vez del de captions.json (o la variable X_TEXTO).
 *   --probar arma la imagen y muestra el texto, pero no publica (deja
 *            captions/x-<placa>-fecha<N>.jpg para mirarla).
 *
 * La imagen sale de la página publicada (winning.com.ar/iloveneuquen) abierta
 * en Chrome sin cabeza: es exactamente el PNG del botón "Descargar PNG"
 * (recapExportar en index.html), pasado a JPG. Lo compartido está en redes.js.
 * Las claves de X van en el ambiente, nunca en un archivo.
 */

const fs = require('fs');
const path = require('path');
const redes = require('./redes.js');

const { COMPETITION, SEASON, RAIZ } = redes;
const MAX_X = 275;   // X corta en 280; margen por cómo cuenta emojis y acentos
const log = m => console.log('[publicar-x] ' + m);

function argumentos() {
  const a = process.argv.slice(2);
  const i = a.indexOf('--texto');
  return { md: Number(a[0]), placa: a[1], opcion: a[2] && !a[2].startsWith('--') ? a[2] : null, texto: i >= 0 ? a[i + 1] : (process.env.X_TEXTO || null), probar: a.includes('--probar') };
}

const ARCHIVO_DE = { ideal: md => 'equipo_ideal_fecha' + md, ganadores: md => 'ganadores_fecha' + md };

/* La opción elegida de captions.json para esa placa. */
function opcionDe(md, placa, opcion) {
  const todo = JSON.parse(fs.readFileSync(path.join(RAIZ, 'captions.json'), 'utf8'));
  const fecha = todo[`${COMPETITION}-${SEASON}-${md}`] || {};
  const lista = fecha[placa === 'ideal' ? 'ideal' : 'ganadores'] || [];
  if (!lista.length) throw new Error(`la fecha ${md} no tiene textos de ${placa} en captions.json`);
  let idx = 0;
  if (opcion) {
    idx = /^\d+$/.test(opcion) ? Number(opcion) - 1 : 'ABCD'.indexOf(opcion.toUpperCase());
    if (idx < 0 || idx >= lista.length) throw new Error(`opción ${opcion} no existe (hay ${lista.length})`);
  }
  return lista[idx];
}

/* El texto de X para esa placa y opción. */
function textoDe(md, placa, opcion) {
  const c = opcionDe(md, placa, opcion);
  if (c.texto_x) return c.texto_x.trim();
  const base = (c.texto_corto || c.texto || '').trim();
  return base.length <= MAX_X ? base : base.slice(0, MAX_X - 1).replace(/\s+\S*$/, '') + '…';
}

/* La placa como JPG (una sola). */
async function imagenDe(md, placa) {
  const archivo = ARCHIVO_DE[placa] ? ARCHIVO_DE[placa](md) : placa;
  return (await redes.imagenes(md, [archivo]))[0];
}

module.exports = { imagenDe, textoDe, opcionDe, ARCHIVO_DE, MAX_X };

if (require.main === module) (async () => {
  const { md, placa, opcion, texto, probar } = argumentos();
  if (!md || !['ideal', 'ganadores'].includes(placa)) {
    console.error('uso: node publicar-x.js <fecha> <ideal|ganadores> [opcion] [--texto "..."] [--probar]');
    process.exit(2);
  }
  try {
    const t = (texto || textoDe(md, placa, opcion)).trim();
    if (t.length > 280) throw new Error(`el texto tiene ${t.length} caracteres y X permite 280`);
    log(`texto (${t.length} caracteres):\n${t}\n`);
    log('armando la imagen desde la página publicada...');
    const jpg = await imagenDe(md, placa);
    const salida = path.join(RAIZ, 'captions', `x-${placa}-fecha${md}.jpg`);
    fs.mkdirSync(path.dirname(salida), { recursive: true });
    fs.writeFileSync(salida, jpg);
    log(`imagen lista: ${path.relative(RAIZ, salida)} (${Math.round(jpg.length / 1024)} KB)`);
    if (probar) { log('modo prueba: no se publica'); return; }
    log('publicado en X: ' + await redes.publicarX(t, [jpg]));
  } catch (e) {
    console.error('[publicar-x] ' + (e.data ? JSON.stringify(e.data) : (e.message || e)));
    process.exit(1);
  }
})();
