// Cuánto venimos gastando de la API de X: tuits leídos por día (últimos N días) según X.
//   node tools/uso-x.js [días, default 30]
// Usa el token de app (X_API_KEY + X_API_SECRET); el endpoint de uso no acepta el de usuario.
const dias = Math.min(90, Math.max(1, parseInt(process.argv[2] || '30', 10)));

async function main() {
  const { X_API_KEY, X_API_SECRET } = process.env;
  if (!X_API_KEY || !X_API_SECRET) throw new Error('faltan X_API_KEY y X_API_SECRET');
  const basic = Buffer.from(`${encodeURIComponent(X_API_KEY)}:${encodeURIComponent(X_API_SECRET)}`).toString('base64');
  const tok = await fetch('https://api.x.com/oauth2/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: 'grant_type=client_credentials',
  }).then(r => r.json());
  if (!tok.access_token) throw new Error('no me dio el token de app: ' + JSON.stringify(tok));

  const r = await fetch(`https://api.x.com/2/usage/tweets?days=${dias}&usage.fields=daily_project_usage,daily_client_app_usage`, {
    headers: { Authorization: `Bearer ${tok.access_token}` },
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(j)}`);
  const d = j.data || {};
  console.log('USO ' + JSON.stringify({ project_usage: d.project_usage, project_cap: d.project_cap, cap_reset_day: d.cap_reset_day }));
  for (const u of (d.daily_project_usage && d.daily_project_usage.usage) || []) {
    if (+u.usage) console.log(`DIA ${String(u.date).slice(0, 10)} ${u.usage} tuits leídos`);
  }
  console.log('# respuesta completa: ' + JSON.stringify(j));
}

main().catch(e => { console.error('ERROR ' + e.message); process.exit(1); });
