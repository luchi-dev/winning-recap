// Una sola foto de Transfermarkt, para cuando bajar-fotos.js no acierta el jugador
// (nombres de una palabra, como "Rick"). Mismos pasos: buscar, confirmar club,
// bajar el retrato, sacarle el fondo y guardar fotos/<player_id>.png.
//   node _foto-una.js <player_id> "<búsqueda en Transfermarkt>" "<palabra del club>"
const fs = require('fs'), path = require('path');
const { pathToFileURL } = require('url');
const [id, consulta, clubPalabra] = process.argv.slice(2);
// El club es lo único que confirma que es el jugador correcto: con una palabra corta
// ("C") coincide cualquiera y se guarda la cara de otro.
if (clubPalabra && clubPalabra.trim().length < 5) { console.error('La palabra del club tiene que tener 5 letras o más.'); process.exit(2); }
if (!id || !consulta || !clubPalabra) { console.error('Uso: node _foto-una.js <player_id> "<búsqueda>" "<club>"'); process.exit(2); }
const TM = 'https://www.transfermarkt.com.ar';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MODELO = pathToFileURL(path.join(__dirname, 'node_modules', '@imgly', 'background-removal-node', 'dist') + path.sep).href;
(async () => {
  const puppeteer = require('puppeteer-core');
  const { removeBackground } = require('@imgly/background-removal-node');
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage(); await page.setUserAgent(UA);
    const r = await page.goto(TM + '/schnellsuche/ergebnis/schnellsuche?query=' + encodeURIComponent(consulta), { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (r.status() !== 200) throw new Error('búsqueda HTTP ' + r.status());
    const filas = await page.evaluate(() => Array.from(document.querySelectorAll('table.items tbody tr')).map(tr => {
      const a = tr.querySelector('a[href*="/profil/spieler/"]'); if (!a) return null;
      const c = tr.querySelector('a[href*="/startseite/verein/"], a[href*="/spielplan/verein/"]'); const e = tr.querySelector('img.tiny_wappen, img[src*="/wappen/"]');
      return { nombre: a.textContent.trim(), url: a.href, club: (c && c.textContent.trim()) || (e && (e.title || e.alt)) || '' };
    }).filter(Boolean));
    filas.slice(0, 8).forEach(f => console.log('  candidato:', f.nombre, '|', f.club));
    const f = filas.find(x => x.club.toLowerCase().includes(clubPalabra.toLowerCase()));
    if (!f) throw new Error('ningún resultado con club "' + clubPalabra + '"');
    console.log('elegido:', f.nombre, '|', f.club, '|', f.url);
    await new Promise(r => setTimeout(r, 4000));
    await page.goto(f.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const foto = await page.evaluate(() => { const i = document.querySelector('.data-header__profile-image, img[src*="/portrait/"]'); return i ? (i.currentSrc || i.src) : null; });
    if (!foto || /default/.test(foto)) throw new Error('sin retrato: ' + foto);
    const resp = await fetch(foto, { headers: { Referer: TM + '/', 'User-Agent': UA } });
    if (!resp.ok) throw new Error('foto HTTP ' + resp.status);
    const buf = Buffer.from(await resp.arrayBuffer());
    const blob = await removeBackground(new Blob([buf], { type: 'image/jpeg' }), { publicPath: MODELO, output: { format: 'image/png' } });
    const out = path.resolve(__dirname, '..', 'fotos', id + '.png');
    fs.writeFileSync(out, Buffer.from(await blob.arrayBuffer()));
    console.log('guardada:', out);
  } finally { await browser.close(); }
})().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
