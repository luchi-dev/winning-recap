#!/usr/bin/env node
/**
 * bajar-fotos.js — recortes de jugadores para las placas del recap.
 *
 *   node bajar-fotos.js 7              fecha 7 del Clausura 2026
 *   node bajar-fotos.js 7 --comp 384   fecha 7 del Apertura
 *   node bajar-fotos.js 7 --forzar     rehace las que ya están
 *   node bajar-fotos.js 9 --partido 2614486   además, los 5 mejores de ese partido (placa Top 5)
 *   node bajar-fotos.js 9 --top5-partidos     además, los 5 mejores de TODOS los partidos de la fecha
 *   node bajar-fotos.js 10 --ids 123,456       SOLO esos jugadores (ej. una placa Top 5 de un equipo)
 *   node bajar-fotos.js 10 --listar            no baja nada: dice a quiénes les falta foto (lo usa vigilante.js)
 *
 * Qué hace, para los 22 puestos de los pósters de esa fecha:
 *   1. Pide el once ideal y el del ganador con la misma RPC que usa la página.
 *   2. Saltea a los que ya tienen foto. Es incremental: la fecha 8 sólo baja
 *      las caras nuevas.
 *   3. Resuelve cada jugador en Transfermarkt buscando por nombre y confirmando
 *      con el club. Sin coincidencia de club no lo da por bueno.
 *   4. Baja la foto de perfil y le saca el fondo con un modelo local.
 *   5. Guarda fotos/<player_id>.png. Lo que quedó dudoso va a fotos/_revisar/
 *      y no entra a las placas hasta que vos lo mires y lo muevas.
 *
 * Deja siempre un revisar.html con todas las caras de la corrida para que las
 * chequees de un vistazo.
 *
 * Ojo: Transfermarkt no permite el scrapeo automatizado en sus términos. El
 * script va despacio y de a una fecha justamente para no abusar, pero la
 * decisión de usarlo es de ustedes.
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

// ── Config ────────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://ketwxvbrhqbemlflmadu.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtldHd4dmJyaHFiZW1sZmxtYWR1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4NjA4MDcsImV4cCI6MjA4NjQzNjgwN30.-qXPLMSFEiRORNk5EUKrD16VDiMXtv-VfcDSWpzWzsg';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TM = 'https://www.transfermarkt.com.ar';

const CHROMES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].filter(Boolean);

const DIR_FOTOS = path.resolve(__dirname, '..', 'fotos');
const DIR_REVISAR = path.join(DIR_FOTOS, '_revisar');
// El quitador de fondo busca su modelo relativo al directorio actual: fijarlo
// para que el script funcione desde cualquier carpeta.
const MODELO_FONDO = pathToFileURL(path.join(__dirname, 'node_modules', '@imgly', 'background-removal-node', 'dist') + path.sep).href;

const dormir = ms => new Promise(r => setTimeout(r, ms));
/* Con pausas cortas y parejas Transfermarkt devuelve 502/504 a la cuarta o
   quinta consulta. Ir despacio y con variación no es cortesía: es la
   diferencia entre traer 4 fotos de 18 y traerlas casi todas. */
const dormirEntre = (a, b) => dormir(a + Math.random() * (b - a));
const ESPERA_REINTENTO = [20000, 45000, 90000];

// ── Argumentos ────────────────────────────────────────────────────────
function args() {
  const a = process.argv.slice(2);
  const fecha = parseInt(a.find(x => /^\d+$/.test(x)), 10);
  const ci = a.indexOf('--comp');
  return {
    matchday: fecha,
    competition: ci >= 0 ? parseInt(a[ci + 1], 10) : 724,
    season: 2026,
    forzar: a.includes('--forzar'),
    partidos: a.flatMap((x, i) => x === '--partido' ? [parseInt(a[i + 1], 10)] : []).filter(Boolean),
    top5Todos: a.includes('--top5-partidos'),
    listar: a.includes('--listar'),
    ids: a.includes('--ids') ? String(a[a.indexOf('--ids') + 1] || '').split(',').map(x => parseInt(x, 10)).filter(Boolean) : [],
  };
}

