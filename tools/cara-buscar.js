#!/usr/bin/env node
/* cara-buscar.js — cara de un jugador que Transfermarkt NO tiene.
   Busca retratos en Bing Imágenes (Chrome sin cabeza, sin login), se queda con
   los que parecen foto de cara (más altos que anchos o cuadrados, grandes),
   les saca el fondo con el mismo modelo que bajar-fotos.js y deja las opciones
   en fotos/_opciones/<id>-<n>.png para elegir a mano. Después:
     copy fotos\_opciones\<id>-<n>.png fotos\<id>.png

   Uso:  node cara-buscar.js <player_id> "<nombre>" "<club>"  [--max 6]          */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { pathToFileURL } = require('url');
const sharp = require('sharp');

const [id, nombre, club] = process.argv.slice(2);
if (!id || !nombre) { console.error('Uso: node cara-buscar.js <player_id> "<nombre>" "<club>"'); process.exit(2); }
const MAX = parseInt((process.argv.find((x, i) => process.argv[i - 1] === '--max')) || '6', 10);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const CHROME = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].filter(Boolean).find(f => fs.existsSync(f));
const MODELO = pathToFileURL(path.join(__dirname, 'node_modules', '@imgly', 'background-removal-node', 'dist') + path.sep).href;
const DEST = path.join(__dirname, '..', 'fotos', '_opciones');
fs.mkdirSync(DEST, { recursive: true });
const dormir = ms => new Promise(r => setTimeout(r, ms));

async function bing(texto) {
  const puppeteer = require('puppeteer-core');
  const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--lang=es-AR'] });
  try {
    const p = await b.newPage(); await p.setUserAgent(UA);
    // qft=+filterui:face-portrait = fotos que Bing detecta como retrato
    await p.goto('https://www.bing.com/images/search?q=' + encodeURIComponent(texto) + '&qft=+filterui:face-portrait+filterui:imagesize-large&setlang=es&cc=AR', { waitUntil: 'networkidle2', timeout: 60000 });
    await dormir(1200);
    await p.evaluate(async () => { for (let y = 0; y < 3000; y += 800) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 300)); } });
    return await p.evaluate(() => [...document.querySelectorAll('a.iusc')].map(a => { try { const m = JSON.parse(a.getAttribute('m')); return { u: m.murl, t: m.t, purl: m.purl }; } catch (e) { return null; } }).filter(Boolean));
  } finally { await b.close().catch(() => {}); }
}

function bajar(u, f) {
  try { execSync(`curl -sL -A "${UA}" --max-time 30 "${u.replace(/"/g, '%22')}" -o "${f}"`, { stdio: 'ignore' }); return fs.existsSync(f) && fs.statSync(f).size > 5000; } catch (e) { return false; }
}

(async () => {
  const { removeBackground } = require('@imgly/background-removal-node');
  const consultas = [nombre + ' ' + (club || ''), nombre + ' ' + (club || '') + ' jugador', nombre + ' futbolista'];
  const vistos = new Set(); const cands = [];
  for (const q of consultas) {
    const r = await bing(q); console.log('Bing «' + q + '»: ' + r.length + ' resultados');
    r.forEach(x => { if (!vistos.has(x.u)) { vistos.add(x.u); cands.push(x); } });
    await dormir(800);
  }
  // Preferir las que nombran al jugador en el título o la nota.
  const sin = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const apellido = sin(nombre).split(' ').pop();
  cands.sort((a, b) => (sin(b.t + b.purl).includes(apellido) ? 1 : 0) - (sin(a.t + a.purl).includes(apellido) ? 1 : 0));

  let n = 0; const filas = [];
  for (const c of cands) {
    if (n >= MAX) break;
    const tmp = path.join(DEST, '_tmp' + (vistos.size + cands.indexOf(c)) + '.img');   // nombre distinto por foto: sharp deja el archivo abierto y curl no puede pisarlo en Windows
    if (!bajar(c.u, tmp)) { if (process.env.VERBOSE) console.log('  no bajó: ' + c.u.slice(0, 80)); continue; }
    const datos = fs.readFileSync(tmp); try { fs.unlinkSync(tmp); } catch (e) {}
    let m; try { m = await sharp(datos).metadata(); } catch (e) { continue; }
    if (!m.width || m.width < 300 || m.height < 300 || m.width > m.height * 1.3) { if (process.env.VERBOSE) console.log('  descarto ' + m.width + 'x' + m.height + ' ' + c.u.slice(0, 70)); continue; }   // retrato: cuadrada o vertical, no chica
    // Recorte cuadrado centrado arriba (donde está la cara) y fondo afuera.
    const lado = Math.min(m.width, m.height);
    const buf = await sharp(datos).extract({ left: Math.round((m.width - lado) / 2), top: 0, width: lado, height: lado }).resize(600, 600).png().toBuffer();
    let png;
    try { png = Buffer.from(await (await removeBackground(new Blob([buf], { type: 'image/png' }), { publicPath: MODELO, output: { format: 'image/png' } })).arrayBuffer()); }
    catch (e) { console.log('  no pude sacar el fondo: ' + e.message.slice(0, 60)); continue; }
    n++;
    const out = path.join(DEST, id + '-' + n + '.png');
    fs.writeFileSync(out, png);
    filas.push({ n, tam: m.width + 'x' + m.height, host: c.u.replace(/^https?:\/\/(www\.)?/, '').split('/')[0], titulo: (c.t || '').slice(0, 70), url: c.u });
    console.log('  ' + n + '. ' + (m.width + 'x' + m.height).padEnd(10) + filas[filas.length - 1].host.padEnd(28) + filas[filas.length - 1].titulo);
  }
  fs.readdirSync(DEST).filter(f => f.startsWith('_tmp')).forEach(f => { try { fs.unlinkSync(path.join(DEST, f)); } catch (e) {} });
  fs.writeFileSync(path.join(DEST, id + '.json'), JSON.stringify(filas, null, 1));
  console.log(n ? '\n' + n + ' opciones en fotos/_opciones/' + id + '-<n>.png. Elegí una y copiala a fotos/' + id + '.png' : '\nno encontré retratos');
})().catch(e => { console.error('Error: ' + e.message); process.exit(1); });
