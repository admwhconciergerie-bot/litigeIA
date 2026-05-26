const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
      const geminiBody = { contents: [{ parts }], generationConfig: { maxOutputTokens: 3000, temperature: 0.3 } };
      const response = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + geminiKey,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(geminiBody) }
      );
      const data = await response.json();
      if (!response.ok) return res.status(response.status).json({ error: (data.error && data.error.message) || 'Erreur Gemini' });
      const text = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text) || '';
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
