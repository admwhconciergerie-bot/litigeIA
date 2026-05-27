/**
 * WH Conciergerie - Bot Telegram Constats
 * Chaque message dans LITIGES VOYAGEURS = un litige a ouvrir.
 * Les femmes de menage indiquent le nom de l'appart + envoient des photos.
 */

const TelegramBot = require('node-telegram-bot-api');
const { createClient } = require('@supabase/supabase-js');
const https = require('https');

const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const GROUP_ID       = process.env.TELEGRAM_GROUP_ID || '-606738403';
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_KEY;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;

if (!BOT_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
  console.log('Bot Telegram desactive (variables manquantes)');
  module.exports = {};
} else {

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log('Bot Telegram WH demarre - groupe', GROUP_ID);

// Extrait le nom du logement via IA
async function extraireLogement(txt) {
  if (!OPENROUTER_KEY || !txt) return null;
  const prompt = 'Extrait uniquement le nom du logement/appartement de ce message (ex: BERLIOZ 69100, FELIX 1, REPUBLIQUE...). Reponds avec juste le nom, rien d'autre. Si aucun logement identifiable, reponds NULL.\nMessage: "' + txt + '"';
  return new Promise((resolve) => {
    const body = JSON.stringify({ model: 'meta-llama/llama-3.3-70b-instruct:free', messages: [{ role: 'user', content: prompt }], max_tokens: 30 });
    const req = https.request({ hostname: 'openrouter.ai', path: '/api/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENROUTER_KEY, 'HTTP-Referer': 'https://litigeia.onrender.com' }
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
    req.write(body); req.end();
  });
}

// Extrait le nom depuis le texte sans IA (fallback)
function extraireLogementSimple(txt) {
  if (!txt) return null;
  // Cherche un pattern type "NOM CODE_POSTAL" ou "NOM NUMERO"
  const m = txt.match(/([A-Z][A-Z0-9 ]{2,30}(?:\d{5}|\d{1,2}))/);
  if (m) return m[1].trim();
  // Prend la premiere ligne si courte
  const firstLine = txt.split('\n')[0].trim();
  if (firstLine.length < 50) return firstLine;
  return null;
}

// Sauvegarde le litige dans Supabase
async function sauver(logement, description, photos, msg) {
  const user = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ');
  const { data, error } = await supabase.from('litiges_telegram').insert({
    logement:        logement || 'A preciser',
    type_degat:      'Constat femme de menage',
    description:     description || '',
    date_constat:    new Date().toISOString().split('T')[0],
    telegram_msg_id: msg.message_id,
    telegram_user:   user,
    telegram_username: msg.from.username || null,
    photos_ids:      photos.length ? photos.join(',') : null,
    nb_photos:       photos.length,
    urgent:          false,
    statut:          'constate',
    etape:           0,
    source:          'telegram'
  }).select().single();
  if (error) { console.error('Supabase:', error.message); return null; }
  return data;
}

// Traite chaque message (texte OU photo)
async function traiterMessage(msg) {
  if (msg.chat.id.toString() !== GROUP_ID) return;

  // Ignorer les commandes
  if (msg.text && msg.text.startsWith('/')) return;

  const texte = msg.text || msg.caption || '';
  const photos = [];

  // Recuperer les IDs des photos (prend la meilleure resolution)
  if (msg.photo && msg.photo.length > 0) {
    const bestPhoto = msg.photo[msg.photo.length - 1];
    photos.push(bestPhoto.file_id);
  }

  const userName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ');
  console.log('Nouveau constat de', userName, '| texte:', texte.slice(0, 50), '| photos:', photos.length);

  // Extraire le logement
  let logement = await extraireLogement(texte);
  if (!logement) logement = extraireLogementSimple(texte);

  // Sauvegarder
  const litige = await sauver(logement, texte, photos, msg);

  if (litige) {
    const ref = (litige.id || '').toString().slice(0, 8);
    const log = logement ? '\nLogement: ' + logement : '\nLogement: a preciser';
    const ph = photos.length > 0 ? '\nPhotos: ' + photos.length + ' recues' : '';
    bot.sendMessage(msg.chat.id,
      'Litige ouvert ! #' + ref + log + ph,
      { reply_to_message_id: msg.message_id }
    );
  } else {
    bot.sendMessage(msg.chat.id, 'Erreur enregistrement. Contacte admin.', { reply_to_message_id: msg.message_id });
  }
}

// Ecoute tous les messages et photos du groupe
bot.on('message', traiterMessage);

// Commande /litiges - derniers 5 litiges
bot.onText(/\/litiges/, async (msg) => {
  if (msg.chat.id.toString() !== GROUP_ID) return;
  const { data } = await supabase.from('litiges_telegram').select('*').order('created_at', { ascending: false }).limit(5);
  if (!data || !data.length) { bot.sendMessage(msg.chat.id, 'Aucun litige recent.'); return; }
  const lines = data.map((l, i) => (i+1) + '. ' + l.logement + ' | ' + l.date_constat + ' | ' + l.telegram_user + (l.nb_photos ? ' (' + l.nb_photos + ' photos)' : ''));
  bot.sendMessage(msg.chat.id, '5 derniers litiges:\n\n' + lines.join('\n'));
});

bot.on('polling_error', err => console.error('Polling error:', err.message));

}
