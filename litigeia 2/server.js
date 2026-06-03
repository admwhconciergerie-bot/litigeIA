const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Supabase client
const _supa = (process.env.SUPABASE_URL && process.env.SUPABASE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY) : null;
const DEFAULT_STATE = { config: { apiKey: '', ownerName: '', siret: '', address: '', phone: '', email: '', iban: '' }, properties: [], litiges: [] };

// GET /api/state
app.get('/api/state', async (req, res) => {
  if (!_supa) return res.json(DEFAULT_STATE);
  try {
    const { data, error } = await _supa.from('app_state').select('data').eq('id', 'main').single();
    if (error || !data) return res.json(DEFAULT_STATE);
    res.json(data.data || DEFAULT_STATE);
  } catch(e) { res.json(DEFAULT_STATE); }
});

// POST /api/state
app.post('/api/state', async (req, res) => {
  if (!_supa) return res.json({ ok: true });
  try {
    const { error } = await _supa.from('app_state').upsert({ id: 'main', data: req.body, updated_at: new Date().toISOString() });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Proxy image — permet au navigateur de charger des images Telegram (CORS + token bot)
app.get('/api/proxy-image', async (req, res) => {
let url = req.query.url;
if (!url) return res.status(400).json({ error: 'Missing url' });
try {
  // Si c'est un file_id Telegram (pas une URL http), on résout d'abord
  if (!url.startsWith('http')) {
    const tok = process.env.TELEGRAM_BOT_TOKEN;
    if (!tok) return res.status(400).json({ error: 'No bot token' });
    const meta = await fetch('https://api.telegram.org/bot'+tok+'/getFile?file_id='+encodeURIComponent(url));
    const mj = await meta.json();
    if (!mj.ok || !mj.result?.file_path) return res.status(404).json({ error: 'File not found' });
    url = 'https://api.telegram.org/file/bot'+tok+'/'+mj.result.file_path;
  }
  const r = await fetch(url);
  if (!r.ok) return res.status(r.status).end();
  const buf = Buffer.from(await r.arrayBuffer());
  res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
  res.set('Cache-Control', 'private, max-age=300');
  res.send(buf);
} catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/analyze', async (req, res) => {
const key = process.env.OPENROUTER_API_KEY;
if (!key) return res.status(500).json({ error: 'OPENROUTER_API_KEY manquante' });

const messages = req.body.messages || [];
const system = req.body.system || '';

const hasImages = messages.some(m =>
  (Array.isArray(m.content) ? m.content : []).some(c => c.type === 'image' || c.type === 'image_url')
);

const oaMsgs = [];
if (system) oaMsgs.push({ role: 'system', content: system });
for (const msg of messages) {
  const parts = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: String(msg.content || '') }];
  const content = parts.map(p => {
    if (p.type === 'text') return { type: 'text', text: p.text };
    if (p.type === 'image' && p.source && p.source.type === 'base64')
      return { type: 'image_url', image_url: { url: 'data:' + (p.source.media_type || 'image/jpeg') + ';base64,' + p.source.data } };
    if (p.type === 'image_url') return p;
    return { type: 'text', text: JSON.stringify(p) };
  });
  oaMsgs.push({ role: msg.role || 'user', content: content.length === 1 && content[0].type === 'text' ? content[0].text : content });
}

const visionModels = [
  'openrouter/free',
  'moonshotai/kimi-k2.6:free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-nano-12b-v2-vl:free'
];
const textModels = [
  'openrouter/free',
  'moonshotai/kimi-k2.6:free',
  'google/gemma-4-31b-it:free',
  'qwen/qwen3-next-80b-a3b-instruct:free',
  'meta-llama/llama-3.3-70b-instruct:free'
];
const models = hasImages ? visionModels : textModels;

let lastErr = 'Aucun modele disponible';
for (const model of models) {
  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key,
        'HTTP-Referer': 'https://litigeia.onrender.com', 'X-Title': 'LitigeIA' },
      body: JSON.stringify({ model, messages: oaMsgs, max_tokens: 1000 })
    });
    const data = await r.json();
    const errMsg = (data.error && data.error.message) || '';
    if (!r.ok || errMsg.toLowerCase().includes('provider') || errMsg.includes('endpoint')) {
      lastErr = model + ': ' + errMsg;
      continue;
    }
    const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    return res.json({ content: [{ type: 'text', text }], usage: {} });
  } catch(e) { lastErr = model + ': ' + e.message; }
}
res.status(500).json({ error: lastErr });
});

