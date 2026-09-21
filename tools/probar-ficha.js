// Render de prueba de la ficha de jugador: abre el index en Chrome headless,
// va a Clausura fecha N, diseño "Nuevas", y guarda cada ficha como PNG.
const puppeteer = require('C:/Users/lucia/Winning Recap/tools/node_modules/puppeteer-core');
const fs = require('fs');
const OUT = require('path').join(__dirname, '..', '_check');
const fecha = parseInt(process.argv[2] || '8', 10);
const cuantas = parseInt(process.argv[3] || '3', 10);
(async () => {
  const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000, deviceScaleFactor: 1 });
  const errores = [];
  page.on('pageerror', e => errores.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errores.push(m.type() + ': ' + m.text().slice(0, 200)); });
  page.on('response', r => { if (r.status() === 404) errores.push('404: ' + r.url()); });
  await page.goto('http://localhost:8765/index.html?' + Date.now(), { waitUntil: 'networkidle2', timeout: 60000 });
  await page.evaluate(() => { document.querySelector('.comp-btn[data-comp="724"]').click(); });
  await page.evaluate(async f => { await loadFecha(f); }, fecha);
  await page.evaluate(() => { setDisenoPartidos('nuevas'); });
  await page.evaluate(async () => { await abrirTodosPartidos(); });   // las fichas ahora se despliegan por partido
  await page.waitForFunction(() => document.querySelectorAll('.card-fj').length > 0, { timeout: 90000 });
  await new Promise(r => setTimeout(r, 4000));
  await page.evaluate(() => document.fonts.ready);
  const n = await page.evaluate(() => document.querySelectorAll('.card-fj').length);
  console.log('fichas en la página:', n, '| placas total:', await page.evaluate(() => document.querySelectorAll('.card').length));
  const datos = await page.evaluate(() => Array.from(document.querySelectorAll('.card-fj')).slice(0, 12).map(c => ({
    nombre: c.querySelector('.fj-nombre').textContent, equipo: c.querySelector('.fj-equipo').textContent,
    pos: c.querySelector('.fj-pos').textContent, pts: c.querySelector('.fj-pts').textContent, res: c.querySelector('.fj-res-txt').textContent,
    foto: !!c.querySelector('.rn-foto').style.backgroundImage,
    anchoEquipo: c.querySelector('.fj-equipo').getBoundingClientRect().width / 0.3, anchoRes: c.querySelector('.fj-res-txt').getBoundingClientRect().width / 0.3,
    anchoNombre: c.querySelector('.fj-nombre').getBoundingClientRect().width / 0.3,
    fuentes: [getComputedStyle(c.querySelector('.fj-apellido')).fontFamily, getComputedStyle(c.querySelector('.fj-res-txt')).fontFamily],
  })));
  console.log(JSON.stringify(datos, null, 1));
  // Captura a tamaño real: se saca la escala como hace downloadCard.
  for (let i = 0; i < Math.min(cuantas, n); i++) {
    await page.evaluate(i => {
      const c = document.querySelectorAll('.card-fj')[i];
      c.style.transform = 'none'; c.parentElement.style.width = '1080px'; c.parentElement.style.height = '1350px'; c.parentElement.style.overflow = 'visible';
      c.scrollIntoView();
    }, i);
    const el = (await page.$$('.card-fj'))[i];
    await el.screenshot({ path: OUT + '/fj-render-' + i + '.png' });
    await page.evaluate(i => {
      const c = document.querySelectorAll('.card-fj')[i];
      c.style.transform = ''; c.parentElement.style.width = ''; c.parentElement.style.height = ''; c.parentElement.style.overflow = '';
    }, i);
  }
  const fontsOk = await page.evaluate(() => ['700 20px HelvNeue', '300 20px HelvNeue', '400 20px HelvNeue', '800 20px CanaroExtraBold', '900 20px CanaroBlack'].map(f => f + ' => ' + document.fonts.check(f)));
  console.log(fontsOk.join('\n'));
  console.log('errores:', errores.length ? '\n' + errores.slice(0, 15).join('\n') : 'ninguno');
  await browser.close();
})().catch(e => { console.error('FALLO:', e.message); process.exit(1); });
