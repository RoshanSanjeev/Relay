import { Hono } from 'hono';
import { serveStatic } from 'hono/cloudflare-workers';

// Type definitions for environment bindings
interface FeedbackRecord {
  id: number;
  source: string;
  title?: string;
  content: string;
  author?: string;
  sentiment?: string;
  urgency?: string;
  theme?: string;
  created_at: string;
  analyzed_at?: string;
  metadata?: string;
}

interface SearchResult extends FeedbackRecord {
  score?: number;
}

interface Env {
  D1_DB: any; // D1Database binding
  R2_BUCKET?: any; // R2 binding (optional)
  AI?: any; // Workers AI binding (optional)
  VECTORIZE_INDEX?: any; // Vectorize binding (optional)
  WORKFLOW?: any; // Workflows binding (optional)
}

const app = new Hono<{ Bindings: Env }>();

// Health check endpoint
app.get('/api/health', (c) => {
  return c.json({ status: 'ok' });
});

// POST /api/feedback - Submit new feedback
// Returns 202 Accepted (async processing)
app.post('/api/feedback', async (c) => {
  const body = await c.req.json<{ content: string; source?: string; title?: string; author?: string }>();

  if (!body.content) {
    return c.json({ error: 'content field is required' }, { status: 400 });
  }

  const timestamp = new Date().toISOString();

  try {
    // Step 1: Create record in D1
    const insertQuery = `
      INSERT INTO feedback (source, content, author, title, created_at, sentiment, urgency, theme)
      VALUES (?, ?, ?, ?, ?, 'neutral', 'medium', NULL)
    `;

    const result = await c.env.D1_DB.prepare(insertQuery).bind(
      body.source || 'web',
      body.content,
      body.author || null,
      body.title || null,
      timestamp
    ).run();

    const feedbackId = result.meta.last_row_id;

    // Step 2: Trigger Workflow for AI analysis (optional)
    try {
      if (c.env.WORKFLOW) {
        await c.env.WORKFLOW.create('process-feedback', {
          feedbackId,
          content: body.content,
        });
      }
    } catch (err) {
      console.error('Workflow trigger failed:', err);
      // Continue even if workflow trigger fails
    }

    return c.json(
      {
        id: feedbackId,
        source: body.source || 'web',
        message: 'Feedback submitted successfully',
      },
      { status: 202 }
    );
  } catch (error) {
    console.error('Error submitting feedback:', error);
    return c.json(
      { error: 'Failed to process feedback submission', details: String(error) },
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
      SELECT id, source, content, author, title, sentiment, urgency, theme, created_at, analyzed_at
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
      { error: 'Failed to fetch feedback', details: String(error) },
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

// GET /api/search - Search feedback (keyword + semantic)
app.get('/api/search', async (c) => {
  const query = c.req.query('q');

  if (!query) {
    return c.json({ error: 'q parameter is required' }, { status: 400 });
  }

  try {
    // Try semantic search with Vectorize if available
    let results: FeedbackRecord[] = [];
    let usedVectorize = false;

    try {
      if (c.env.AI && c.env.VECTORIZE_INDEX) {
        // Step 1: Generate embedding for search query using Workers AI
        const aiResponse = await c.env.AI.run('@cf/baai/bge-base-en-v1.5', {
          text: query,
        });

        const queryVector = (aiResponse as any).data[0];

        // Step 2: Query Vectorize index
        const searchResults = await c.env.VECTORIZE_INDEX.query(queryVector, {
          topK: 10,
          returnMetadata: 'all',
        });

        const feedbackIds = searchResults.matches.map((m: any) => m.id);

        if (feedbackIds.length > 0) {
          const placeholders = feedbackIds.map(() => '?').join(',');
          const hydrationQuery = `SELECT * FROM feedback WHERE id IN (${placeholders})`;
          const dbResults = await c.env.D1_DB.prepare(hydrationQuery)
            .bind(...feedbackIds)
            .all<FeedbackRecord>();
          results = dbResults.results || [];
          usedVectorize = true;
        }
      }
    } catch (vecError) {
      console.warn('Vectorize search failed, falling back to keyword search:', vecError);
    }

    // Fallback: Keyword search if Vectorize unavailable or no results
    if (results.length === 0) {
      const searchQuery = `
        SELECT id, source, content, author, title, sentiment, urgency, theme, created_at
        FROM feedback
        WHERE content LIKE ? OR title LIKE ? OR theme LIKE ?
        ORDER BY created_at DESC
        LIMIT 10
      `;

      const searchTerm = `%${query}%`;
      const dbResults = await c.env.D1_DB.prepare(searchQuery)
        .bind(searchTerm, searchTerm, searchTerm)
        .all<FeedbackRecord>();

      results = dbResults.results || [];
    }

    // Enrich results with relevance scores
    const enrichedResults = results.map((feedback) => {
      const content = (feedback.content || '').toLowerCase();
      const queryTerms = (query || '').toLowerCase().split(/\s+/);
      const matches = queryTerms.filter(t => content.includes(t)).length;
      const relevancePercentage = queryTerms.length > 0 ? Math.round((matches / queryTerms.length) * 100) : 0;

      return {
        ...feedback,
        relevance: {
          percentage: Math.max(20, relevancePercentage),
          explanation: getRelevanceExplanation(feedback, query, relevancePercentage),
        },
      };
    });

    return c.json({
      query,
      results: enrichedResults,
      matches: results.length,
      thinking: {
        searchType: usedVectorize ? 'semantic' : 'keyword',
        message: `Found ${results.length} feedback items matching "${query}"`,
        process: usedVectorize
          ? [
              '1. Converted your search query to a vector embedding (768 dimensions)',
              '2. Searched Vectorize index for similar feedback vectors',
              '3. Ranked results by semantic similarity score',
              '4. Retrieved full feedback details from database',
            ]
          : [
              '1. Searched feedback content for keyword matches',
              '2. Searched titles and themes for relevance',
              '3. Ranked results by match frequency',
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
          searchType: 'error',
          message: 'Error during search processing',
        },
      },
      { status: 500 }
    );
  }
});

// Helper function to generate relevance explanation
function getRelevanceExplanation(feedback: FeedbackRecord, query: string, score: number): string {
  const text = (feedback.content || '').toLowerCase();
  const queryLower = (query || '').toLowerCase();
  const words = queryLower.split(/\s+/).filter(w => w.length > 0);

  // Find matching keywords
  const matchedKeywords = words.filter(w => text.includes(w));

  if (score > 80) {
    return `Very strong match. ${matchedKeywords.length > 0 ? `Keywords: ${matchedKeywords.slice(0, 3).join(', ')}` : 'High relevance'}`;
  } else if (score > 60) {
    return `Good match. Similar content and language patterns detected.`;
  } else if (score > 40) {
    return `Moderate relevance. Some content overlap with your search.`;
  } else {
    return `Related feedback. Could be relevant to your search.`;
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
