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
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  try {
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
  const system   = req.body.system || '';

  // Detecter images (format Anthropic ou OpenAI)
  const hasImages = messages.some(m =>
    (Array.isArray(m.content) ? m.content : []).some(c => c.type === 'image' || c.type === 'image_url')
  );

  // Convertir Anthropic → OpenAI pour OpenRouter
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

  const model = hasImages
    ? 'qwen/qwen2-vl-7b-instruct:free'
    : 'meta-llama/llama-3.3-70b-instruct:free';

  try {
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key,
                 'HTTP-Referer': 'https://litigeia.onrender.com', 'X-Title': 'LitigeIA' },
      body: JSON.stringify({ model, messages: oaMsgs, max_tokens: 3000 })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: (data.error && data.error.message) || 'Erreur OpenRouter' });
    const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    res.json({ content: [{ type: 'text', text }], usage: { input_tokens: 0, output_tokens: 0 } });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('OK port ' + PORT));

// Demarrer le bot Telegram
require('./telegram-bot');
