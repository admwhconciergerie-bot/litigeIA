—/**
 * WH Conciergerie - Bot Telegram Constats
 * Les messages du meme utilisateur dans une fenetre de 45s sont groupes en 1 litige.
 * Aucun message de confirmation n'est envoye dans le groupe.
 * Les litiges sont crees directement dans app_state (LitigeIA).
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

  // Extrait le nom du logement via IA (OpenRouter)
  async function extraireLogement(txt) {
            if (!OPENROUTER_KEY || !txt) return null;
            const prompt = `Extrait uniquement le nom du logement de ce message (ex: BERLIOZ 69100, FELIX 1, REPUBLIQUE...). Reponds avec juste le nom, rien dautre. Si aucun logement identifiable, reponds NULL.\nMessage: "${txt}"`;
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
  async function sauver(logement, description, photos, firstMsg) {
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

          // Essayer de matcher le logement avec un property_id
          let property_id = '';
            if (logement && state.properties && state.properties.length) {
                        const match = state.properties.find(p =>
                                      p.name && p.name.toLowerCase().includes(logement.toLowerCase())
                                                                  );
                        if (match) property_id = match.id || '';
            }

          // Creer le litige au format LitigeIA
          const newLitige = {
                      id: crypto.randomUUID(),
                      platform: 'Telegram',
                      property_id: property_id,
                      guest_name: userName,
                      guest_email: '',
                      booking_ref: '',
                      checkin: '',
                      checkout: '',
                      constat_date: today,
                      description: description || '',
                      notes: 'Signalement Telegram' +
                                    (firstMsg.from.username ? ' @' + firstMsg.from.username : '') +
                                    (logement ? ' — ' + logement : ''),
                      caution: 0,
                      articles: [],
                      total_ht: 0, total_tva: 0, total_ttc: 0,
                      photos: [],
                      resume: logement || 'Constat Telegram',
                      gravite: '',
                      lettre: '',
                      status: 'new',
                      created_at: new Date().toISOString()
          };

          state.litiges.push(newLitige);

          // Sauvegarder
          const { error: writeErr } = await supabase
              .from('app_state')
              .upsert({ id: 'main', data: state, updated_at: new Date().toISOString() });

          if (writeErr) {
                      console.error('Erreur ecriture app_state:', writeErr.message);
                      return null;
          }

          console.log('Litige cree dans app_state:', newLitige.id, '| logement:', logement, '| photos:', photos.length);
            return newLitige;
  }

  // Finalise et sauvegarde le buffer d'un utilisateur
  async function finaliserBuffer(userId) {
            const entry = buffer[userId];
            if (!entry) return;
            delete buffer[userId];

          const description = entry.texts.join('\n');
            const allPhotos   = entry.photos;

          let logement = await extraireLogement(description);
            if (!logement) logement = extraireLogementSimple(description);

          await sauver(logement, description, allPhotos, entry.firstMsg);
  }

  // Traite chaque message du groupe
  async function traiterMessage(msg) {
            if (msg.chat.id.toString() !== GROUP_ID) return;
            if (msg.text && msg.text.startsWith('/')) return;

          const userId = msg.from.id;
            const texte  = msg.text || msg.caption || '';
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
            // Pas de bot.sendMessage — aucune confirmation dans le groupe
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
