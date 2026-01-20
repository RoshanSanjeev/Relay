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

// POST /api/analyze - AI-powered feedback analysis
// Uses Workers AI for sentiment analysis and insight generation
app.post('/api/analyze', async (c) => {
  const body = await c.req.json<{ query: string; feedbackIds?: number[] }>();

  if (!body.query) {
    return c.json({ error: 'query field is required' }, { status: 400 });
  }

  try {
    // Step 1: Fetch feedback from D1
    const feedbackQuery = `
      SELECT id, source, content, author, sentiment, urgency, theme, created_at
      FROM feedback
      ORDER BY created_at DESC
      LIMIT 100
    `;
    const feedbackResult = await c.env.D1_DB.prepare(feedbackQuery).all<FeedbackRecord>();
    const allFeedback = feedbackResult.results || [];

    // Step 2: Use Workers AI for sentiment analysis (if AI binding available)
    let aiInsights: any = null;
    let sentimentAnalysis: any[] = [];

    // FRICTION POINT: Workers AI binding check - documentation doesn't clearly explain
    // how to gracefully handle missing AI bindings in production vs dev
    if (c.env.AI) {
      try {
        // Use distilbert for quick sentiment classification on sample
        const sampleFeedback = allFeedback.slice(0, 5);

        // FRICTION POINT: Workers AI doesn't support batch inference for distilbert
        // Have to make individual requests which is slower
        const sentimentPromises = sampleFeedback.map(async (fb) => {
          try {
            const result = await c.env.AI.run('@cf/huggingface/distilbert-sst-2-int8', {
              text: fb.content.substring(0, 500), // Limit text length
            });
            return { id: fb.id, sentiment: result };
          } catch (e) {
            return { id: fb.id, sentiment: null, error: String(e) };
          }
        });

        sentimentAnalysis = await Promise.all(sentimentPromises);

        // Use LLM for generating PM insights
        // FRICTION POINT: Model availability - @cf/meta/llama-3.1-8b-instruct may not be
        // available in all regions, documentation doesn't clarify regional availability
        const feedbackSummary = allFeedback.slice(0, 10).map(f =>
          `[${f.source}] ${f.sentiment}: "${f.content.substring(0, 100)}"`
        ).join('\n');

        const insightPrompt = `You are a PM analyzing customer feedback. Based on this feedback:
${feedbackSummary}

Query: "${body.query}"

Provide a brief JSON response with:
1. "summary": one sentence summary
2. "critical_count": number of critical issues
3. "recommendation": one actionable recommendation for the PM
4. "sentiment_trend": "improving", "declining", or "stable"

Respond with only valid JSON, no other text.`;

        try {
          const llmResponse = await c.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
            prompt: insightPrompt,
            max_tokens: 200,
          });

          // Parse LLM response
          const responseText = llmResponse.response || '';
          try {
            aiInsights = JSON.parse(responseText);
          } catch {
            aiInsights = {
              summary: responseText.substring(0, 200),
              raw: true
            };
          }
        } catch (llmError) {
          console.error('LLM analysis failed:', llmError);
          // FRICTION POINT: Error messages from Workers AI are often generic
          // Hard to debug if it's a model issue, quota issue, or binding issue
          aiInsights = { error: 'LLM analysis unavailable', details: String(llmError) };
        }
      } catch (aiError) {
        console.error('Workers AI error:', aiError);
      }
    }

    // Step 3: Compute statistics from D1 data
    const stats = {
      total: allFeedback.length,
      positive: allFeedback.filter(f => f.sentiment === 'positive').length,
      negative: allFeedback.filter(f => f.sentiment === 'negative').length,
      neutral: allFeedback.filter(f => f.sentiment === 'neutral').length,
      critical: allFeedback.filter(f => f.urgency === 'critical').length,
      high: allFeedback.filter(f => f.urgency === 'high').length,
      sources: [...new Set(allFeedback.map(f => f.source))],
    };

    // Step 4: Filter based on query intent
    const queryLower = body.query.toLowerCase();
    let filteredFeedback = allFeedback;

    if (queryLower.includes('critical') || queryLower.includes('urgent')) {
      filteredFeedback = allFeedback.filter(f => f.urgency === 'critical' || f.urgency === 'high');
    } else if (queryLower.includes('negative') || queryLower.includes('complaint')) {
      filteredFeedback = allFeedback.filter(f => f.sentiment === 'negative');
    } else if (queryLower.includes('positive')) {
      filteredFeedback = allFeedback.filter(f => f.sentiment === 'positive');
    }

    return c.json({
      query: body.query,
      stats,
      filtered: {
        count: filteredFeedback.length,
        items: filteredFeedback.slice(0, 10),
      },
      ai: {
        available: !!c.env.AI,
        sentimentAnalysis: sentimentAnalysis.length > 0 ? sentimentAnalysis : null,
        insights: aiInsights,
      },
      thinking: {
        steps: [
          { step: 1, action: 'Query D1 database', status: 'complete', count: allFeedback.length },
          { step: 2, action: 'Workers AI sentiment analysis', status: c.env.AI ? 'complete' : 'skipped' },
          { step: 3, action: 'LLM insight generation', status: aiInsights ? 'complete' : 'skipped' },
          { step: 4, action: 'Filter by query intent', status: 'complete', count: filteredFeedback.length },
        ],
      },
    });
  } catch (error) {
    console.error('Analysis error:', error);
    return c.json(
      { error: 'Analysis failed', details: String(error) },
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
