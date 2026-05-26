const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/analyze', async (req, res) => {
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (openrouterKey) {
    try {
      const { system, messages } = req.body;
      const userMsg = messages[0];

      // Convertir format Anthropic -> OpenAI pour OpenRouter
      const openaiMessages = [];
      if (system) openaiMessages.push({ role: 'system', content: system });

      const content = [];
      for (const part of (userMsg.content || [])) {
        if (part.type === 'text') {
          content.push({ type: 'text', text: part.text });
        } else if (part.type === 'image' && part.source && part.source.type === 'base64') {
          content.push({
            type: 'image_url',
            image_url: { url: 'data:' + (part.source.media_type || 'image/jpeg') + ';base64,' + part.source.data }
          });
        }
      }
      openaiMessages.push({ role: 'user', content });

      const body = {
        model: 'google/gemma-4-31b-it:free',
        messages: openaiMessages,
        max_tokens: 3000
      };

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
      if (!response.ok) return res.status(response.status).json({ error: (data.error && data.error.message) || 'Erreur OpenRouter' });
      const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
      return res.json({ content: [{ type: 'text', text }], usage: { input_tokens: 0, output_tokens: 0 } });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
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
        max_tokens: 3000
      };

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
      if (!response.ok) return res.status(response.status).json({ error: (data.error && data.error.message) || 'Erreur OpenRouter' });
      const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
      return res.json({ content: [{ type: 'text', text }], usage: { input_tokens: 0, output_tokens: 0 } });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
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
