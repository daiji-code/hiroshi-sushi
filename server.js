const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-20250514';

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Load manifest
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json')));

// GET /api/manifest — returns species list with photo counts
app.get('/api/manifest', (req, res) => {
  res.json(manifest);
});

// GET /api/refs/:species — returns base64 array for a species
app.get('/api/refs/:species', (req, res) => {
  const species = req.params.species;
  const dir = path.join(__dirname, 'public', 'references', species);
  if (!fs.existsSync(dir)) return res.json([]);

  const limit = parseInt(req.query.limit) || 6;
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.jpg'))
    .sort((a, b) => parseInt(a) - parseInt(b))
    .slice(0, limit);

  const refs = files.map(fn => {
    const data = fs.readFileSync(path.join(dir, fn));
    return data.toString('base64');
  });
  res.json(refs);
});

// POST /api/identify/stage1 — quick shortlist
app.post('/api/identify/stage1', async (req, res) => {
  const { image, speciesList } = req.body;
  if (!image) return res.status(400).json({ error: 'No image' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 120,
        system: `You are a sushi expert. Look at this photo carefully.\n\nIs this one of these species: ${speciesList.join(', ')}?\n\nIf YES: return {"candidates":["Name1","Name2","Name3"]} with the 3 most likely.\n\nIf NO: identify it as best you can and return {"outOfLibrary":true,"jp":"Japanese name if known","en":"English name","what":"brief description"}.\n\nReturn ONLY valid JSON, no explanation.`,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
            { type: 'text', text: 'Identify this sushi. JSON only.' }
          ]
        }]
      })
    });
    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error });
    const txt = data.content?.[0]?.text || '';
    const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
    res.json(JSON.parse(txt.slice(s, e + 1)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/identify/stage2 — visual comparison
app.post('/api/identify/stage2', async (req, res) => {
  const { image, candidates, refs } = req.body;
  // refs = { "Iwashi": ["b64","b64",...], "Kohada": [...] }
  if (!image || !candidates) return res.status(400).json({ error: 'Missing data' });

  const content = [
    { type: 'text', text: 'UNKNOWN SUSHI — identify this piece:' },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } }
  ];

  for (const candidate of candidates) {
    const candidateRefs = refs[candidate] || [];
    if (candidateRefs.length === 0) continue;
    content.push({ type: 'text', text: `\nREFERENCE PHOTOS — ${candidate}:` });
    for (const refB64 of candidateRefs) {
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: refB64 } });
    }
  }
  content.push({ type: 'text', text: 'Compare the unknown piece to the references visually. Return JSON.' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 600,
        system: `You are a world-class sushi expert doing precise visual comparison. The FIRST image is the UNKNOWN sushi to identify. The remaining images are labeled reference photos of candidate species. Compare the unknown image carefully — flesh color, skin pattern, marbling, bloodline, cut style, garnish. Return ONLY valid JSON:\n{"analysis":"3-4 sentences on what you observe and which reference it matches","toppings":"visible toppings or None","garnish":"visible garnish or None","candidates":{"EnglishName":0.95,"EnglishName":0.75,"EnglishName":0.40},"finalIdentification":{"en":"EnglishName","confidence":0.95}}`,
        messages: [{ role: 'user', content }]
      })
    });
    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error });
    const txt = data.content?.[0]?.text || '';
    const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
    res.json(JSON.parse(txt.slice(s, e + 1)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Hiroshi Sushi Identifier running on port ${PORT}`));
