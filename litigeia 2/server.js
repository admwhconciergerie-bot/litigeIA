const express = require('express');
const path = require('path');

const app = express();

// Parse JSON bodies — 50mb pour les images base64
app.use(express.json({ limit: '50mb' }));

// Sert les fichiers statiques (public/index.html, etc.)
app.use(express.static(path.join(__dirname, 'public')));

// ─── Route : analyse IA ───────────────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: 'ANTHROPIC_API_KEY non configurée. Ajoutez-la dans les variables d\'environnement Render.'
    });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify(req.body)
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

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
