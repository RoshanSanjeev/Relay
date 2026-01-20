import { Hono } from 'hono';
import { serveStatic } from 'hono/cloudflare-workers';

// Type definitions for environment bindings
interface FeedbackRecord {
  id: string;
  created_at: string;
  status: string;
  r2_key: string;
  original_text: string;
  sentiment?: string;
  category?: string;
  urgency?: string;
  summary?: string;
  vector_id?: string;
  tags?: string;
}

interface SearchResult extends FeedbackRecord {
  score?: number;
}

interface Env {
  R2_BUCKET: R2Bucket;
  D1_DB: D1Database;
  AI: Ai;
  VECTORIZE_INDEX: VectorizeIndex;
  WORKFLOW: any;
}

const app = new Hono<{ Bindings: Env }>();

// Health check endpoint
app.get('/api/health', (c) => {
  return c.json({ status: 'ok' });
});

// POST /api/feedback - Submit new feedback
// Returns 202 Accepted (async processing)
app.post('/api/feedback', async (c) => {
  const body = await c.req.json<{ text: string; source?: string }>();

  if (!body.text) {
    return c.json({ error: 'text field is required' }, { status: 400 });
  }

  const feedbackId = crypto.randomUUID();
  const r2Key = `feedback/${feedbackId}.json`;
  const timestamp = new Date().toISOString();

  try {
    // Step 1: Upload raw feedback to R2
    // FRICTION: R2 API requires creating an object and uploading in one call.
    // This is efficient but less flexible than traditional object storage APIs.
    const rawPayload = {
      id: feedbackId,
      text: body.text,
      source: body.source || 'web',
      timestamp,
    };

    await c.env.R2_BUCKET.put(r2Key, JSON.stringify(rawPayload), {
      httpMetadata: {
        contentType: 'application/json',
      },
    });

    // Step 2: Create initial record in D1 with PROCESSING status
    // FRICTION: D1 bindings work, but errors don't provide good context about
    // which SQL failed or what the actual issue was.
    const insertQuery = `
      INSERT INTO feedback (id, r2_key, original_text, status, created_at)
      VALUES (?, ?, ?, 'PROCESSING', ?)
    `;

    await c.env.D1_DB.prepare(insertQuery).bind(
      feedbackId,
      r2Key,
      body.text,
      timestamp
    ).run();

    // Step 3: Trigger Workflow
    // FRICTION: The Workflow binding documentation is sparse.
    // Hard to find examples of how to pass parameters to triggered workflows.
    try {
      // Note: This would trigger the workflow if configured correctly.
      // In development, workflows may not execute immediately.
      if (c.env.WORKFLOW) {
        await c.env.WORKFLOW.create('process-feedback', {
          feedbackId,
          r2Key,
        });
      }
    } catch (err) {
      console.error('Workflow trigger failed:', err);
      // Continue even if workflow trigger fails - we can retry later
    }

    return c.json(
      {
        id: feedbackId,
        status: 'PROCESSING',
        r2_key: r2Key,
        message: 'Feedback submitted for processing',
      },
      { status: 202 }
    );
  } catch (error) {
    console.error('Error submitting feedback:', error);
    return c.json(
      { error: 'Failed to process feedback submission' },
      { status: 500 }
    );
  }
});

// GET /api/feedback - List all feedback
app.get('/api/feedback', async (c) => {
  try {
    const limit = c.req.query('limit') || '50';
    const offset = c.req.query('offset') || '0';

    const query = `
      SELECT id, created_at, status, original_text, sentiment, category, urgency, summary
      FROM feedback
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `;

    const result = await c.env.D1_DB.prepare(query)
      .bind(parseInt(limit), parseInt(offset))
      .all<FeedbackRecord>();

    return c.json({
      data: result.results || [],
      success: true,
    });
  } catch (error) {
    console.error('Error fetching feedback:', error);
    return c.json(
      { error: 'Failed to fetch feedback' },
      { status: 500 }
    );
  }
});

// GET /api/feedback/:id - Get single feedback item
app.get('/api/feedback/:id', async (c) => {
  const id = c.req.param('id');

  try {
    const query = 'SELECT * FROM feedback WHERE id = ?';
    const result = await c.env.D1_DB.prepare(query).bind(id).first<FeedbackRecord>();

    if (!result) {
      return c.json({ error: 'Feedback not found' }, { status: 404 });
    }

    return c.json(result);
  } catch (error) {
    console.error('Error fetching feedback:', error);
    return c.json(
      { error: 'Failed to fetch feedback' },
      { status: 500 }
    );
  }
});

