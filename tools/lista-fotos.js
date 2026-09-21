#!/usr/bin/env node
/* lista-fotos.js — escribe fotos/lista.json con los jugadores que tienen
   recorte y un sello de versión.

   La página lee esa lista en vez de probar foto por foto. Motivo: en
   winning.com.ar, pedir un archivo que no existe devuelve la home con
   "guardar un año", y el navegador se queda con esa respuesta aunque la foto
   se suba después. Con la lista no se pide nada que no exista, y el sello
   (?v=) hace que cada publicación traiga las fotos frescas.

   Lo corre publicar.bat antes de subir. También se puede correr a mano:
     node tools/lista-fotos.js                                            */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'fotos');
const ids = fs.readdirSync(DIR)
  .filter(f => /^\d+\.png$/i.test(f))
  .map(f => parseInt(f, 10))
  .sort((a, b) => a - b);

const d = new Date();
const p = n => String(n).padStart(2, '0');
const v = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes());

fs.writeFileSync(path.join(DIR, 'lista.json'), JSON.stringify({ v, ids }));
console.log('fotos/lista.json: ' + ids.length + ' fotos, versión ' + v);
