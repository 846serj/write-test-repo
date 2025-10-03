const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const crypto = require('crypto');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function fetchAllRecords() {
  const apiKey = process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const tableName = 'Recipes';

  const headers = { Authorization: `Bearer ${apiKey}` };
  const baseUrl = `https://api.airtable.com/v0/${baseId}/${tableName}`;

  const records = [];
  let offset;
  do {
    const url = new URL(baseUrl);
    if (offset) url.searchParams.set('offset', offset);
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Airtable request failed: ${res.status}`);
    const data = await res.json();
    records.push(...(data.records || []));
    offset = data.offset;
  } while (offset);
  return records;
}

async function main() {
  const records = await fetchAllRecords();

  const outDir = path.resolve(process.cwd(), 'data');
  const outPath = path.join(outDir, 'recipeEmbeddings.json');

  let existing = [];
  if (fs.existsSync(outPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    } catch (err) {
      console.warn('Could not read existing embeddings, regenerating all.');
    }
  }
  const existingMap = new Map(existing.map((e) => [e.id, e]));

  const embeddings = [];
  for (const rec of records) {
    const f = rec.fields || {};
    const title = f.Title || '';
    const desc = f.Description || '';
    const cat = f.Category || '';
    const tags = Array.isArray(f.Tags) ? f.Tags : [];
    const text = `${title}. ${desc}. Category: ${cat}. Tags: ${tags.join(', ')}`;
    const hash = crypto.createHash('md5').update(text).digest('hex');

    const existingRec = existingMap.get(rec.id);
    if (existingRec && existingRec.hash === hash) {
      embeddings.push(existingRec);
      continue;
    }

    const { data: [{ embedding }] } = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: text
    });

    embeddings.push({
      id: rec.id,
      title,
      url: f.URL || f.Url || null,
      embedding,
      hash
    });
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(embeddings, null, 2));
  console.log('Generated', embeddings.length, 'embeddings.');
}

main().catch(console.error);
