#!/usr/bin/env node
/**
 * publicar-auto.js — publica solo, en el momento del posteo, sin que nadie
 * toque nada. Lo lanza tools/vigilante.js según lo que esté prendido en
 * publicar.json (que Luchi prende y apaga desde la página del Recap).
 *
 *   node publicar-auto.js cierre <fecha>                    [--redes ig,x] [--probar]
 *   node publicar-auto.js dia    <fecha> --dia 2026-09-19   [--redes ig,x] [--probar]
 *   node publicar-auto.js pitazo <fecha> --game 2614498     [--redes ig,x] [--probar]
 *
 *   cierre  al cierre de puntajes: carrusel 11 Ideal + Ganadores + MVPs de la
 *           fecha, con el caption 1 del 11 Ideal (completo en Instagram, la
 *           versión de 280 en X). Si captions.json todavía no tiene la fecha,
 *           va sólo el título.
 *   dia     al terminar el último partido del día: la placa de MVPs del día.
 *   pitazo  al terminar un partido: la placa de resultado (diseño "nuevas",
 *           con la foto del partido si el vigilante ya la encontró).
 *
 * Cada red se publica por separado (--redes ig o --redes x) para que el
 * vigilante anote cada una y nunca repita un posteo. Facebook va pegado a
 * Instagram (si están sus claves). Sin --redes publica en las dos.
 */

const fs = require('fs');
const path = require('path');
const redes = require('./redes.js');

const { COMPETITION, SEASON, RAIZ } = redes;
const TORNEO = 'CLAUSURA 2026';
const SUPABASE_URL = 'https://ketwxvbrhqbemlflmadu.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtldHd4dmJyaHFiZW1sZmxtYWR1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4NjA4MDcsImV4cCI6MjA4NjQzNjgwN30.-qXPLMSFEiRORNk5EUKrD16VDiMXtv-VfcDSWpzWzsg';
const DIAS = ['DOMINGO', 'LUNES', 'MARTES', 'MIÉRCOLES', 'JUEVES', 'VIERNES', 'SÁBADO'];   // igual que MV_DIAS en index.html

const log = m => console.log('[publicar-auto] ' + m);
const sinAcentos = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function argumentos() {
  const a = process.argv.slice(2);
  const val = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  return { momento: a[0], md: Number(a[1]), dia: val('--dia'), game: val('--game'), redes: (val('--redes') || 'ig,x').split(',').map(s => s.trim()).filter(Boolean), probar: a.includes('--probar') };
}

async function recap(md) {
  const r = await fetch(SUPABASE_URL + '/rest/v1/rpc/get_matchday_recap', { method: 'POST', headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ p_competition_id: COMPETITION, p_season_id: SEASON, p_matchday: md }) });
  if (!r.ok) throw new Error('get_matchday_recap -> HTTP ' + r.status);
  return r.json();
}

/* Qué placas y qué textos van en cada momento. */
async function armar(momento, md, opciones) {
  if (momento === 'cierre') {
    let ideal = null;
    try { ideal = ((JSON.parse(fs.readFileSync(path.join(RAIZ, 'captions.json'), 'utf8'))[`${COMPETITION}-${SEASON}-${md}`] || {}).ideal || [])[0] || null; } catch (e) { /* sin captions.json */ }
    const titulo = `🔥 11 IDEAL — FECHA ${md} | ${TORNEO}`;
    return {
      archivos: ['equipo_ideal_fecha' + md, 'ganadores_fecha' + md, 'mvps_fecha' + md],
      ig: (ideal && ideal.texto) || titulo,
      x: (ideal && ideal.texto_x) || titulo,
      nombre: 'cierre-fecha' + md,
    };
  }
  if (momento === 'dia') {
    if (!opciones.dia) throw new Error('falta --dia YYYY-MM-DD');
    const nombreDia = DIAS[new Date(opciones.dia + 'T12:00:00Z').getUTCDay()];
    const texto = `🏅 MVPs DEL ${nombreDia} — FECHA ${md} | ${TORNEO}\n\nLos cinco que más puntos hicieron en Winning en los partidos del ${nombreDia.toLowerCase()}.`;
    return { archivos: ['mvps_f' + md + '_' + sinAcentos(nombreDia)], ig: texto, x: texto, nombre: 'dia-' + opciones.dia };
  }
  if (momento === 'pitazo') {
    if (!opciones.game) throw new Error('falta --game <id>');
    const d = await recap(md);
    const m = (d.matches || []).find(x => String(x.game_id) === String(opciones.game));
    if (!m) throw new Error('el partido ' + opciones.game + ' no está en la fecha ' + md);
    const texto = `⚽ FINAL — FECHA ${md} | ${TORNEO}\n\n${m.home_team.name} ${m.home_score}-${m.away_score} ${m.away_team.name}`;
    return { archivos: [`resultado_f${md}_${m.home_team.short_name}_vs_${m.away_team.short_name}`], ig: texto, x: texto, nombre: 'pitazo-' + opciones.game, game: opciones.game };
  }
  throw new Error('momento desconocido: ' + momento + ' (cierre, dia o pitazo)');
}

(async () => {
  const { momento, md, dia, game, redes: cuales, probar } = argumentos();
  if (!momento || !md) { console.error('uso: node publicar-auto.js <cierre|dia|pitazo> <fecha> [--dia YYYY-MM-DD] [--game id] [--redes ig,x] [--probar]'); process.exit(2); }
  let fallo = false;
  try {
    const plan = await armar(momento, md, { dia, game });
    log(`${momento}, fecha ${md}: ${plan.archivos.join(' + ')} → ${cuales.join(' y ')}`);
    const jpgs = await redes.imagenes(md, plan.archivos, plan.game ? { game: plan.game, diseno: 'nuevas' } : {});
    jpgs.forEach((j, i) => fs.writeFileSync(path.join(RAIZ, 'captions', `auto-${plan.nombre}-${i + 1}.jpg`), j));
    if (probar) { log('modo prueba: no se publica.\n--- Instagram:\n' + plan.ig + '\n--- X:\n' + plan.x); return; }

    if (cuales.includes('x')) {
      try { log('publicado en X: ' + await redes.publicarX(plan.x, jpgs)); }
      catch (e) { fallo = true; console.error('[publicar-auto] X falló: ' + (e.data ? JSON.stringify(e.data) : e.message)); }
    }
    if (cuales.includes('ig')) {
      try {
        const urls = jpgs.map((j, i) => redes.subirS3(j, `auto-${plan.nombre}-${i + 1}-${Date.now()}.jpg`).url);
        log('publicado en Instagram: ' + await redes.publicarInstagram(plan.ig, urls));
        try { const fb = await redes.publicarFacebook(plan.ig, urls); log(fb ? 'publicado en Facebook: ' + fb : 'Facebook: sin claves, no se publica ahí'); }
        catch (e) { console.log('::warning::Facebook falló: ' + e.message); }
      } catch (e) { fallo = true; console.error('[publicar-auto] Instagram falló: ' + e.message); }
    }
  } catch (e) {
    fallo = true;
    console.error('[publicar-auto] ' + (e.message || e));
  }
  process.exit(fallo ? 1 : 0);
})();
