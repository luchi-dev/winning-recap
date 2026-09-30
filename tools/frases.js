// Frases de entrevistas → frases.json (lo muestra el index en Editorial → Frases).
//
//   node tools/frases.js <link del tuit> [--cuadros 8] [--dry]
//
// X/Twitter: lee el tuit por api.fxtwitter.com (gratis, sin clave). Las cuentas de medios
// escriben la frase entre comillas y el autor después de 🗣️; se usa TEXTUAL, sin reescribir.
// Si el tuit trae video, Chrome sin cabeza lo abre y saca cuadros a lo largo del video:
// quedan como opciones de foto (frases/<id>/cuadro-N.jpg), la del medio por defecto.
// Pendiente: YouTube (subtítulos por innertube, como la-redonda) y videos sin texto.
const fs = require('fs');
const path = require('path');
const os = require('os');

const RAIZ = path.join(__dirname, '..');
const JSON_FRASES = path.join(RAIZ, 'frases.json');
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const args = process.argv.slice(2);
const url = args.find(a => /^https?:\/\//.test(a));
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const DRY = args.includes('--dry');
const N_CUADROS = +opt('cuadros', 8);

function tuitDe(u) {
  const m = String(u).match(/(?:x|twitter)\.com\/([^/]+)\/status\/(\d+)/i);
  return m && { usuario: m[1], id: m[2] };
}

/* "“Frase…” 🗣️ Autor" → { texto, autor }. Acepta comillas rectas o tipográficas y
   el autor antes o después de la frase ("Autor: “…”"). */
function separarFrase(txt) {
  const limpio = String(txt).replace(/https?:\/\/t\.co\/\S+/g, '').trim();
  const comillas = limpio.match(/[“"«]([\s\S]+?)[”"»]/);
  const texto = comillas ? comillas[1].trim() : '';
  let autor = '';
  const voz = limpio.match(/🗣️?\s*([^\n:“"«]+)/u);
  if (voz) autor = voz[1].trim();
  else {
    const antes = limpio.match(/^([^\n:“"«]{3,40}):\s*[“"«]/);
    if (antes) autor = antes[1].trim();
  }
  return { texto: texto || limpio, autor: autor.replace(/[.,;]+$/, '') };
}

async function leerTuit(t) {
  const r = await fetch(`https://api.fxtwitter.com/${t.usuario}/status/${t.id}`);
  if (!r.ok) throw new Error('fxtwitter respondió ' + r.status);
  const j = await r.json();
  if (!j.tweet) throw new Error('el tuit no vino: ' + JSON.stringify(j).slice(0, 200));
  return j.tweet;
}

/* Cuadros del video: Chrome lo reproduce (H.264) y se saca captura del <video> en N puntos. */
async function sacarCuadros(videoUrl, dur, dir, n) {
  const puppeteer = require('puppeteer-core');
  const tmp = path.join(os.tmpdir(), 'frase-video-' + Date.now() + '.mp4');
  const r = await fetch(videoUrl);
  if (!r.ok) throw new Error('no bajó el video: ' + r.status);
  fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const archivos = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    // Desde about:blank Chrome no deja abrir un archivo local: la página va al lado del video.
    const html = tmp.replace(/\.mp4$/, '.html');
    fs.writeFileSync(html, `<body style="margin:0;background:#000"><video id="v" muted playsinline preload="auto" style="width:1920px;height:1080px;object-fit:contain;display:block" src="${path.basename(tmp)}"></video></body>`);
    await page.goto('file:///' + html.replace(/\\/g, '/'));
    await page.waitForFunction(() => document.getElementById('v').readyState >= 1, { timeout: 30000 });
    const largo = await page.evaluate(() => document.getElementById('v').duration) || dur || 10;
    const vid = await page.$('#v');
    for (let i = 0; i < n; i++) {
      // Ni el primer ni el último segundo: suelen ser placas del medio o negro.
      const seg = Math.max(0.5, Math.min(largo - 1, largo * (i + 0.5) / n));
      await page.evaluate(s => new Promise(res => { const v = document.getElementById('v'); v.onseeked = () => res(); v.currentTime = s; }), seg);
      await new Promise(res => setTimeout(res, 250));
      const nombre = `cuadro-${i + 1}.jpg`;
      await vid.screenshot({ path: path.join(dir, nombre), type: 'jpeg', quality: 90 });
      archivos.push({ archivo: nombre, seg: Math.round(seg * 10) / 10 });
    }
  } finally {
    await browser.close();
    fs.rmSync(tmp, { force: true });
    fs.rmSync(tmp.replace(/\.mp4$/, '.html'), { force: true });
  }
  return archivos;
}

async function main() {
  if (!url) { console.log('Uso: node tools/frases.js <link del tuit> [--cuadros 8] [--dry]'); process.exit(1); }
  const t = tuitDe(url);
  if (!t) throw new Error('Por ahora sólo links de X/Twitter (x.com/<cuenta>/status/<id>)');
  const tw = await leerTuit(t);
  const { texto, autor } = separarFrase(tw.text);
  console.log('Frase:', texto, '\nAutor:', autor || '(no se encontró: completar a mano)');

  const id = 'x-' + t.id;
  const dir = path.join(RAIZ, 'frases', id);
  const media = (tw.media && tw.media.all) || [];
  const video = media.find(m => m.type === 'video' || m.type === 'gif');
  const fotos = media.filter(m => m.type === 'photo');
  let opciones = [];
  if (!DRY) {
    fs.mkdirSync(dir, { recursive: true });
    if (video) {
      // La variante mp4 de 1280 alcanza para 1080x1350 y baja 5 veces más rápido que la de 1920.
      const mp4 = (video.formats || video.variants || []).filter(f => (f.container || f.content_type || '').includes('mp4') && f.url)
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      const elegido = mp4.find(f => /1280x|x1280/.test(f.url)) || mp4[0] || { url: video.url };
      console.log('Video:', Math.round(video.duration || 0) + ' s → sacando ' + N_CUADROS + ' cuadros…');
      opciones = (await sacarCuadros(elegido.url, video.duration, dir, N_CUADROS)).map(c => ({ archivo: `frases/${id}/${c.archivo}`, seg: c.seg }));
    }
    for (let i = 0; i < fotos.length; i++) {
      const r = await fetch(fotos[i].url + (fotos[i].url.includes('?') ? '' : '?name=large'));
      const nombre = `foto-${i + 1}.jpg`;
      fs.writeFileSync(path.join(dir, nombre), Buffer.from(await r.arrayBuffer()));
      opciones.push({ archivo: `frases/${id}/${nombre}` });
    }
  }

  let todo = { frases: [] };
  try { todo = JSON.parse(fs.readFileSync(JSON_FRASES, 'utf8')); } catch (e) {}
  const previa = todo.frases.find(f => f.id === id);
  // Lo que se agregó a mano o de otra fuente (texto corto, fotos de prensa, recorte del autor) se conserva.
  const propias = opciones.map(o => o.archivo);
  const frase = {
    ...(previa || {}),
    id,
    texto,
    autor,
    fuente: { red: 'x', url: `https://x.com/${t.usuario}/status/${t.id}`, cuenta: '@' + (tw.author && tw.author.screen_name || t.usuario), fecha: tw.created_timestamp ? new Date(tw.created_timestamp * 1000).toISOString() : null },
    fotos: ((previa && previa.fotos) || []).filter(o => !propias.includes(o.archivo) && !/\/(cuadro|foto)-\d+\.jpg$/.test(o.archivo)).concat(opciones),
    foto: previa && previa.foto != null ? previa.foto : Math.floor(opciones.length / 2),   // índice de la foto de fondo por defecto
    diseno: (previa && previa.diseno) || 'globo',
    v: previa ? (previa.v || 1) + 1 : 1,
  };
  todo.frases = [frase].concat(todo.frases.filter(f => f.id !== id));
  if (DRY) { console.log(JSON.stringify(frase, null, 2)); return; }
  fs.writeFileSync(JSON_FRASES, JSON.stringify(todo, null, 2) + '\n');
  console.log(`frases.json: ${id} (v${frase.v}) con ${opciones.length} fotos`);
}

if (require.main === module) main().catch(e => { console.error(e.message || e); process.exit(1); });
module.exports = { sacarCuadros };
