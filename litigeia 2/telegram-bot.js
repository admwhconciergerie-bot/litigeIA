/*
 * WH Conciergerie - Bot Telegram Constats
 * Les messages du meme utilisateur dans une fenetre de 45s sont groupes en 1 litige.
 * Aucun message de confirmation n'est envoye dans le groupe.
 * Les litiges sont crees directement dans app_state (LitigeIA).
 * La legende courte (<=50 chars, pas une date) = nom du logement.
 * Claude Vision analyse les photos pour detecter le type de sinistre.
 * AUTO-MATCH PassPass: authentifie avec email/password et accede a Firestore (passpass).
 */
const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const https = require('https');
const crypto = require('crypto');

const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const GROUP_ID       = process.env.TELEGRAM_GROUP_ID  || '-606738403';
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_KEY;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;

// PassPass / Firebase
const PASSPASS_EMAIL    = process.env.PASSPASS_EMAIL;
const PASSPASS_PASSWORD = process.env.PASSPASS_PASSWORD;
const FIREBASE_PROJECT  = 'passpass';
const FIREBASE_API_KEY  = 'AIzaSyBvLr6wKVpvdS5nH8LpZjD5YWzG3tKGLKk'; // Public API key (visible en public)

// Fenetre de groupage : 45 secondes
const WINDOW_MS = 45000;

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  console.log('Bot Telegram desactive (variables manquantes)');
  module.exports = {};
} else {
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  const bot = new TelegramBot(BOT_TOKEN, { polling: true });
  console.log('Bot Telegram WH demarre - groupe', GROUP_ID);

  // Buffer : { userId: { texts: [], photos: [], firstMsg, timer } }
  const buffer = {};

  // ==================== PassPass / Firestore ====================
  /**
   * Authentifie avec Firebase (email/password) et retourne un token ID
   */
  async function getFirebaseToken() {
    return new Promise((resolve) => {
      const body = JSON.stringify({
        email: PASSPASS_EMAIL,
        password: PASSPASS_PASSWORD,
        returnSecureToken: true
      });

      const req = https.request({
        hostname: 'identitytoolkit.googleapis.com',
        path: '/v1/accounts:signInWithPassword?key=' + FIREBASE_API_KEY,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error) {
              console.error('Firebase auth error:', json.error.message);
              resolve(null);
            } else if (json.idToken) {
              resolve(json.idToken);
            } else {
              resolve(null);
            }
          } catch (e) {
            console.error('Firebase auth parse error:', e.message);
            resolve(null);
          }
        });
      });

      req.on('error', (e) => {
        console.error('Firebase auth request error:', e.message);
        resolve(null);
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * Query Firestore avec token d'authentification
   * Cherche une rÃ©servation par property_id et date (deux passes)
   */
  async function chercherReservationPassPass(logement, date) {
  if (!logement || !PASSPASS_EMAIL || !PASSPASS_PASSWORD) {
    console.log('PassPass: missing config');
    return null;
  }
  try {
    const token = await getFirebaseToken();
    if (!token) { console.log('PassPass: auth failed'); return null; }

    const normalize = s => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
    const logNorm = normalize(logement);

    const queryAndMatch = (whereClause, label) => new Promise(res => {
      const body = JSON.stringify({ structuredQuery: { from: [{ collectionId: 'bookings' }], where: whereClause, limit: 50 } });
      const req = https.request({
        hostname: 'firestore.googleapis.com',
        path: '/v1/projects/' + FIREBASE_PROJECT + '/databases/(default)/documents:runQuery',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, 'Content-Length': Buffer.byteLength(body) }
      }, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
          try {
            const docs = JSON.parse(data);
            const found = (Array.isArray(docs) ? docs : []).find(item => {
              if (!item.document || !item.document.fields) return false;
              const f = item.document.fields;
              const propName = normalize(f.propName && f.propName.stringValue || '');
              return propName.includes(logNorm) || logNorm.includes(propName.split(' ')[0]) || propName.split(' ')[0] === logNorm;
            });
            if (!found) { res(null); return; }
            const f = found.document.fields;
            const ti = f.tenantInfo && f.tenantInfo.mapValue && f.tenantInfo.mapValue.fields || {};
            res({
              tenantName: [(ti.prenom && ti.prenom.stringValue || ''), (ti.nom && ti.nom.stringValue || '')].filter(Boolean).join(' '),
              tenantEmail: (ti.email && ti.email.stringValue || ''),
              start: (f.start && f.start.stringValue || ''),
              end: (f.end && f.end.stringValue || '')
            });
          } catch(e) { console.error('PassPass parse error:', e.message); res(null); }
        });
      });
      req.on('error', e => { console.error('PassPass req error:', e.message); res(null); });
      req.write(body); req.end();
    });

    // Passe 1: checkout aujourd'hui
    const checkoutQ = { compositeFilter: { op: 'AND', filters: [
      { fieldFilter: { field: { fieldPath: 'end' }, op: 'EQUAL', value: { stringValue: date } } },
      { fieldFilter: { field: { fieldPath: 'deleted' }, op: 'EQUAL', value: { booleanValue: false } } }
    ]}};
    const r1 = await queryAndMatch(checkoutQ, 'checkout');
    if (r1) { console.log('PassPass match checkout:', logement, '->', r1.tenantName); return r1; }

    // Passe 2: reservation active
    const activeQ = { compositeFilter: { op: 'AND', filters: [
      { fieldFilter: { field: { fieldPath: 'start' }, op: 'LESS_THAN_OR_EQUAL', value: { stringValue: date } } },
      { fieldFilter: { field: { fieldPath: 'end' }, op: 'GREATER_THAN', value: { stringValue: date } } },
      { fieldFilter: { field: { fieldPath: 'deleted' }, op: 'EQUAL', value: { booleanValue: false } } }
    ]}};
    const r2 = await queryAndMatch(activeQ, 'active');
    if (r2) { console.log('PassPass match active:', logement, '->', r2.tenantName); return r2; }

    console.log('PassPass: no match for', logement, 'on', date);
    return null;
  } catch(e) { console.error('PassPass error:', e.message); return null; }
}

