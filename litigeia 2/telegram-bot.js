/**
 * WH Conciergerie - Bot Telegram Constats
 * Ecoute le groupe LITIGES VOYAGEURS et cree des litiges dans Supabase.
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

const MOTS = ['casse','brise','trou','tache','rayure','brule','abime','manquant',
  'decolle','fendu','degat','dommage','sale','deteriore','endommage','fuite',
  'humidite','moisissure','vitre','miroir','canape','matelas','linge','serrure'];

function estConstat(txt) {
  if (!txt) return false;
  const low = txt.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return MOTS.some(k => low.includes(k));
}

async function parseIA(txt) {
  if (!OPENROUTER_KEY) return null;
  const prompt = 'Analyse ce message femme de menage Airbnb. JSON uniquement sans markdown: {"logement":"nom ou null","degats":["liste"],"description":"resume","urgent":false}\nMessage: "' + txt + '"';
  return new Promise((resolve) => {
    const body = JSON.stringify({ model: 'meta-llama/llama-3.3-70b-instruct:free', messages: [{ role: 'user', content: prompt }], max_tokens: 200 });
    const req = https.request({ hostname: 'openrouter.ai', path: '/api/v1/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + OPENROUTER_KEY, 'HTTP-Referer': 'https://litigeia.onrender.com' }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          const c = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
          resolve(JSON.parse(c.trim().replace(/^```json|^```|```$/g, '').trim()));
        } catch(e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(body); req.end();
  });
}

function parseSimple(txt) {
  const low = txt.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const found = [...new Set(MOTS.filter(k => low.includes(k)))];
  return { logement: null, degats: found.length ? found : ['degat signale'], description: txt.slice(0, 200), urgent: ['fuite','serrure','feu','urgence'].some(u => low.includes(u)) };
}

async function sauver(parsed, msg) {
  const user = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ');
  const { data, error } = await supabase.from('litiges_telegram').insert({
    logement: parsed.logement || 'A preciser',
    type_degat: (parsed.degats || []).join(', ') || 'Degat signale',
    description: parsed.description || msg.text,
    date_constat: new Date().toISOString().split('T')[0],
    telegram_msg_id: msg.message_id,
    telegram_user: user,
    telegram_username: msg.from.username || null,
    urgent: parsed.urgent || false,
    statut: 'constate', etape: 0, source: 'telegram'
  }).select().single();
  if (error) { console.error('Supabase:', error.message); return null; }
  return data;
}

bot.on('message', async (msg) => {
  if (msg.chat.id.toString() !== GROUP_ID) return;
  if (!msg.text || !estConstat(msg.text)) return;
  console.log('Constat de', msg.from.first_name, ':', msg.text.slice(0, 60));
  let parsed = await parseIA(msg.text);
  if (!parsed) parsed = parseSimple(msg.text);
  const litige = await sauver(parsed, msg);
  if (litige) {
    const ref = (litige.id || '').toString().slice(0, 8);
    const log = parsed.logement ? '\nLogement: ' + parsed.logement : '';
    const urg = parsed.urgent ? '\n⚠️ URGENT' : '';
    bot.sendMessage(msg.chat.id, 'Constat enregistre !' + log + '\nDegats: ' + (parsed.degats || []).join(', ') + '\nRef: #' + ref + urg, { reply_to_message_id: msg.message_id });
  } else {
    bot.sendMessage(msg.chat.id, 'Erreur enregistrement. Contacte admin.', { reply_to_message_id: msg.message_id });
  }
});

bot.onText(//litiges/, async (msg) => {
  if (msg.chat.id.toString() !== GROUP_ID) return;
  const { data } = await supabase.from('litiges_telegram').select('*').order('created_at', { ascending: false }).limit(5);
  if (!data || !data.length) { bot.sendMessage(msg.chat.id, 'Aucun litige recent.'); return; }
  const lines = data.map((l, i) => (i+1) + '. ' + l.logement + ' - ' + l.type_degat + '\n   ' + l.date_constat + ' | ' + l.telegram_user);
  bot.sendMessage(msg.chat.id, '5 derniers litiges:\n\n' + lines.join('\n\n'));
});

bot.on('polling_error', err => console.error('Polling error:', err.message));

}