// ── Datos de la fecha ─────────────────────────────────────────────────
async function api(ruta, opciones = {}) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/' + ruta, {
    ...opciones,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      ...(opciones.headers || {}),
    },
  });
  if (!r.ok) throw new Error(ruta + ' -> HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}

async function jugadoresDeLaFecha(cfg) {
  let data = {};
  try {
    data = await api('rpc/get_matchday_recap', {
      method: 'POST',
      body: JSON.stringify({
        p_competition_id: cfg.competition,
        p_season_id: cfg.season,
        p_matchday: cfg.matchday,
      }),
    });
  } catch (e) {
    // Sin pósters todavía (fecha abierta) igual se pueden bajar los Top 5 de partidos.
    if (!cfg.partidos.length && !cfg.top5Todos) throw e;
    console.log('  (todavía no hay pósters de la fecha: ' + e.message.slice(0, 60) + ')');
  }
  const equipos = await api('teams?select=id,name,short_name');
  const nombreDeEquipo = {};
  equipos.forEach(t => { nombreDeEquipo[t.id] = t.name || t.short_name; });

  const vistos = new Set();
  const out = [];
  const sumar = (id, nombre, teamId, sigla, posicion) => {
    if (!id || vistos.has(id)) return;
    vistos.add(id);
    out.push({
      id,
      nombre: nombre || '',
      club: nombreDeEquipo[teamId] || sigla || '',
      posicion: posicion || '',
    });
  };

  // Los 22 de los dos pósters.
  [data.winning_team, data.winner_team].forEach(t => {
    ((t && t.players) || []).forEach(p =>
      sumar(p.player_id, p.player_name, p.team_id, p.team_short_name, p.display_position));
  });

  // Y los de las placas de MVPs y Super Suplentes, que también llevan cara y
  // pueden no estar en ningún once: un super suplente casi nunca lo está.
  const base = 'v_fantasy_player_match_points?select=player_id,player_name,team_id,position_code' +
    '&competition_id=eq.' + cfg.competition + '&season_id=eq.' + cfg.season +
    '&matchday=eq.' + cfg.matchday + '&order=total_points.desc&limit=5';
  for (const ruta of [base, base + '&is_starter=eq.false']) {
    try {
      const filas = await api(ruta);
      filas.forEach(p => sumar(p.player_id, p.player_name, p.team_id, null, p.position_code));
    } catch (e) {
      console.log('  (no pude leer una de las placas de MVP: ' + e.message.slice(0, 60) + ')');
    }
  }

  // Los 5 mejores de cada partido pedido (placa "Top 5 del partido"): la
  // vista de puntos no tiene game_id, así que se cruza con player_match_stats.
  if (cfg.partidos.length || cfg.top5Todos) {
    try {
      let juegos = cfg.partidos;
      if (cfg.top5Todos) {
        const fx = await api('v_fixtures?select=game_id&competition_id=eq.' + cfg.competition + '&season_id=eq.' + cfg.season + '&matchday=eq.' + cfg.matchday);
        juegos = fx.map(f => f.game_id);
      }
      const pms = await api('player_match_stats?select=game_id,player_id&game_id=in.(' + juegos.join(',') + ')', { headers: { 'Accept-Profile': 'winning_lpf' } });
      const pts = await api('v_fantasy_player_match_points?select=player_id,player_name,team_id,position_code,total_points' +
        '&competition_id=eq.' + cfg.competition + '&season_id=eq.' + cfg.season + '&matchday=eq.' + cfg.matchday);
      const porId = {}; pts.forEach(p => { porId[p.player_id] = p; });
      const porJuego = {};
      pms.forEach(r => { const p = porId[r.player_id]; if (p) (porJuego[r.game_id] = porJuego[r.game_id] || []).push(p); });
      Object.values(porJuego).forEach(lista => lista.sort((a, b) => b.total_points - a.total_points).slice(0, 5)
        .forEach(p => sumar(p.player_id, p.player_name, p.team_id, null, p.position_code)));
      console.log('  Top 5 de ' + Object.keys(porJuego).length + ' partido(s) agregados.');
    } catch (e) {
      console.log('  (no pude leer los Top 5 de los partidos: ' + e.message.slice(0, 80) + ')');
    }
  }

  return out;
}

/* --ids: sólo esos jugadores; nombre y club salen de la vista de puntos del torneo. */
async function jugadoresPorId(cfg) {
  const filas = await api('v_fantasy_player_match_points?select=player_id,player_name,team_id,position_code,matchday' +
    '&competition_id=eq.' + cfg.competition + '&season_id=eq.' + cfg.season + '&player_id=in.(' + cfg.ids.join(',') + ')&order=matchday.desc');
  const equipos = await api('teams?select=id,name,short_name');
  const nombreDeEquipo = {}; equipos.forEach(t => { nombreDeEquipo[t.id] = t.name || t.short_name; });
  const vistos = new Set(), out = [];
  filas.forEach(p => { if (vistos.has(p.player_id)) return; vistos.add(p.player_id);
    out.push({ id: p.player_id, nombre: p.player_name || '', club: nombreDeEquipo[p.team_id] || '', posicion: p.position_code || '' }); });
  return out;
}

// ── Transfermarkt ─────────────────────────────────────────────────────
const sinAcentos = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/* Un club matchea si comparten alguna palabra fuerte: "CA Unión (Santa Fe)"
   contra "Unión", "CA Gimnasia y Esgrima (Mendoza)" contra "Gimnasia (M)". Las
   palabras de relleno no cuentan, si no matchearían todos contra todos. */
const RELLENO = new Set(['ca', 'aa', 'club', 'atletico', 'atlético', 'de', 'del', 'la', 'el',
  'y', 'ii', 'fc', 'cd', 'ac', 'asociacion', 'asociación', 'deportivo', 'sportivo', 'social']);

function palabrasClub(nombre) {
  return sinAcentos(nombre).replace(/[()]/g, ' ').split(/\s+/)
    .filter(w => w.length >= 3 && !RELLENO.has(w));
}

function clubCoincide(nuestro, deTm) {
  const a = new Set(palabrasClub(nuestro));
  const b = palabrasClub(deTm);
  return b.some(w => a.has(w));
}

async function buscarEnTm(page, nombre, intento = 1) {
  // A partir del tercer intento probamos sólo con el apellido: algunos nombres
  // completos devuelven 404 en la búsqueda rápida.
  const consulta = intento >= 3 ? nombre.trim().split(/\s+/).slice(-1)[0] : nombre;
  const url = TM + '/schnellsuche/ergebnis/schnellsuche?query=' + encodeURIComponent(consulta);
  try {
    const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (r.status() !== 200) throw new Error('HTTP ' + r.status());
    return await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('table.items tbody tr').forEach(tr => {
        const a = tr.querySelector('a[href*="/profil/spieler/"]');
        if (!a) return;
        const m = a.href.match(/\/profil\/spieler\/(\d+)/);
        const txt = (tr.innerText || '').replace(/\s+/g, ' ').trim();
        if (!m || txt.length < 15) return;
        if (out.some(o => o.tm === m[1])) return;

        // El club, de su propia celda. Contra el texto entero de la fila no
        // sirve: Transfermarkt en español pone la posición ahí ("Defensa
        // central"), y entonces "Defensa y Justicia" matchea con cualquier
        // defensor de cualquier club.
        const enlaceClub = tr.querySelector('a[href*="/startseite/verein/"], a[href*="/spielplan/verein/"]');
        const escudo = tr.querySelector('img.tiny_wappen, img[src*="/wappen/"]');
        const club = (enlaceClub && enlaceClub.textContent.trim())
          || (escudo && (escudo.title || escudo.alt || '').trim())
          || '';

        out.push({ tm: m[1], nombre: (a.textContent || '').trim(), club, fila: txt, url: a.href });
      });
      return out.slice(0, 6);
    });
  } catch (e) {
    // Los 502/504 son límite de tasa, no bloqueo: aflojando el ritmo entran.
    if (intento <= ESPERA_REINTENTO.length) {
      await dormir(ESPERA_REINTENTO[intento - 1]);
      return buscarEnTm(page, nombre, intento + 1);
    }
    throw e;
  }
}