// ==================== Utilitaires ====================

  // Convertit un file_id Telegram en URL de telechargement
  async function fileIdToUrl(fileId) {
    return new Promise((resolve) => {
      const req = https.request({
        hostname: 'api.telegram.org',
        path: '/bot' + BOT_TOKEN + '/getFile?file_id=' + fileId,
        method: 'GET'
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const j = JSON.parse(d);
            if (j.ok && j.result && j.result.file_path) {
              resolve('https://api.telegram.org/file/bot' + BOT_TOKEN + '/' + j.result.file_path);
            } else {
              resolve(null);
            }
          } catch(e) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.end();
    });
  }

  // Telecharge une image en base64 depuis une URL
  async function downloadBase64(url) {
    return new Promise((resolve) => {
      https.get(url, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(Buffer.concat(chunks).toString('base64'));
          } catch(e) { resolve(null); }
        });
      }).on('error', () => resolve(null));
    });
  }

  // Analyse les photos avec Claude Vision pour detecter type_sinistre et logement
  async function analyserPhotos(photoUrls, texteCaption) {
    if (!ANTHROPIC_KEY || !photoUrls.length) return null;
    const imageContents = [];
    for (const url of photoUrls.slice(0, 4)) {
      const b64 = await downloadBase64(url);
      if (b64) {
        imageContents.push({
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: b64 }
        });
      }
    }
    if (!imageContents.length) { console.log('Vision: aucune image telechargee'); return null; }
    const prompt = 'Tu analyses des photos de logement meuble apres passage de voyageurs pour une conciergerie. ' +
      'Identifie: 1) type_sinistre parmi (Nettoyage supplementaire, Tabac/Odeurs, Degradation/Casse, Dommages eau, Autre). ' +
      '2) description courte en francais de ce que tu vois (max 150 mots). ' +
      '3) logement: si tu vois le nom de l\'appartement sur une affiche ou plaque visible dans la photo, indique-le, sinon null. ' +
      (texteCaption ? 'La legende envoyee avec les photos est: "' + texteCaption + '". ' : '') +
      'Reponds en JSON strict: {"type_sinistre":"...","description":"...","logement":null}';
    imageContents.push({ type: 'text', text: prompt });
    return new Promise((resolve) => {
      const body = JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: imageContents }]
      });
      const req = https.request({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        }
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const j = JSON.parse(d);
            if (j.error) { console.error('Vision API error:', j.error.message); resolve(null); return; }
            const txt = (j.content && j.content[0] && j.content[0].text) || '';
            const m = txt.match(/\{[\s\S]*\}/);
            resolve(m ? JSON.parse(m[0]) : null);
          } catch(e) { console.error('Vision parse error:', e.message); resolve(null); }
        });
      });
      req.on('error', (e) => { console.error('Vision request error:', e.message); resolve(null); });
      req.write(body);
      req.end();
    });
  }

  // Extrait le nom du logement via IA texte (OpenRouter) - fallback
  async function extraireLogement(txt) {
    if (!OPENROUTER_KEY || !txt) return null;
    const prompt = 'Extrait uniquement le nom du logement de ce message (ex: BERLIOZ 69100, FELIX 1, REPUBLIQUE...). Reponds avec juste le nom, rien dautre. Si aucun logement identifiable, reponds NULL.\nMessage: "' + txt + '"';
    return new Promise((resolve) => {
      const body = JSON.stringify({
        model: 'meta-llama/llama-3.3-70b-instruct:free',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 30
      });
      const req = https.request({
        hostname: 'openrouter.ai',
        path: '/api/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + OPENROUTER_KEY,
          'HTTP-Referer': 'https://litigeia.onrender.com'
        }
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => {
          try {
            const j = JSON.parse(d);
            const r = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
            const clean = r.trim();
            resolve(clean === 'NULL' || clean === '' ? null : clean);
          } catch(e) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.write(body);
      req.end();
    });
  }

  // Fallback regex si pas d'IA
  function extraireLogementSimple(txt) {
    if (!txt) return null;
    const m = txt.match(/\b([A-Z][A-Z0-9\s\-]{2,30}(?:\s+\d{4,5})?)\b/);
    return m ? m[1].trim() : null;
  }

  // Cree le litige directement dans app_state (format LitigeIA)
  // AUTO-MATCH: cherche et enrichit avec les infos PassPass
  async function sauver(logement, description, typeSinistre, photos, firstMsg) {
    const userName = [firstMsg.from.first_name, firstMsg.from.last_name].filter(Boolean).join(' ');
    const today = new Date().toISOString().split('T')[0];

    // Lire l'etat actuel
    const { data: stateRow, error: readErr } = await supabase
      .from('app_state')
      .select('data')
      .eq('id', 'main')
      .single();

    if (readErr || !stateRow) {
      console.error('Erreur lecture app_state:', readErr && readErr.message);
      return null;
    }

    const state = stateRow.data || { config: {}, properties: [], litiges: [] };
    if (!state.litiges) state.litiges = [];

    // Matcher le logement avec un property_id (bidirectionnel)
    let property_id = '';
    if (logement && state.properties && state.properties.length) {
      const lg = logement.toLowerCase().normalize('NFD').replace(/[Ì-Í¯]/g, '');
      const match = state.properties.find(p => {
        if (!p.name) return false;
        const pn = p.name.toLowerCase().normalize('NFD').replace(/[Ì-Í¯]/g, '');
        return pn.includes(lg) || lg.includes(pn);
      });
      if (match) property_id = match.id || '';
      console.log('Property match:', logement, '->', property_id ? 'trouvÃ©' : 'aucun');
    }

    // AUTO-MATCH PassPass : chercher resa sortante ou active
    let passpassBooking = null;
    let guest_name = userName;
    let guest_email = '';
    let booking_ref = '';
    let checkin = '';
    let checkout = '';

    if (property_id) {
      passpassBooking = await chercherReservationPassPass(property_id, today);
      if (passpassBooking) {
        guest_name = passpassBooking.tenantName || userName;
        guest_email = passpassBooking.tenantEmail || '';
        checkin = passpassBooking.start || '';
        checkout = passpassBooking.end || '';
        console.log('AUTO-MATCH PassPass OK:', guest_name, '|', checkin, '-', checkout);
      }
    }

    // Sauvegarder photos dans pending_photos (creation litige auto desactivee)
    if (!state.pending_photos) state.pending_photos = [];
    const _sender = userName;
    photos.forEach(function(url){ state.pending_photos.push({ url: url, date: today, sender: _sender, logmt: logement || null }); });

    // Sauvegarder
    const { error: writeErr } = await supabase
      .from('app_state')
      .upsert({ id: 'main', data: state, updated_at: new Date().toISOString() });

    if (writeErr) {
      console.error('Erreur ecriture app_state:', writeErr.message);
      return null;
    }

    console.log('Litige cree:', newLitige.id, '| logement:', logement, '| guest:', guest_name, '| sinistre:', typeSinistre, '| photos:', photos.length);
    return newLitige;
  }

  // Finalise et sauvegarde le buffer d'un utilisateur
  async function finaliserBuffer(userId) {
    const entry = buffer[userId];
    if (!entry) return;
    delete buffer[userId];

    const texte = entry.texts.join('\n').trim();
    const fileIds = entry.photos;

    // 1. Convertir file_ids en URLs de telechargement reelles
    const photoUrls = (await Promise.all(fileIds.map(id => fileIdToUrl(id)))).filter(Boolean);

    // 2. Legende courte (<=50 chars) = nom du logement
    let logement = null;
    if (texte && texte.length > 0 && texte.length <= 50) {
      logement = texte.trim();
      console.log('Logement depuis legende:', logement);
    }

    // 3. Analyse Vision Claude : detecte type_sinistre et description
    let description = texte || '';
    let typeSinistre = 'Constat terrain';
    if (photoUrls.length) {
      const analyse = await analyserPhotos(photoUrls, texte);
      if (analyse) {
        if (analyse.type_sinistre) typeSinistre = analyse.type_sinistre;
        if (analyse.description) description = analyse.description + (texte ? '\n\n' + texte : '');
        if (analyse.logement && !logement) logement = analyse.logement;
        console.log('Vision OK:', JSON.stringify(analyse));
      }
    }

    // 4. Fallback texte si logement toujours inconnu et texte long
    if (!logement && texte && texte.length > 50) {
      logement = await extraireLogement(texte);
      if (!logement) logement = extraireLogementSimple(texte);
    }

    await sauver(logement, description, typeSinistre, photoUrls, entry.firstMsg);
  }

  // Traite chaque message du groupe
  async function traiterMessage(msg) {
    if (msg.chat.id.toString() !== GROUP_ID) return;
    if (msg.text && msg.text.startsWith('/')) return;

    const userId = msg.from.id;
    const texte = msg.text || msg.caption || '';
    const photos = [];

    if (msg.photo && msg.photo.length > 0) {
      photos.push(msg.photo[msg.photo.length - 1].file_id);
    }

    if (!buffer[userId]) {
      buffer[userId] = { texts: [], photos: [], firstMsg: msg, timer: null };
    }

    if (texte) buffer[userId].texts.push(texte);
    buffer[userId].photos.push(...photos);

    if (buffer[userId].timer) clearTimeout(buffer[userId].timer);
    buffer[userId].timer = setTimeout(() => finaliserBuffer(userId), WINDOW_MS);
  }

  bot.on('message', traiterMessage);

  // Commande /litiges : affiche les 5 derniers litiges Telegram
  bot.onText(/\/litiges/, async (msg) => {
    if (msg.chat.id.toString() !== GROUP_ID) return;

    const { data: stateRow, error } = await supabase
      .from('app_state')
      .select('data')
      .eq('id', 'main')
      .single();

    if (error || !stateRow) {
      bot.sendMessage(msg.chat.id, 'Aucun litige recent.');
      return;
    }

    const litiges = (stateRow.data && stateRow.data.litiges) || [];
    const recent = litiges
      .filter(l => l.platform === 'Telegram')
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .slice(0, 5);

    if (!recent.length) {
      bot.sendMessage(msg.chat.id, 'Aucun litige Telegram recent.');
      return;
    }

    const lines = recent.map((l, i) =>
      (i + 1) + '. *' + (l.resume || 'Logement inconnu') + '*\n' +
      '   ' + (l.description || '').slice(0, 60) + '\n' +
      '   ' + l.constat_date + ' | ' + l.guest_name
    );

    bot.sendMessage(msg.chat.id, '*5 derniers litiges Telegram :*\n\n' + lines.join('\n\n'), { parse_mode: 'Markdown' });
  });

  bot.on('polling_error', err => console.error('Polling error:', err.message));
}
