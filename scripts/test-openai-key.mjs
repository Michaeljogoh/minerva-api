/**
 * Quick OpenAI API key smoke test.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... node scripts/test-openai-key.mjs
 *
 * Or with api/.env already set:
 *   node --env-file=.env scripts/test-openai-key.mjs
 */

const apiKey = process.env.OPENAI_API_KEY?.trim();

if (!apiKey) {
  console.error('FAIL: OPENAI_API_KEY is not set.');
  console.error('Example: OPENAI_API_KEY=sk-... node scripts/test-openai-key.mjs');
  process.exit(1);
}

if (!apiKey.startsWith('sk-')) {
  console.error('FAIL: OPENAI_API_KEY does not look like an OpenAI key (expected sk-...).');
  process.exit(1);
}

async function main() {
  console.log('Checking OpenAI auth (GET /v1/models)...');

  const modelsRes = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!modelsRes.ok) {
    const body = await modelsRes.text();
    console.error(`FAIL: auth check returned ${modelsRes.status}`);
    console.error(body);
    process.exit(1);
  }

  const models = await modelsRes.json();
  const count = Array.isArray(models.data) ? models.data.length : 0;
  console.log(`OK: authenticated. ${count} models visible.`);

  console.log('Running a tiny chat completion...');

  const chatRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Reply with exactly: pong' }],
      max_tokens: 10,
      temperature: 0,
    }),
  });

  if (!chatRes.ok) {
    const body = await chatRes.text();
    console.error(`FAIL: chat completion returned ${chatRes.status}`);
    console.error(body);
    process.exit(1);
  }

  const chat = await chatRes.json();
  const reply = chat.choices?.[0]?.message?.content?.trim() ?? '(empty)';
  console.log(`OK: model replied: ${reply}`);
  console.log('OpenAI API key is working.');
}

main().catch((err) => {
  console.error('FAIL:', err.message ?? err);
  process.exit(1);
});
