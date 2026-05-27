/**
 * WH Conciergerie - Bot Telegram Constats
 * Chaque message dans LITIGES VOYAGEURS = un litige a ouvrir.
 * Les messages du meme utilisateur dans une fenetre de 45s sont groupes en 1 litige.
 * Aucun message de confirmation n'est envoye dans le groupe.
 */

const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const https = require('https');

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

  // Sauvegarde dans Supabase (1 litige = toutes les photos + textes groupes)
  async function sauver(logement, description, photos, firstMsg) {
          const userName = [firstMsg.from.first_name, firstMsg.from.last_name].filter(Boolean).join(' ');
          const today = new Date().toISOString().split('T')[0];
          const { data, error } = await supabase.from('litiges_telegram').insert({
                    logement:         logement || 'A preciser',
                    type_degat:       'Constat terrain',
                    description:      description || '',
                    date_constat:     today,
                    telegram_msg_id:  firstMsg.message_id,
                    telegram_user:    userName,
                    telegram_username: firstMsg.from.username || null,
                    photos_ids:       photos.length > 0 ? photos.join(',') : null,
                    nb_photos:        photos.length,
                    urgent:           false,
                    statut:           'constate',
                    etape:            0,
                    source:           'telegram'
          }).select().single();
          if (error) {
                    console.error('Supabase error:', error.message);
                    return null;
          }
          console.log('Litige cree:', data.id, '| logement:', logement, '| photos:', photos.length);
          return data;
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

        // Initialise le buffer pour cet utilisateur
        if (!buffer[userId]) {
                  buffer[userId] = { texts: [], photos: [], firstMsg: msg, timer: null };
        }

        // Accumule texte et photos
        if (texte) buffer[userId].texts.push(texte);
          buffer[userId].photos.push(...photos);

        // Remet le timer a zero a chaque nouveau message
        if (buffer[userId].timer) clearTimeout(buffer[userId].timer);
          buffer[userId].timer = setTimeout(() => finaliserBuffer(userId), WINDOW_MS);
  }

  bot.on('message', traiterMessage);

  bot.onText(/\/litiges/, async (msg) => {
          if (msg.chat.id.toString() !== GROUP_ID) return;
          const { data, error } = await supabase
            .from('litiges_telegram')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(5);
          if (error || !data || !data.length) {
                    bot.sendMessage(msg.chat.id, 'Aucun litige recent.');
                    return;
          }
          const lines = data.map((l, i) =>
                    (i + 1) + '. *' + l.logement + '* - ' + l.type_degat + '\n   ' + l.date_constat + ' | ' + l.telegram_user
                                     );
          bot.sendMessage(msg.chat.id, '*5 derniers litiges :*\n\n' + lines.join('\n\n'), { parse_mode: 'Markdown' });
  });

  bot.on('polling_error', err => console.error('Polling error:', err.message));
}
