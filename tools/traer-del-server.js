#!/usr/bin/env node
/* traer-del-server.js — baja a esta carpeta las fotos que el vigilante
   (GitHub Actions) encontró y publicó solo, para que publicar.bat no las pise
   con una versión vieja.

   - Fotos (fotos/ y fotos-partido/): sólo trae las que acá NO existen. Nunca
     reemplaza un archivo local.
   - fotos-partido/elegidas.json: se mezcla partido por partido; gana el que
     tenga "actualizado" más nuevo (y se traen sus fotos).

   Lo corre publicar.bat antes de subir. A mano:  node tools/traer-del-server.js */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const AWS = ['C:/Program Files/Amazon/AWSCLIV2/aws.exe', 'aws'].find(f => f === 'aws' || fs.existsSync(f));
const BUCKET = 's3://winning-com-ar/iloveneuquen';
const PERFIL = ['--profile', 'iloveneuquen'];
const RAIZ = path.resolve(__dirname, '..');

const aws = (...a) => spawnSync(AWS, [...a, ...PERFIL], { encoding: 'utf8', maxBuffer: 20e6 });

function traerFaltantes(carpeta, sirve) {
  const r = aws('s3', 'ls', BUCKET + '/' + carpeta + '/', '--recursive');
  if (r.status !== 0) throw new Error('no pude listar ' + carpeta + ': ' + (r.stderr || '').trim().slice(0, 120));
  const faltan = r.stdout.split(/\r?\n/)
    .map(l => (l.match(/^\S+\s+\S+\s+\d+\s+iloveneuquen\/(.+)$/) || [])[1]).filter(Boolean)
    .map(k => k.slice(carpeta.length + 1))
    .filter(rel => sirve(rel) && !fs.existsSync(path.join(RAIZ, carpeta, rel)));
  for (let i = 0; i < faltan.length; i += 80) {
    const s = aws('s3', 'sync', BUCKET + '/' + carpeta + '/', path.join(RAIZ, carpeta), '--only-show-errors', '--exclude', '*',
      ...faltan.slice(i, i + 80).flatMap(rel => ['--include', rel]));
    if (s.status !== 0) throw new Error('no pude bajar de ' + carpeta + ': ' + (s.stderr || '').trim().slice(0, 120));
  }
  console.log('   ' + carpeta + ': ' + (faltan.length ? faltan.length + ' archivo(s) nuevos del server' : 'nada nuevo'));
}

function mezclarElegidas() {
  const tmp = path.join(os.tmpdir(), 'elegidas-server.json');
  if (aws('s3', 'cp', BUCKET + '/fotos-partido/elegidas.json', tmp, '--only-show-errors').status !== 0) return;
  const local = path.join(RAIZ, 'fotos-partido', 'elegidas.json');
  let mio = {}, suyo = {};
  try { mio = JSON.parse(fs.readFileSync(local, 'utf8')); } catch (e) {}
  try { suyo = JSON.parse(fs.readFileSync(tmp, 'utf8')); } catch (e) { return; }
  const tomados = [];
  for (const g of Object.keys(suyo)) {
    if (!mio[g] || String(suyo[g].actualizado || '') > String(mio[g].actualizado || '')) { mio[g] = suyo[g]; tomados.push(g); }
  }
  const n = tomados.length;
  if (n) fs.writeFileSync(local, JSON.stringify(mio, null, 1));
  // Las fotos de esos partidos son las del server aunque acá hubiera otras con el mismo nombre.
  if (tomados.length) aws('s3', 'sync', BUCKET + '/fotos-partido/', path.join(RAIZ, 'fotos-partido'), '--only-show-errors', '--exclude', '*',
    ...tomados.flatMap(g => ['--include', g + '.jpg', '--include', g + '-*.jpg']));
  console.log('   elegidas.json: ' + (n ? n + ' partido(s) actualizados desde el server' : 'nada nuevo'));
}

try {
  traerFaltantes('fotos', rel => /\.png$/i.test(rel));
  traerFaltantes('fotos-partido', rel => /\.jpg$/i.test(rel) && !rel.startsWith('_'));
  mezclarElegidas();
} catch (e) { console.error('   ' + e.message); process.exit(1); }
