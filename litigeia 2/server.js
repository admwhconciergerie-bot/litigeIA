const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/analyze', async (req, res) => {
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (openrouterKey) {
    const { system, messages } = req.body;
    const userMsg = messages[0];
    const openaiMessages = [];
    if (system) openaiMessages.push({ role: 'system', content: system });

    // Texte uniquement (extraire le texte et mentionner les photos)
    const textParts = (userMsg.content || []).filter(p => p.type === 'text').map(p => p.text);
    const imgCount = (userMsg.content || []).filter(p => p.type === 'image').length;
    let userText = textParts.join('\n');
    if (imgCount > 0) userText += '\n[' + imgCount + ' photo(s) de degats jointe(s)]';
    openaiMessages.push({ role: 'user', content: userText });

    // Liste de modèles gratuits à essayer dans l'ordre
    const models = [
      'meta-llama/llama-3.3-70b-instruct:free',
      'mistralai/mistral-7b-instruct:free',
      'qwen/qwen3-8b:free',
      'google/gemma-3-12b-it:free'
    ];

    for (const model of models) {
      try {
        const body = { model, messages: openaiMessages, max_tokens: 3000 };
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + openrouterKey,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://litigeia.onrender.com',
            'X-Title': 'LitigeIA'
          },
          body: JSON.stringify(body)
        });
        const data = await response.json();
        if (response.ok) {
          const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
          return res.json({ content: [{ type: 'text', text }], usage: { input_tokens: 0, output_tokens: 0 } });
        }
        // Si erreur 429 ou provider error, essayer le modele suivant
        if (response.status !== 429 && response.status !== 503) {
          return res.status(response.status).json({ error: (data.error && data.error.message) || 'Erreur OpenRouter' });
        }
      } catch (err) {
        // Continuer avec le modele suivant
      }
    }
    return res.status(503).json({ error: 'Tous les modeles sont temporairement indisponibles. Reessayez dans quelques minutes.' });
  }

  if (!anthropicKey) return res.status(500).json({ error: 'Aucune cle API configuree.' });

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
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('OK port ' + PORT));