async function urlDeLaFoto(page, urlPerfil, intento = 1) {
  try {
    const r = await page.goto(urlPerfil, { waitUntil: 'domcontentloaded', timeout: 45000 });
    if (r.status() !== 200) throw new Error('HTTP ' + r.status());
    return await page.evaluate(() => {
      const i = document.querySelector('.data-header__profile-image, img[src*="/portrait/"]');
      return i ? (i.currentSrc || i.src) : null;
    });
  } catch (e) {
    if (intento <= ESPERA_REINTENTO.length) {
      await dormir(ESPERA_REINTENTO[intento - 1]);
      return urlDeLaFoto(page, urlPerfil, intento + 1);
    }
    throw e;
  }
}

/* El CDN de las fotos tiene su propio límite y también tira 504: reintenta
   igual que el resto. */
async function bajarFoto(url, intento = 1) {
  try {
    const r = await fetch(url, { headers: { Referer: TM + '/', 'User-Agent': UA } });
    if (!r.ok) throw new Error('foto HTTP ' + r.status);
    return Buffer.from(await r.arrayBuffer());
  } catch (e) {
    if (intento <= ESPERA_REINTENTO.length) {
      await dormir(ESPERA_REINTENTO[intento - 1]);
      return bajarFoto(url, intento + 1);
    }
    throw e;
  }
}

