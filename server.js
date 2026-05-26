const express = require('express');
const path = require('path');

const app = express();

// Parse JSON bodies — 50mb pour les images base64
app.use(express.json({ limit: '50mb' }));

// ─── Protection par mot de passe ─────────────────────────────────────────────
app.use((req, res, next) => {
  const password = process.env.APP_PASSWORD;

  // Si aucun mot de passe configuré, accès libre
  if (!password) return next();

  // Les assets JS/CSS/fonts chargés par index.html passent librement
  // mais la page principale et l'API sont protégées
  const auth = req.headers['authorization'];

  if (auth && auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString();
    const [, pass] = decoded.split(':');
    if (pass === password) return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="LitigeIA"');
  res.status(401).send(`
    <!DOCTYPE html>
    <html lang="fr">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>LitigeIA — Connexion</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          font-family: system-ui, sans-serif;
          background: #0f172a;
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .box {
          background: #1e293b;
          border: 1px solid #334155;
          border-radius: 16px;
          padding: 40px;
          width: 360px;
          text-align: center;
        }
        .logo {
          width: 52px; height: 52px;
          background: linear-gradient(135deg, #6366f1, #a78bfa);
          border-radius: 14px;
          display: flex; align-items: center; justify-content: center;
          margin: 0 auto 20px;
          font-size: 24px;
        }
        h1 { color: white; font-size: 20px; margin-bottom: 6px; }
        p { color: #64748b; font-size: 13px; margin-bottom: 28px; }
        input {
          width: 100%; padding: 11px 14px;
          background: #0f172a; border: 1.5px solid #334155;
          border-radius: 8px; color: white; font-size: 14px;
          outline: none; margin-bottom: 12px;
        }
        input:focus { border-color: #6366f1; }
        button {
          width: 100%; padding: 11px;
          background: #6366f1; color: white; border: none;
          border-radius: 8px; font-size: 14px; font-weight: 600;
          cursor: pointer; transition: background .2s;
        }
        button:hover { background: #4f46e5; }
        .err { color: #ef4444; font-size: 12px; margin-top: 8px; display: none; }
      </style>
    </head>
    <body>
      <div class="box">
        <div class="logo">⚡</div>
        <h1>LitigeIA</h1>
        <p>Accès privé — entrez le mot de passe</p>
        <input type="password" id="pw" placeholder="Mot de passe" onkeydown="if(event.key==='Enter')login()">
        <button onclick="login()">Accéder →</button>
        <div class="err" id="err">Mot de passe incorrect</div>
      </div>
      <script>
        function login() {
          const pw = document.getElementById('pw').value;
          if (!pw) return;
          // Basic Auth : envoie les credentials et recharge
          const encoded = btoa(':' + pw);
          fetch('/', { headers: { 'Authorization': 'Basic ' + encoded } })
            .then(r => {
              if (r.ok) { window.location.reload(); }
              else {
                document.getElementById('err').style.display = 'block';
                document.getElementById('pw').value = '';
              }
            });
        }
      </script>
    </body>
    </html>
  `);
});

// ─── Fichiers statiques ───────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── Route : analyse IA (Gemini ou Anthropic selon clé dispo) ────────────────
app.post('/api/analyze', async (req, res) => {
  const geminiKey = process.env.GEMINI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  // ── Gemini ────────────────────────────────────────────────────────────────
  if (geminiKey) {
    try {
      const { system, messages } = req.body;
      const userMsg = messages[0];

      // Convertir le format Anthropic → Gemini
      const parts = [];

      // Système + texte utilisateur fusionnés
      const textParts = (userMsg.content || []).filter(p => p.type === 'text');
      const systemText = system ? system + '\n\n' : '';
      const userText = textParts.map(p => p.text).join('\n');
      if (systemText || userText) {
        parts.push({ text: systemText + userText });
      }

      // Images
      const imgParts = (userMsg.content || []).filter(p => p.type === 'image');
      for (const img of imgParts) {
        if (img.source?.type === 'base64') {
          parts.push({
            inline_data: {
              mime_type: img.source.media_type || 'image/jpeg',
              data: img.source.data
            }
          });
        }
      }

      const geminiBody = {
        contents: [{ parts }],
        generationConfig: { maxOutputTokens: 3000, temperature: 0.3 }
      };

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(geminiBody)
        }
      );

      const data = await response.json();

      if (!response.ok) {
        return res.status(response.status).json({ error: data.error?.message || 'Erreur Gemini' });
      }

      // Convertir réponse Gemini → format Anthropic (pour que le frontend n'change pas)
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
      res.json({
        content: [{ type: 'text', text }],
        usage: { input_tokens: 0, output_tokens: 0 }
      });

    } catch (err) {
      console.error('Erreur API Gemini:', err);
      res.status(500).json({ error: err.message });
    }
    return;
  }

  // ── Anthropic (fallback) ──────────────────────────────────────────────────
  if (!anthropicKey) {
    return res.status(500).json({
      error: 'Aucune clé API configurée. Ajoutez GEMINI_API_KEY ou ANTHROPIC_API_KEY dans Render.'
    });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data);
  } catch (err) {
    console.error('Erreur API Anthropic:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Fallback → index.html ────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ LitigeIA démarré sur le port ${PORT}`);
});
