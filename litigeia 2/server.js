const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: false }));

// Parse cookies helper
function getCookie(req, name) {
  const header = req.headers.cookie || '';
  const cookies = {};
  header.split(';').forEach(part => {
    const [k, ...v] = part.trim().split('=');
    if (k) cookies[k.trim()] = v.join('=');
  });
  return cookies[name] || '';
}

// Login page HTML
function loginPage(error) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LitigeIA</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0f172a; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .box { background: #1e293b; border: 1px solid #334155; border-radius: 16px; padding: 40px; width: 360px; text-align: center; }
    .logo { width: 52px; height: 52px; background: linear-gradient(135deg, #6366f1, #a78bfa); border-radius: 14px; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; font-size: 24px; }
    h1 { color: white; font-size: 20px; margin-bottom: 6px; }
    p { color: #64748b; font-size: 13px; margin-bottom: 28px; }
    input { width: 100%; padding: 11px 14px; background: #0f172a; border: 1.5px solid #334155; border-radius: 8px; color: white; font-size: 14px; outline: none; margin-bottom: 12px; }
    input:focus { border-color: #6366f1; }
    button { width: 100%; padding: 11px; background: #6366f1; color: white; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; }
    button:hover { background: #4f46e5; }
    .err { color: #ef4444; font-size: 12px; margin-top: 10px; }
  </style>
</head>
<body>
  <div class="box">
    <div class="logo">&#9889;</div>
    <h1>LitigeIA</h1>
    <p>Acces prive - entrez le mot de passe</p>
    <form method="POST" action="/login">
      <input type="password" name="password" placeholder="Mot de passe" autofocus>
      <button type="submit">Acceder &#8594;</button>
    </form>
    ${error ? '<div class="err">Mot de passe incorrect</div>' : ''}
  </div>
</body>
</html>`;
}

// Protection par cookie
app.use((req, res, next) => {
  const password = process.env.APP_PASSWORD;
  if (!password) return next();
  if (req.path === '/login') return next();
  const cookie = getCookie(req, 'litigeia_auth');
  if (cookie === password) return next();
  res.status(401).send(loginPage(false));
});

// Route de login
app.post('/login', (req, res) => {
  const password = process.env.APP_PASSWORD;
  const submitted = req.body.password || '';
  if (!password || submitted === password) {
    res.setHeader('Set-Cookie', 'litigeia_auth=' + submitted + '; Path=/; HttpOnly; SameSite=Strict');
    res.redirect('/');
  } else {
    res.status(401).send(loginPage(true));
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// Analyse IA - Gemini en priorite, Anthropic en fallback
app.post('/api/analyze', async (req, res) => {
  const geminiKey = process.env.GEMINI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (geminiKey) {
    try {
      const { system, messages } = req.body;
      const userMsg = messages[0];
      const parts = [];

      const textParts = (userMsg.content || []).filter(p => p.type === 'text');
      const systemText = system ? system + '\n\n' : '';
      const userText = textParts.map(p => p.text).join('\n');
      if (systemText || userText) parts.push({ text: systemText + userText });

      const imgParts = (userMsg.content || []).filter(p => p.type === 'image');
      for (const img of imgParts) {
        if (img.source && img.source.type === 'base64') {
          parts.push({ inline_data: { mime_type: img.source.media_type || 'image/jpeg', data: img.source.data } });
        }
      }

      const geminiBody = {
        contents: [{ parts }],
        generationConfig: { maxOutputTokens: 3000, temperature: 0.3 }
      };

      const response = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + geminiKey,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(geminiBody) }
      );

      const data = await response.json();
      if (!response.ok) return res.status(response.status).json({ error: (data.error && data.error.message) || 'Erreur Gemini' });

      const text = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text) || '';
      return res.json({ content: [{ type: 'text', text }], usage: { input_tokens: 0, output_tokens: 0 } });

    } catch (err) {
      console.error('Erreur Gemini:', err);
      return res.status(500).json({ error: err.message });
    }
  }

  if (!anthropicKey) {
    return res.status(500).json({ error: 'Aucune cle API configuree. Ajoutez GEMINI_API_KEY dans Render.' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data);
  } catch (err) {
    console.error('Erreur Anthropic:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('LitigeIA demarre sur le port ' + PORT);
});