/* La silueta generica de Transfermarkt es un gris plano: su saturacion media
   ronda 0.007. La foto real MAS gris que bajamos daba 0.227, o sea treinta
   veces mas. Con cortar en 0.08 no hay forma de confundirlas. */
const SATURACION_MINIMA = 0.08;

async function pareceSilueta(png) {
  try {
    const sharp = require('sharp');
    const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const px = info.width * info.height;
    let visibles = 0, suma = 0;
    for (let i = 0; i < px; i++) {
      if (data[i * 4 + 3] < 128) continue;
      visibles++;
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      suma += max === 0 ? 0 : (max - min) / max;
    }
    if (!visibles) return true;
    return (suma / visibles) < SATURACION_MINIMA;
  } catch (e) {
    return false;   // ante la duda la guardamos: es reversible, borrar no
  }
}

// ── Main ──────────────────────────────────────────────────────────────
(async () => {
  const cfg = args();
  if (!cfg.matchday) {
    console.error('Uso: node bajar-fotos.js <fecha> [--comp 384] [--forzar]');
    process.exit(2);
  }

  // --listar: sólo decir a quiénes les falta foto, en una línea que vigilante.js sabe leer.
  if (cfg.listar) {
    const todos = cfg.ids.length ? await jugadoresPorId(cfg) : await jugadoresDeLaFecha(cfg);
    const faltan = todos.filter(j => !fs.existsSync(path.join(DIR_FOTOS, j.id + '.png')));
    console.log('LISTA=' + JSON.stringify(faltan.map(j => ({ id: j.id, nombre: j.nombre }))));
    return;
  }

  const puppeteer = require('puppeteer-core');
  const { removeBackground } = require('@imgly/background-removal-node');

  const chrome = CHROMES.find(p => { try { return fs.existsSync(p); } catch { return false; } });
  if (!chrome) {
    console.error('No encontré Chrome. Poné la ruta en la variable CHROME_PATH.');
    process.exit(2);
  }

  fs.mkdirSync(DIR_FOTOS, { recursive: true });
  fs.mkdirSync(DIR_REVISAR, { recursive: true });

  const torneo = cfg.competition === 724 ? 'Clausura' : 'Apertura';
  console.log(`\n${torneo} ${cfg.season}, fecha ${cfg.matchday}\n`);

  const jugadores = cfg.ids.length ? await jugadoresPorId(cfg) : await jugadoresDeLaFecha(cfg);
  if (!jugadores.length) { console.log('La fecha no tiene pósters todavía.'); return; }

  const pendientes = jugadores.filter(j =>
    cfg.forzar || !fs.existsSync(path.join(DIR_FOTOS, j.id + '.png')));
  console.log(`${jugadores.length} jugadores en los pósters, ${jugadores.length - pendientes.length} ya tienen foto.`);
  if (!pendientes.length) { console.log('No hay nada que bajar.\n'); return; }
  console.log(`Bajando ${pendientes.length}...\n`);

  const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  // Pasar por la home primero para tomar cookies como un visitante normal.
  await page.goto(TM + '/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await dormirEntre(4000, 7000);

  const resultados = [];
  for (const j of pendientes) {
    const fila = { ...j, estado: '', detalle: '', archivo: null };
    try {
      const candidatos = await buscarEnTm(page, j.nombre);
      if (!candidatos.length) throw new Error('sin resultados en Transfermarkt');

      // Si no pudimos leer la celda del club caemos al texto de la fila, pero
      // eso ya no cuenta como confirmado.
      const conClub = candidatos.filter(c => c.club && clubCoincide(j.club, c.club));
      const elegido = conClub[0] || candidatos[0];
      const seguro = conClub.length === 1;
      fila.detalle = (elegido.club ? elegido.club + " — " : "") + elegido.fila.slice(0, 70);
      fila.clubTm = elegido.club;
      fila.tm = elegido.tm;

      await dormirEntre(6000, 10000);
      const urlFoto = await urlDeLaFoto(page, elegido.url);
      if (!urlFoto) throw new Error('el perfil no tiene foto');

      const jpg = await bajarFoto(urlFoto);
      const tmp = path.join(DIR_REVISAR, j.id + '.tmp.jpg');
      fs.writeFileSync(tmp, jpg);

      const blob = await removeBackground(pathToFileURL(tmp).href, { publicPath: MODELO_FONDO });
      const png = Buffer.from(await blob.arrayBuffer());
      fs.unlinkSync(tmp);

      // Transfermarkt no tiene foto de todos: para esos devuelve una silueta
      // gris. Guardarla es peor que dejar el marco vacio.
      if (await pareceSilueta(png)) {
        fila.estado = 'sin foto';
        fila.detalle = 'Transfermarkt no tiene foto de este jugador';
        console.log(`  sin foto ${j.nombre.padEnd(23)} Transfermarkt no tiene su foto`);
        resultados.push(fila);
        await dormirEntre(12000, 20000);
        continue;
      }

      // Sin confirmación de club la foto no entra a las placas: queda aparte
      // para que la mires. Traer al jugador equivocado es peor que no traerlo.
      const destino = seguro ? DIR_FOTOS : DIR_REVISAR;
      fs.writeFileSync(path.join(destino, j.id + '.png'), png);
      fila.archivo = path.relative(DIR_FOTOS, path.join(destino, j.id + '.png')).replace(/\\/g, '/');
      fila.estado = seguro ? 'ok' : 'revisar';
      console.log(`  ${seguro ? 'ok     ' : 'REVISAR'} ${j.nombre.padEnd(24)} ${fila.detalle.slice(0, 60)}`);
    } catch (e) {
      fila.estado = 'falló';
      fila.detalle = e.message.slice(0, 90);
      console.log(`  falló   ${j.nombre.padEnd(24)} ${fila.detalle}`);
    }
    resultados.push(fila);
    await dormirEntre(12000, 20000);   // ritmo tranquilo: es el sitio de otro
  }
  await browser.close();

  escribirHojaDeContacto(resultados, cfg, torneo);

  const n = e => resultados.filter(r => r.estado === e).length;
  console.log(`\n${n('ok')} listas, ${n('revisar')} para revisar, ${n('sin foto')} sin foto en Transfermarkt, ${n('falló')} fallaron.`);
  if (n('revisar')) {
    console.log(`Las de "revisar" están en fotos/_revisar/ y NO salen en las placas.`);
    console.log(`Miralas en fotos/revisar.html y movelas a fotos/ las que estén bien.`);
  }
  console.log('');
})().catch(e => { console.error('\nError: ' + e.message); process.exit(1); });

// ── Hoja de contacto ──────────────────────────────────────────────────
function escribirHojaDeContacto(resultados, cfg, torneo) {
  const esc = s => String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const tarjeta = r => `
    <figure class="c ${r.estado}">
      ${r.archivo ? `<img src="${esc(r.archivo)}" alt="">` : '<div class="sin"></div>'}
      <figcaption>
        <b>${esc(r.nombre)}</b>
        <span>${esc(r.club)} · ${esc(r.posicion)}</span>
        <span class="e">${esc(r.estado)}${r.tm ? ' · tm ' + esc(r.tm) : ''}</span>
        <span class="d">${esc(r.detalle)}</span>
      </figcaption>
    </figure>`;

  const html = `<!doctype html><meta charset="utf-8">
<title>Fotos — ${torneo} fecha ${cfg.matchday}</title>
<style>
  body { background:#111; color:#eee; font:14px/1.5 system-ui,sans-serif; margin:24px; }
  h1 { font-size:18px; color:#92B1DC; }
  p { color:#888; max-width:70ch; }
  .g { display:flex; flex-wrap:wrap; gap:16px; margin-top:20px; }
  .c { margin:0; width:190px; background:#1b1b24; border-radius:8px; overflow:hidden; border:2px solid #333; }
  .c.ok { border-color:#2f6b41; }
  .c.revisar { border-color:#EAB939; }
  .c\\.falló, .c.falló { border-color:#7a3030; }
  .c img, .c .sin { display:block; width:190px; height:190px; object-fit:contain;
    background:repeating-conic-gradient(#2a2a2a 0 25%, #232323 0 50%) 0 0/20px 20px; }
  figcaption { padding:8px 10px; display:flex; flex-direction:column; gap:2px; }
  figcaption b { font-size:13px; }
  figcaption span { font-size:11px; color:#888; }
  figcaption .e { color:#92B1DC; text-transform:uppercase; letter-spacing:.4px; }
  figcaption .d { color:#666; }
</style>
<h1>Fotos bajadas — ${torneo} ${cfg.season}, fecha ${cfg.matchday}</h1>
<p>Fondo cuadriculado = transparencia. Las marcadas <b>revisar</b> están en
<code>fotos/_revisar/</code> y todavía no salen en las placas: si es el jugador
correcto, movelas a <code>fotos/</code>.</p>
<div class="g">${resultados.map(tarjeta).join('')}</div>`;

  fs.writeFileSync(path.join(DIR_FOTOS, 'revisar.html'), html);
}