// GET /api/search - Semantic search using Vectorize
// FRICTION: Vectorize requires that embeddings already exist.
// There's a chicken-and-egg problem during development: can't search
// without vectors, can't easily generate vectors without the workflow running.
app.get('/api/search', async (c) => {
  const query = c.req.query('q');

  if (!query) {
    return c.json({ error: 'q parameter is required' }, { status: 400 });
  }

  try {
    // Step 1: Generate embedding for search query using Workers AI
    const aiResponse = await c.env.AI.run('@cf/baai/bge-base-en-v1.5', {
      text: query,
    });

    const queryVector = (aiResponse as any).data[0];

    // Step 2: Query Vectorize index
    // FRICTION: No local Vectorize emulation means can't test this in wrangler dev.
    // Must deploy to actually test vector search functionality.
    const searchResults = await c.env.VECTORIZE_INDEX.query(queryVector, {
      topK: 10,
      returnMetadata: 'all',
    });

    // Step 3: Hydrate results from D1
    const feedbackIds = searchResults.matches.map((m: any) => m.id);

    if (feedbackIds.length === 0) {
      return c.json({
        query,
        results: [],
        matches: 0,
        thinking: {
          queryEmbedded: true,
          vectorSearchPerformed: true,
          message: 'No similar feedback found for your query',
        },
      });
    }

    const placeholders = feedbackIds.map(() => '?').join(',');
    const hydrationQuery = `
      SELECT * FROM feedback WHERE id IN (${placeholders})
    `;

    const results = await c.env.D1_DB.prepare(hydrationQuery)
      .bind(...feedbackIds)
      .all<FeedbackRecord>();

    // Combine results with relevance scores from Vectorize
    const enrichedResults = (results.results || []).map((feedback, index) => {
      const match = searchResults.matches[index];
      const relevanceScore = match?.score || 0;

      // Calculate relevance percentage (0-100)
      const relevancePercentage = Math.round((1 - (1 - relevanceScore)) * 100);

      return {
        ...feedback,
        relevance: {
          score: relevanceScore,
          percentage: Math.max(0, Math.min(100, relevancePercentage)),
          explanation: getRelevanceExplanation(feedback, query, relevancePercentage),
        },
      };
    });

    return c.json({
      query,
      results: enrichedResults,
      matches: searchResults.matches.length,
      thinking: {
        queryEmbedded: true,
        vectorSearchPerformed: true,
        embeddingModel: '@cf/baai/bge-base-en-v1.5',
        topKUsed: 10,
        message: `Found ${searchResults.matches.length} semantically similar feedback items for "${query}"`,
        process: [
          '1. Converted your search query to a vector embedding (768 dimensions)',
          '2. Searched Vectorize index for similar feedback vectors',
          '3. Ranked results by semantic similarity score',
          '4. Retrieved full feedback details from database',
        ],
      },
    });
  } catch (error) {
    console.error('Error performing search:', error);
    return c.json(
      {
        error: 'Search failed',
        details: String(error),
        thinking: {
          queryEmbedded: false,
          vectorSearchPerformed: false,
          message: 'Error during semantic search processing',
        },
      },
      { status: 500 }
    );
  }
});

// Helper function to generate relevance explanation
function getRelevanceExplanation(feedback: FeedbackRecord, query: string, score: number): string {
  const text = feedback.original_text.toLowerCase();
  const queryLower = query.toLowerCase();
  const words = queryLower.split(/\s+/);

  // Find matching keywords
  const matchedKeywords = words.filter(w => text.includes(w));

  if (score > 80) {
    return `Very strong semantic match. ${matchedKeywords.length > 0 ? `Contains keywords: ${matchedKeywords.slice(0, 3).join(', ')}` : 'High semantic similarity'}`;
  } else if (score > 60) {
    return `Good semantic match. Similar concepts and language patterns detected.`;
  } else if (score > 40) {
    return `Moderate relevance. Some conceptual overlap with your search.`;
  } else {
    return `Related feedback. Weak semantic match but could be relevant.`;
  }
}

// Serve static React frontend
app.use('/*', serveStatic({ root: './public' }));

// Default 404 for API paths
app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: 'Not Found' }, { status: 404 });
  }
  return c.notFound();
});

export default app;