// Firebase PassPass helpers (inline)
const FIREBASE_CONFIG = {apiKey:'AIzaSyCffkmTqLa241aKYMg6l_neYrU8vT3RG38',authDomain:'passpass-web-public.firebaseapp.com',projectId:'passpass-web-public'};
let _fbApp=null,_fbDb=null,_fbAuth=false;
async function initFB() {
  if (_fbDb) return true;
  const em=process.env.PASSPASS_EMAIL,pw=process.env.PASSPASS_PASSWORD;
  if (!em||!pw) return false;
  try {
    const {initializeApp}=require('firebase/app');
    const {getFirestore,collection,query,where,getDocs}=require('firebase/firestore');
    const {getAuth,signInWithEmailAndPassword}=require('firebase/auth');
    if (!_fbApp) _fbApp=initializeApp(FIREBASE_CONFIG,'pp');
    if (!_fbAuth) { await signInWithEmailAndPassword(getAuth(_fbApp),em,pw); _fbAuth=true; }
    _fbDb=getFirestore(_fbApp);
    return true;
  } catch(e){console.error('FB init:',e.message);return false;}
}
async function queryBookings(propId,date) {
  if (!await initFB()) return {found:false,error:'Firebase non connecté (variables PASSPASS_EMAIL/PASSWORD manquantes?)'};
  const {collection,query,where,getDocs}=require('firebase/firestore');
  const snap=await getDocs(query(collection(_fbDb,'bookings'),where('prop','==',propId)));
  let doc=snap.docs.find(d=>{const b=d.data();return !b.deleted&&b.end===date&&b.start<date;});
  if (!doc) doc=snap.docs.find(d=>{const b=d.data();return !b.deleted&&b.start<=date&&b.end>date;});
  if (!doc) return {found:false};
  const b=doc.data(),ti=b.tenantInfo||{};
  const clean=s=>(s||'').replace(/[\u2068\u2069]/g,'').trim();
  const plat=(b.platform||'Airbnb'); 
  return {found:true,guest_name:[clean(ti.prenom),clean(ti.nom)].filter(s=>s&&s!=='.').join(' ').trim(),guest_email:ti.email||'',platform:plat.charAt(0).toUpperCase()+plat.slice(1).toLowerCase(),booking_ref:b.codeRef||'',checkin:b.start||'',checkout:b.end||''};
}

// GET /api/passpass-lookup
app.get('/api/passpass-lookup', async (req,res) => {
  const {propId,date}=req.query;
  if (!propId||!date) return res.status(400).json({error:'propId et date requis'});
  try { res.json(await queryBookings(propId,date)); }
  catch(e){ res.status(500).json({error:e.message}); }
});

// GET /api/passpass-properties — liste tous les IDs de propriétés PassPass (pour configuration)
app.get('/api/passpass-properties', async (req,res) => {
  try {
    if (!await initFB()) return res.json({error:'Firebase non connecté',props:[]});
    const {collection,getDocs,query,orderBy,limit}=require('firebase/firestore');
    const snap=await getDocs(query(collection(_fbDb,'bookings'),limit(200)));
    const props={};
    snap.docs.forEach(d=>{const b=d.data();if(b.prop&&b.propName) props[b.prop]=b.propName; else if(b.prop) props[b.prop]=props[b.prop]||b.prop;});
    res.json({props:Object.entries(props).map(([id,name])=>({id,name}))});
  } catch(e){ res.status(500).json({error:e.message,props:[]}); }
});


app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('OK port ' + PORT));

// Demarrer le bot Telegram
require('./telegram-bot');
