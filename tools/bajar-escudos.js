#!/usr/bin/env node
/* Baja los escudos originales de los 30 clubes del Clausura desde
   Transfermarkt (la misma fuente que ya usamos para jugadores) y los deja en
   escudos/<opta_team_id>.png, con el mismo nombre que badges/ usa para las
   camisetitas. Así la placa elige carpeta y listo.

   El mapeo Opta -> Transfermarkt sale de public.teams y
   gamification.carrera_clubs, que coinciden por nombre exacto en los 30.  */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');
const DEST = path.join(RAIZ, 'escudos');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/* opta_id: [tm_id, nombre] */
const CLUBES = {
  8621:  [12301, 'Aldosivi'],
  846:   [1030,  'Argentinos Juniors'],
  4671:  [14554, 'Atlético Tucumán'],
  2451:  [830,   'Banfield'],
  9280:  [25184, 'Barracas Central'],
  1313:  [2417,  'Belgrano'],
  540:   [189,   'Boca Juniors'],
  10752: [31284, 'Central Córdoba'],
  8625:  [2402,  'Defensa y Justicia'],
  9319:  [19775, 'Deportivo Riestra'],
  927:   [288,   'Estudiantes de La Plata'],
  15362: [14602, 'Estudiantes de Río IV'],
  10754: [14687, 'Gimnasia de Mendoza'],
  1392:  [1106,  'Gimnasia LP'],
  2578:  [2063,  'Huracán'],
  1243:  [1234,  'Independiente'],
  8627:  [12179, 'Independiente Rivadavia'],
  3638:  [1829,  'Instituto'],
  2473:  [333,   'Lanús'],
  1095:  [1286,  "Newell's Old Boys"],
  3579:  [928,   'Platense'],
  986:   [1444,  'Racing Club'],
  608:   [209,   'River Plate'],
  745:   [1418,  'Rosario Central'],
  2549:  [1775,  'San Lorenzo'],
  8629:  [12454, 'Sarmiento'],
  1071:  [3938,  'Talleres'],
  2580:  [11831, 'Tigre'],
  6374:  [7097,  'Unión'],
  570:   [1029,  'Vélez Sarsfield'],
};

/* Transfermarkt sirve el escudo en varios tamaños; "big" es el más grande
   que da sin login. */
const url = tm => `https://tmssl.akamaized.net/images/wappen/big/${tm}.png`;

const dormir = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(DEST, { recursive: true });
  let ok = 0, fallo = [];
  for (const [opta, [tm, nombre]] of Object.entries(CLUBES)) {
    const dest = path.join(DEST, opta + '.png');
    if (process.argv.includes('--solo-faltantes') && fs.existsSync(dest)) { ok++; continue; }
    try {
      execSync(`curl -sL -A "${UA}" --max-time 30 "${url(tm)}" -o "${dest}"`, { stdio: 'ignore' });
      const tam = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
      if (tam < 1500) throw new Error('vacío (' + tam + ' bytes)');
      console.log('  ✓ ' + nombre.padEnd(26) + Math.round(tam / 1024) + ' KB');
      ok++;
    } catch (e) {
      console.log('  ✗ ' + nombre.padEnd(26) + e.message);
      fallo.push(nombre);
      try { fs.unlinkSync(dest); } catch (e2) {}
    }
    await dormir(1200 + Math.random() * 800);
  }
  console.log('\n' + ok + ' escudos en escudos/' + (fallo.length ? '. Fallaron: ' + fallo.join(', ') : ''));
})();
