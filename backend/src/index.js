/**
 * ExamOps — Cloudflare Workers Backend
 *
 * Bindings (wrangler.toml):
 *   env.DB             — Cloudflare D1 (SQLite)
 *
 * Secrets (wrangler secret put OPENAI_API_KEY):
 *   env.OPENAI_API_KEY — OpenAI API key
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ─── Response helpers ──────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function err(message, status = 400) {
  return json({ error: message }, status);
}

const API_CALL_LIMIT = 500;

// ─── Usage helpers ─────────────────────────────────────────────────────────────

async function getCallCount(db) {
  const row = await db.prepare('SELECT call_count FROM api_usage WHERE id = 1').first();
  return row ? row.call_count : 0;
}

async function incrementAndCheck(db) {
  const count = await getCallCount(db);
  if (count >= API_CALL_LIMIT) {
    throw new Error(`API call limit reached (${API_CALL_LIMIT}). No more AI generations allowed.`);
  }
  await db.prepare('UPDATE api_usage SET call_count = call_count + 1 WHERE id = 1').run();
  return count + 1;
}

// ─── AI helpers ────────────────────────────────────────────────────────────────

/**
 * Call GPT-4o mini to generate a middle/high school math question.
 * Returns parsed { question_text, options, explanation } or throws.
 */
/** Retrieve top K chunks from course_chunks by keyword overlap with topic */
async function retrieveChunks(db, classId, topic, k = 4) {
  if (!classId) return [];
  const { results } = await db
    .prepare('SELECT content FROM course_chunks WHERE class_id = ?')
    .bind(classId)
    .all();
  if (!results.length) return [];

  const keywords = topic.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const scored = results.map(row => {
    const text = row.content.toLowerCase();
    const score = keywords.reduce((s, kw) => s + (text.split(kw).length - 1), 0);
    return { content: row.content, score };
  });
  return scored
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map(r => r.content);
}

async function generateWithAI(env, { topic, objective, numDistractors, classId }) {
  await incrementAndCheck(env.DB);

  const chunks = await retrieveChunks(env.DB, classId, topic);
  const courseContext = chunks.length
    ? `Here is relevant course material to base the question on:\n\n${chunks.join('\n\n---\n\n')}\n\n`
    : '';

  const systemPrompt =
    'You are an expert CS and math exam question writer. ' +
    'When course material is provided, base your question strictly on that content. ' +
    'Always respond with valid JSON only — no markdown fences, no text outside the JSON object.';

  const userPrompt =
    `Create an MCQ exam question.\n` +
    `Topic: ${topic}\n` +
    `Learning objective: ${objective || 'Test understanding of ' + topic}\n\n` +
    courseContext +
    `Provide exactly ${numDistractors + 1} options total. Exactly ONE must have "is_correct": true.\n\n` +
    `Use this exact JSON structure:\n` +
    `{\n` +
    `  "question_text": "The full question. For equations use plain text like x^2 + 3x - 4 = 0",\n` +
    `  "options": [\n` +
    `    {"text": "answer choice", "is_correct": true},\n` +
    `    {"text": "answer choice", "is_correct": false}\n` +
    `  ],\n` +
    `  "explanation": "Step-by-step solution showing how to reach the correct answer."\n` +
    `}`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      max_tokens: 1024,
      temperature: 0.7,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${errBody}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content ?? '';

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('GPT returned invalid JSON: ' + raw.slice(0, 200));
  }

  if (!parsed.question_text) throw new Error('GPT response missing question_text');
  if (!Array.isArray(parsed.options)) parsed.options = [];
  if (!parsed.explanation) parsed.explanation = '';

  return parsed;
}

// ─── DB helpers ────────────────────────────────────────────────────────────────

