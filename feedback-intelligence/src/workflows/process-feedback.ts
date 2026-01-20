// Feedback Processing Workflow
// This workflow is triggered when new feedback is submitted.
// It orchestrates the AI analysis pipeline and updates metadata.

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers';

interface ProcessFeedbackPayload {
  feedbackId: string;
  r2Key: string;
}

interface AnalysisResult {
  sentiment: string;
  category: string;
  urgency: string;
  summary: string;
  tags: string[];
}

// FRICTION: Cloudflare Workflows documentation shows basic examples
// but doesn't clearly explain:
// 1. How to access bindings from within workflow steps
// 2. The exact timeout and retry behavior
// 3. How to properly serialize/deserialize complex types
// 4. Best practices for error handling within distributed workflow steps

export class ProcessFeedbackWorkflow extends WorkflowEntrypoint<unknown, ProcessFeedbackPayload> {
  async run(payload: ProcessFeedbackPayload, steps: WorkflowStep, { R2_BUCKET, D1_DB, AI, VECTORIZE_INDEX }: any) {
    // Step 1: Fetch raw feedback from R2
    const rawFeedback = await steps.do('fetch-from-r2', async () => {
      const object = await R2_BUCKET.get(payload.r2Key);
      if (!object) {
        throw new Error(`Could not find ${payload.r2Key} in R2`);
      }
      return JSON.parse(await object.text());
    });

    // Step 2: Analyze with Workers AI
    const analysis = await steps.do('analyze-with-ai', async () => {
      const text = rawFeedback.text;

      // FRICTION: Workers AI doesn't have a single "analyze" endpoint.
      // Must call multiple models separately for sentiment, classification, etc.
      // No batch processing API, so multiple calls needed.

      // Sentiment analysis
      const sentimentResponse = await AI.run('@cf/huggingface/distilbert-sst-2-en', {
        text,
      });

      const sentiment = (sentimentResponse as any).labels?.[0]?.label || 'neutral';

      // Category classification (mock - in real app would use a classifier)
      const categories = ['Bug', 'Feature Request', 'Documentation', 'Performance', 'Other'];
      const categoryScore = await AI.run('@cf/baai/bge-base-en-v1.5', {
        text,
      });

      const category = categories[0]; // Mock categorization

      // Urgency determination (based on keywords)
      const urgencyKeywords = {
        critical: ['broken', 'crash', 'emergency', 'urgent'],
        high: ['issue', 'problem', 'bug', 'error'],
        medium: ['improve', 'slow', 'suggest'],
        low: ['nice', 'idea', 'thanks'],
      };

      let urgency = 'low';
      const lowerText = text.toLowerCase();
      for (const [level, keywords] of Object.entries(urgencyKeywords)) {
        if (keywords.some(k => lowerText.includes(k))) {
          urgency = level;
          break;
        }
      }

      // Generate summary (using a mock for now - would use summarization model in production)
      const summary = text.length > 100 ? text.substring(0, 97) + '...' : text;

      return {
        sentiment,
        category,
        urgency,
        summary,
        tags: extractTags(text),
      };
    });

    // Step 3: Generate vector embedding
    const vector = await steps.do('generate-embedding', async () => {
      // FRICTION: After generating embeddings, no clear way to test them locally.
      // The vector dimensions and format depend on the model used.
      const embeddingResponse = await AI.run('@cf/baai/bge-base-en-v1.5', {
        text: rawFeedback.text,
      });

      return (embeddingResponse as any).data[0] || [];
    });

    // Step 4: Upsert into Vectorize
    const vectorId = await steps.do('upsert-to-vectorize', async () => {
      // FRICTION: Vectorize upsert requires knowing the index structure in advance.
      // No schema validation or type safety for vectors.
      const id = `${payload.feedbackId}`;

      // Note: This would normally upsert, but for MVP we'll generate the ID locally
      try {
        await VECTORIZE_INDEX.upsert([
          {
            id,
            values: vector,
            metadata: {
              feedbackId: payload.feedbackId,
              sentiment: analysis.sentiment,
              category: analysis.category,
            },
          },
        ]);
      } catch (err) {
        console.warn('Vectorize upsert failed, continuing:', err);
      }

      return id;
    });

    // Step 5: Update D1 with results
    await steps.do('update-d1', async () => {
      const updateQuery = `
        UPDATE feedback
        SET status = 'COMPLETED',
            sentiment = ?,
            category = ?,
            urgency = ?,
            summary = ?,
            vector_id = ?,
            tags = ?,
            processing_completed_at = ?
        WHERE id = ?
      `;

      await D1_DB.prepare(updateQuery)
        .bind(
          analysis.sentiment,
          analysis.category,
          analysis.urgency,
          analysis.summary,
          vectorId,
          analysis.tags.join(','),
          new Date().toISOString(),
          payload.feedbackId
        )
        .run();
    });

    return {
      success: true,
      feedbackId: payload.feedbackId,
      analysis,
      vectorId,
    };
  }
}

// Helper to extract tags from feedback text
function extractTags(text: string): string[] {
  const tags = new Set<string>();

  // Simple keyword-based tagging
  const tagMap: Record<string, string[]> = {
    'UX': ['ui', 'interface', 'design', 'button', 'color', 'layout'],
    'Performance': ['slow', 'fast', 'speed', 'lag', 'timeout', 'latency'],
    'Documentation': ['doc', 'guide', 'readme', 'tutorial', 'example'],
    'Mobile': ['mobile', 'phone', 'ios', 'android', 'responsive'],
    'API': ['api', 'endpoint', 'rest', 'graphql', 'sdk'],
    'Security': ['security', 'auth', 'ssl', 'encrypt', 'token'],
    'Crash': ['crash', 'error', 'fail', 'exception', 'broken'],
  };

  const lowerText = text.toLowerCase();
  for (const [tag, keywords] of Object.entries(tagMap)) {
    if (keywords.some(k => lowerText.includes(k))) {
      tags.add(tag);
    }
  }

  return Array.from(tags);
}
