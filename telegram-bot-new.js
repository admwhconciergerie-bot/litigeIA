const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const https = require('https');
const crypto = require('crypto');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROUP_ID = process.env.TELEGRAM_GROUP_ID || '-606738403';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const PASSPASS_EMAIL = process.env.PASSPASS_EMAIL;
const PASSPASS_PASSWORD = process.env.PASSPASS_PASSWORD;
const FIREBASE_PROJECT = 'passpass';
const FIREBASE_API_KEY = 'AIzaSyBvLr6wKVpvdS5nH8LpZjD5YWzG3tKGLKk';

const WINDOW_MS = 45000;

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  console.log('Bot Telegram desactive');
  module.exports = {};
} else {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const bot = new TelegramBot(BOT_TOKEN, { polling: true });
  console.log('Bot Telegram WH demarre - groupe', GROUP_ID);

  const buffer = {};

  function fuzzyMatch(str1, str2) {
    const s1 = (str1 || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const s2 = (str2 || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!s1 || !s2) return 0;
    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;
    const dist = levenshteinDistance(longer, shorter);
    return (longer.length - dist) / longer.length;
  }

  function levenshteinDistance(s1, s2) {
    const costs = [];
    for (let i = 0; i <= s1.length; i++) {
      let lastValue = i;
      for (let j = 0; j <= s2.length; j++) {
        if (i === 0) costs[j] = j;
        else if (j > 0) {
          let newValue = costs[j - 1];
          if (s1[i-1] !== s2[j-1]) newValue = Math.min(newValue, lastValue, costs[j]) + 1;
          costs[j - 1] = lastValue;
          lastValue = newValue;
        }
      }
      if (i > 0) costs[s2.length] = lastValue;
    }
    return costs[s2.length];
  }

  async function getFirebaseToken() {
    return new Promise(resolve => {
      const body = JSON.stringify({ email: PASSPASS_EMAIL, password: PASSPASS_PASSWORD, returnSecureToken: true });
      const req = https.request({
        hostname: 'identitytoolkit.googleapis.com',
        path: '/v1/accounts:signInWithPassword?key=' + FIREBASE_API_KEY,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.idToken) { console.log('Firebase PassPass: connecte'); resolve(json.idToken); }
            else { resolve(null); }
          } catch(e) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.write(body);
      req.end();
    });
  }

  async function chercherReservationPassPass(logement, date) {
    if (!logement) return null;
    try {
      const token = await getFirebaseToken();
      if (!token) return null;

      const doQuery = query => new Promise(res => {
        const body = JSON.stringify(query);
        const req = https.request({
          hostname: 'firestore.googleapis.com',
          path: `/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents:runQuery`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }
        }, response => {
          let data = '';
          response.on('data', c => data += c);
          response.on('end', () => {
            try {
              const lines = data.trim().split('\n');
              const arr = [];
              for (const line of lines) {
                try {
                  const json = JSON.parse(line);
                  if (json.document?.fields) {
                    const f = json.document.fields;
                    arr.push({
                      prop: f.prop?.stringValue || '',
                      tenantName: [f.tenantInfo?.mapValue?.fields?.prenom?.stringValue, f.tenantInfo?.mapValue?.fields?.nom?.stringValue].filter(Boolean).join(' '),
                      start: f.start?.stringValue || '',
                      end: f.end?.stringValue || ''
                    });
                  }
                } catch(e) {}
              }
              res(arr);
            } catch(e) { res([]); }
          });
        });
        req.on('error', () => res([]));
        req.write(body);
        req.end();
      });

      // Checkout d'abord
      const checkoutBooks = await doQuery({
        structuredQuery: {
          from: [{ collectionId: 'bookings' }],
          where: { fieldFilter: { field: { fieldPath: 'end' }, op: 'EQUAL', value: { stringValue: date } } }
        }
      });

      // Puis active
      const activeBooks = await doQuery({
        structuredQuery: {
          from: [{ collectionId: 'bookings' }],
          where: {
            compositeFilter: {
              op: 'AND',
              filters: [
                { fieldFilter: { field: { fieldPath: 'start' }, op: 'LESS_THAN_OR_EQUAL', value: { stringValue: date } } },
                { fieldFilter: { field: { fieldPath: 'end' }, op: 'GREATER_THAN', value: { stringValue: date } } }
              ]
            }
          }
        }
      });

      const allBooks = [...checkoutBooks, ...activeBooks];
      if (allBooks.length === 0) return null;

      let best = null, bestScore = 0.6;
      for (const b of allBooks) {
        const score = fuzzyMatch(logement, b.prop);
        if (score > bestScore) { bestScore = score; best = b; }
      }

      if (best) { console.log('PassPass MATCH:', best.tenantName, '|', best.start, '→', best.end); return best; }
      return null;
    } catch(e) { return null; }
  }

  async function fileIdToUrl(fileId) {
    return new Promise(resolve => {
      https.request({ hostname: 'api.telegram.org', path: '/bot' + BOT_TOKEN + '/getFile?file_id=' + fileId, method: 'GET' }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const j = JSON.parse(d);
            resolve(j.ok && j.result?.file_path ? 'https://api.telegram.org/file/bot' + BOT_TOKEN + '/' + j.result.file_path : null);
          } catch(e) { resolve(null); }
        });
      }).on('error', () => resolve(null)).end();
    });
  }

  async function downloadBase64(url) {
    return new Promise(resolve => {
      https.get(url, res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => { try { resolve(Buffer.concat(chunks).toString('base64')); } catch(e) { resolve(null); } });
      }).on('error', () => resolve(null));
    });
  }

  async function analyserPhotos(photoUrls, texteCaption) {
    if (!ANTHROPIC_KEY || !photoUrls.length) return null;
    const imageContents = [];
    for (const url of photoUrls.slice(0, 4)) {
      const b64 = await downloadBase64(url);
      if (b64) imageContents.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } });
    }
    if (!imageContents.length) return null;
    const prompt = 'Tu analyses des photos de logement meuble. Identifie: 1) type_sinistre (Nettoyage, Tabac, Degradation, Dommages eau, Autre). 2) description (150 mots). 3) logement si visible. Reponds JSON: {"type_sinistre":"...","description":"...","logement":null}';
    imageContents.push({ type: 'text', text: prompt });
    return new Promise(resolve => {
      const body = JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 300, messages: [{ role: 'user', content: imageContents }] });
      https.request({ hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' } }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const j = JSON.parse(d);
            if (j.error) { resolve(null); return; }
            const m = (j.content?.[0]?.text || '').match(/\{[\s\S]*\}/);
            resolve(m ? JSON.parse(m[0]) : null);
          } catch(e) { resolve(null); }
        });
      }).on('error', () => resolve(null)).write(body).end();
    });
  }

  async function extraireLogement(txt) {
    if (!OPENROUTER_KEY || !txt) return null;
    return new Promise(resolve => {
      const body = JSON.stringify({ model: 'meta-llama/llama-3.3-70b-instruct:free', messages: [{ role: 'user', content: 'Extrait nom logement. Juste le nom. NULL sinon.\n"' + txt + '"' }], max_tokens: 30 });
      https.request({ hostname: 'openrouter.ai', path: '/api/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENROUTER_KEY, 'HTTP-Referer': 'https://litigeia.onrender.com' } }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const j = JSON.parse(d);
            const r = (j.choices?.[0]?.message?.content || '').trim();
            resolve(r === 'NULL' || r === '' ? null : r);
          } catch(e) { resolve(null); }
        });
      }).on('error', () => resolve(null)).write(body).end();
    });
  }

  function extraireLogementSimple(txt) {
    const m = txt?.match(/\b([A-Z][A-Z0-9\s\-]{2,30}(?:\s+\d{4,5})?)\b/);
    return m ? m[1].trim() : null;
  }

  async function sauver(logement, description, typeSinistre, photos, firstMsg) {
    const today = new Date().toISOString().split('T')[0];
    const { data: stateRow, error: readErr } = await supabase.from('app_state').select('data').eq('id', 'main').single();
    if (readErr || !stateRow) { console.error('Erreur app_state'); return null; }

    const state = stateRow.data || { config: {}, properties: [], litiges: [] };
    if (!state.litiges) state.litiges = [];

    let passpassBooking = null, guest_name = '', checkin = '', checkout = '';
    if (logement) {
      passpassBooking = await chercherReservationPassPass(logement, today);
      if (passpassBooking) {
        guest_name = passpassBooking.tenantName || '';
        checkin = passpassBooking.start || '';
        checkout = passpassBooking.end || '';
      }
    }

    const newLitige = {
      id: crypto.randomUUID(),
      platform: 'Telegram',
      property_id: '',
      logement: logement || '',
      guest_name: guest_name,
      guest_email: '',
      booking_ref: '',
      checkin: checkin,
      checkout: checkout,
      constat_date: today,
      description: description || '',
      notes: 'Signalement Telegram' + (firstMsg.from.username ? ' @' + firstMsg.from.username : '') + (passpassBooking ? ' [PassPass auto-match]' : ''),
      caution: 0,
      articles: [],
      total_ht: 0, total_tva: 0, total_ttc: 0,
      photos: photos || [],
      resume: (typeSinistre || 'Constat') + (logement ? ' - ' + logement : ''),
      gravite: '',
      lettre: '',
      status: 'new',
      created_at: new Date().toISOString()
    };

    state.litiges.push(newLitige);
    const { error: writeErr } = await supabase.from('app_state').upsert({ id: 'main', data: state, updated_at: new Date().toISOString() });
    if (writeErr) { console.error('Erreur ecriture'); return null; }
    console.log('Litige cree:', newLitige.id, '| logement:', logement, '| guest:', guest_name, '| photos:', photos.length);
    return newLitige;
  }

  async function finaliserBuffer(userId) {
    const entry = buffer[userId];
    if (!entry) return;
    delete buffer[userId];

    const texte = entry.texts.join('\n').trim();
    const photoUrls = (await Promise.all(entry.photos.map(id => fileIdToUrl(id)))).filter(Boolean);

    let logement = null;
    if (texte && texte.length > 0 && texte.length <= 50) { logement = texte.trim(); console.log('Logement:', logement); }

    let description = texte || '', typeSinistre = 'Constat terrain';
    if (photoUrls.length) {
      const analyse = await analyserPhotos(photoUrls, texte);
      if (analyse) {
        if (analyse.type_sinistre) typeSinistre = analyse.type_sinistre;
        if (analyse.description) description = analyse.description + (texte ? '\n\n' + texte : '');
        if (analyse.logement && !logement) logement = analyse.logement;
      }
    }

    if (!logement && texte?.length > 50) {
      logement = await extraireLogement(texte);
      if (!logement) logement = extraireLogementSimple(texte);
    }

    await sauver(logement, description, typeSinistre, photoUrls, entry.firstMsg);
  }

  async function traiterMessage(msg) {
    if (msg.chat.id.toString() !== GROUP_ID) return;
    if (msg.text?.startsWith('/')) return;

    const userId = msg.from.id, texte = msg.text || msg.caption || '', photos = [];
    if (msg.photo?.length) photos.push(msg.photo[msg.photo.length - 1].file_id);

    if (!buffer[userId]) buffer[userId] = { texts: [], photos: [], firstMsg: msg, timer: null };
    if (texte) buffer[userId].texts.push(texte);
    buffer[userId].photos.push(...photos);

    if (buffer[userId].timer) clearTimeout(buffer[userId].timer);
    buffer[userId].timer = setTimeout(() => finaliserBuffer(userId), WINDOW_MS);
  }

  bot.on('message', traiterMessage);
  bot.on('polling_error', err => console.error('Polling error:', err.message));
}