/** Snapshot current question state into question_versions before mutating. */
async function snapshotVersion(db, questionId, author = 'Instructor') {
  const q = await db
    .prepare('SELECT question_text, options, explanation, status FROM questions WHERE id = ?')
    .bind(questionId)
    .first();
  if (!q) return;

  await db
    .prepare(
      `INSERT INTO question_versions (question_id, question_text, options, explanation, status, author)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(questionId, q.question_text, q.options, q.explanation, q.status, author)
    .run();
}

/** Parse options JSON from DB (stored as string). */
function parseOptions(row) {
  if (!row) return row;
  try {
    row.options = row.options ? JSON.parse(row.options) : [];
  } catch {
    row.options = [];
  }
  return row;
}

// ─── Main fetch handler ────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      // ── POST /api/generate ──────────────────────────────────────────────────
      if (method === 'POST' && pathname === '/api/generate') {
        const body = await request.json();
        const { topic, objective = '', num_distractors = 4, class_id = null } = body;

        if (!topic) return err('topic is required');

        const aiResult = await generateWithAI(env, {
          topic,
          objective,
          numDistractors: Number(num_distractors),
          classId: class_id ? Number(class_id) : null,
        });

        return json({ ...aiResult, options: aiResult.options });
      }

      // ── POST /api/generate/variants ─────────────────────────────────────────
      if (method === 'POST' && pathname === '/api/generate/variants') {
        const body = await request.json();
        const { question_id, count = 3 } = body;

        if (!question_id) return err('question_id is required');

        const original = await env.DB.prepare('SELECT * FROM questions WHERE id = ?')
          .bind(question_id)
          .first();
        if (!original) return err('Question not found', 404);

        const variants = [];
        for (let i = 0; i < Math.min(Number(count), 5); i++) {
          const aiResult = await generateWithAI(env, {
            topic: original.topic,
            objective: original.objective || '',
            numDistractors: original.num_distractors,
          });
          variants.push(aiResult);
        }

        return json({ variants });
      }

      // ── GET /api/classes ───────────────────────────────────────────────────
      if (method === 'GET' && pathname === '/api/classes') {
        const { results } = await env.DB.prepare('SELECT * FROM classes ORDER BY id').all();
        return json(results);
      }

      // ── GET /api/usage ──────────────────────────────────────────────────────
      if (method === 'GET' && pathname === '/api/usage') {
        const count = await getCallCount(env.DB);
        return json({ used: count, limit: API_CALL_LIMIT, remaining: API_CALL_LIMIT - count });
      }

      // ── GET /api/questions ──────────────────────────────────────────────────
      if (method === 'GET' && pathname === '/api/questions') {
        const status = url.searchParams.get('status');
        const inBank = url.searchParams.get('in_bank');

        let query = 'SELECT * FROM questions';
        const conditions = [];
        const bindings = [];

        if (status) {
          conditions.push('status = ?');
          bindings.push(status);
        }
        if (inBank !== null) {
          conditions.push('in_bank = ?');
          bindings.push(inBank === 'true' ? 1 : 0);
        }
        if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
        query += ' ORDER BY updated_at DESC';

        const { results } = await env.DB.prepare(query).bind(...bindings).all();
        return json(results.map(parseOptions));
      }

      // ── POST /api/questions ─────────────────────────────────────────────────
      if (method === 'POST' && pathname === '/api/questions') {
        const body = await request.json();
        const {
          topic,
          objective = '',
          format = 'MCQ',
          num_distractors = 4,
          question_text = '',
          options = [],
          explanation = '',
          status = 'draft',
          class_id = null,
        } = body;

        if (!topic) return err('topic is required');

        const result = await env.DB.prepare(
          `INSERT INTO questions
             (topic, objective, format, num_distractors, question_text, options, explanation, status, class_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            topic,
            objective,
            format,
            Number(num_distractors),
            question_text,
            JSON.stringify(options),
            explanation,
            status,
            class_id ? Number(class_id) : null
          )
          .run();

        const newQuestion = await env.DB.prepare('SELECT * FROM questions WHERE id = ?')
          .bind(result.meta.last_row_id)
          .first();

        return json(parseOptions(newQuestion), 201);
      }

      // ── Routes under /api/questions/:id ─────────────────────────────────────
      const match = pathname.match(/^\/api\/questions\/(\d+)(\/.*)?$/);
      if (match) {
        const id = parseInt(match[1], 10);
        const sub = match[2] || '';

        // GET /api/questions/:id
        if (method === 'GET' && sub === '') {
          const row = await env.DB.prepare('SELECT * FROM questions WHERE id = ?').bind(id).first();
          if (!row) return err('Not found', 404);
          return json(parseOptions(row));
        }

        // PUT /api/questions/:id  — update content (saves version first)
        if (method === 'PUT' && sub === '') {
          const existing = await env.DB.prepare('SELECT id FROM questions WHERE id = ?').bind(id).first();
          if (!existing) return err('Not found', 404);

          const body = await request.json();
          const { question_text, options, explanation, author = 'Instructor' } = body;

          await snapshotVersion(env.DB, id, author);

          await env.DB.prepare(
            `UPDATE questions
             SET question_text = ?, options = ?, explanation = ?, updated_at = datetime('now')
             WHERE id = ?`
          )
            .bind(question_text, JSON.stringify(options ?? []), explanation, id)
            .run();

          const updated = await env.DB.prepare('SELECT * FROM questions WHERE id = ?').bind(id).first();
          return json(parseOptions(updated));
        }

        // DELETE /api/questions/:id
        if (method === 'DELETE' && sub === '') {
          const existing = await env.DB.prepare('SELECT id FROM questions WHERE id = ?').bind(id).first();
          if (!existing) return err('Not found', 404);

          await env.DB.prepare('DELETE FROM questions WHERE id = ?').bind(id).run();
          return json({ success: true });
        }

        // PATCH /api/questions/:id/status
        if (method === 'PATCH' && sub === '/status') {
          const body = await request.json();
          const { status } = body;

          const allowed = ['draft', 'approved'];
          if (!allowed.includes(status)) {
            return err(`status must be one of: ${allowed.join(', ')}`);
          }

          const existing = await env.DB.prepare('SELECT id FROM questions WHERE id = ?').bind(id).first();
          if (!existing) return err('Not found', 404);

          await env.DB.prepare(
            `UPDATE questions SET status = ?, updated_at = datetime('now') WHERE id = ?`
          )
            .bind(status, id)
            .run();

          const updated = await env.DB.prepare('SELECT * FROM questions WHERE id = ?').bind(id).first();
          return json(parseOptions(updated));
        }

        // PATCH /api/questions/:id/bank  — toggle in_bank
        if (method === 'PATCH' && sub === '/bank') {
          const body = await request.json();
          const inBank = body.in_bank ? 1 : 0;

          const existing = await env.DB.prepare('SELECT id FROM questions WHERE id = ?').bind(id).first();
          if (!existing) return err('Not found', 404);

          await env.DB.prepare(
            `UPDATE questions SET in_bank = ?, updated_at = datetime('now') WHERE id = ?`
          )
            .bind(inBank, id)
            .run();

          const updated = await env.DB.prepare('SELECT * FROM questions WHERE id = ?').bind(id).first();
          return json(parseOptions(updated));
        }

        // POST /api/questions/:id/ai-edit
        if (method === 'POST' && sub === '/ai-edit') {
          const body = await request.json();
          const { instruction } = body;
          if (!instruction) return err('instruction is required');

          await incrementAndCheck(env.DB);

          const current = await env.DB.prepare('SELECT * FROM questions WHERE id = ?').bind(id).first();
          if (!current) return err('Not found', 404);

          const currentOptions = current.options ? JSON.parse(current.options) : [];

          const systemPrompt = 'You are an expert math teacher. Always respond with valid JSON only — no markdown, no text outside the JSON.';

          const userPrompt =
            `Modify the following math exam question according to the instructor's instructions.\n\n` +
            `Current question:\n${current.question_text}\n\n` +
            `Current options:\n${currentOptions.map((o, i) => `${i + 1}. ${o.text}${o.is_correct ? ' (correct)' : ''}`).join('\n')}\n\n` +
            `Current explanation:\n${current.explanation}\n\n` +
            `Instructor instructions: ${instruction}\n\n` +
            `Keep the same MCQ format.\n` +
            `Respond with ONLY this JSON:\n` +
            `{\n` +
            `  "question_text": "...",\n` +
            `  "options": [{"text": "...", "is_correct": true/false}],\n` +
            `  "explanation": "..."\n` +
            `}`;

          const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
              model: 'gpt-4o-mini',
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
              ],
              max_tokens: 1024,
              temperature: 0.7,
              response_format: { type: 'json_object' },
            }),
          });

          if (!aiRes.ok) throw new Error(`OpenAI error ${aiRes.status}: ${await aiRes.text()}`);

          const aiData = await aiRes.json();
          const parsed = JSON.parse(aiData.choices?.[0]?.message?.content ?? '{}');
          if (!parsed.question_text) throw new Error('AI returned invalid response');

          // Snapshot before applying AI edit
          await snapshotVersion(env.DB, id, 'AI Edit');

          await env.DB.prepare(
            `UPDATE questions SET question_text = ?, options = ?, explanation = ?, updated_at = datetime('now') WHERE id = ?`
          ).bind(parsed.question_text, JSON.stringify(parsed.options ?? []), parsed.explanation ?? '', id).run();

          const updated = await env.DB.prepare('SELECT * FROM questions WHERE id = ?').bind(id).first();
          return json(parseOptions(updated));
        }

        // GET /api/questions/:id/versions
        if (method === 'GET' && sub === '/versions') {
          const { results } = await env.DB.prepare(
            'SELECT * FROM question_versions WHERE question_id = ? ORDER BY created_at DESC'
          )
            .bind(id)
            .all();

          return json(results.map(parseOptions));
        }

        // POST /api/questions/:id/revert/:versionId
        const revertMatch = sub.match(/^\/revert\/(\d+)$/);
        if (method === 'POST' && revertMatch) {
          const versionId = parseInt(revertMatch[1], 10);

          const version = await env.DB.prepare(
            'SELECT * FROM question_versions WHERE id = ? AND question_id = ?'
          )
            .bind(versionId, id)
            .first();
          if (!version) return err('Version not found', 404);

          await env.DB.prepare(
            `UPDATE questions
             SET question_text = ?, options = ?, explanation = ?, updated_at = datetime('now')
             WHERE id = ?`
          )
            .bind(version.question_text, version.options, version.explanation, id)
            .run();

          const updated = await env.DB.prepare('SELECT * FROM questions WHERE id = ?').bind(id).first();
          return json(parseOptions(updated));
        }
      }

      return err('Not found', 404);
    } catch (e) {
      console.error(e);
      return err(e.message || 'Internal server error', 500);
    }
  },
};
