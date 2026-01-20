# Feedback Intelligence Platform

A Cloudflare Workers-based feedback aggregation and semantic search platform that uses AI to analyze, categorize, and make customer feedback queryable.

## Features

### 📊 Feedback Stream
- Real-time dashboard showing all submitted feedback
- Display sentiment, urgency, and category badges
- Automatic statistics (total feedback, processed count, sentiment breakdown)
- Auto-refresh every 10 seconds

### 📝 Feedback Submission
- Simple form to submit customer feedback
- Track feedback source (email, Discord, Twitter, web, etc.)
- Immediate confirmation with feedback ID
- Asynchronous processing pipeline

### 🔍 Semantic Search with AI Transparency
The search feature shows exactly what the AI is thinking:

**AI Thinking Process Displayed:**
1. ✓ Converts your search query to a vector embedding (768 dimensions)
2. ✓ Searches Vectorize index for similar feedback vectors
3. ✓ Ranks results by semantic similarity score
4. ✓ Retrieves full feedback details from database

**Result Transparency:**
Each result shows:
- **Relevance Score** (0-100%): How similar the feedback is to your search query
- **Explanation**: Why this feedback matched (keyword matches, semantic concepts, etc.)
- **Metadata**: Sentiment, category, urgency, status
- **Source**: Where the feedback came from (clickable)

### Example Search
```
Search: "login problems"
Results Show:
├─ 92% Match: "Login broken for 3 days"
│  └─ Explanation: Very strong semantic match. Contains keywords: login
├─ 78% Match: "Can't access my account"
│  └─ Explanation: Good semantic match. Similar concepts detected.
└─ 65% Match: "Authentication is slow"
   └─ Explanation: Moderate relevance. Some conceptual overlap.
```

## Tech Stack

- **Workers**: API gateway + frontend host (Hono framework)
- **R2**: Raw feedback storage ("The Lake")
- **D1**: Metadata database ("The Warehouse")
- **Workers AI**: Sentiment analysis & embeddings ("The Brain")
- **Vectorize**: Semantic search index ("AI Search")
- **Workflows**: Async processing pipeline ("The Agent")

## Architecture

```
Frontend → Workers API → R2/D1/AI/Vectorize/Workflows
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed diagrams and data flow.

## Getting Started

### Prerequisites
- Node.js 18+
- Cloudflare account
- wrangler CLI

### Setup

1. **Clone and install**
```bash
npm install
```

2. **Create Cloudflare Resources** (via dashboard):
   - D1 Database: `feedback-warehouse`
   - R2 Bucket: `feedback-raw`
   - Vectorize Index: `feedback-vectors` (768 dimensions, cosine distance)

3. **Update wrangler.toml**
```toml
[[d1_databases]]
binding = "D1_DB"
database_name = "feedback-warehouse"
database_id = "your-actual-database-id"  # Get from dashboard
```

4. **Initialize database**
```bash
# Run this in the Cloudflare dashboard D1 console
-- Copy contents of schema.sql
```

5. **Start development**
```bash
npm run dev
# Visit http://localhost:8787
```

### API Endpoints

#### Submit Feedback
```bash
curl -X POST http://localhost:8787/api/feedback \
  -H "Content-Type: application/json" \
  -d '{"text": "Your feedback", "source": "email"}'
```

Response: `202 Accepted`
```json
{
  "id": "uuid",
  "status": "PROCESSING",
  "message": "Feedback submitted for processing"
}
```

#### Search Feedback
```bash
curl "http://localhost:8787/api/search?q=login+problems"
```

Response: `200 OK`
```json
{
  "query": "login problems",
  "results": [
    {
      "id": "uuid",
      "original_text": "Login is broken",
      "sentiment": "NEGATIVE",
      "relevance": {
        "percentage": 92,
        "explanation": "Very strong semantic match..."
      }
    }
  ],
  "thinking": {
    "message": "Found 3 semantically similar feedback items...",
    "process": ["Step 1...", "Step 2...", ...]
  }
}
```

#### List Feedback
```bash
curl "http://localhost:8787/api/feedback?limit=50&offset=0"
```

## Feedback Processing Pipeline

When feedback is submitted:

1. **Immediately**:
   - Generate UUID
   - Upload raw JSON to R2
   - Create database record (status: PROCESSING)
   - Return 202 Accepted

2. **Async (via Workflow)**:
   - Fetch raw feedback from R2
   - Analyze sentiment (DistilBERT)
   - Classify category (keyword-based)
   - Determine urgency (keyword-based)
   - Generate embedding (BGE model)
   - Store vector in Vectorize
   - Update D1 with results (status: COMPLETED)

## How Search Works

1. **Query Vectorization**: Your search query is converted to a 768-dimensional vector using the BGE model
2. **Similarity Search**: The vector is compared against all feedback vectors in Vectorize using cosine similarity
3. **Ranking**: Results are ranked by similarity score (0-100)
4. **Explanation**: For each result, we explain why it matched (keywords, semantic concepts)
5. **Hydration**: Full feedback details are retrieved from D1

## Sources & Transparency

The platform tracks where feedback came from:
- `email`: Customer support emails
- `discord`: Discord community messages
- `twitter`: Twitter mentions
- `github-issue`: GitHub issues
- `support-ticket`: Support ticket systems
- `web`: Web form submissions
- `other`: Other sources

Each feedback item can be traced back to its original source, which appears in:
- Search results (clickable source links)
- Feedback stream (source badge)
- API responses (source field)

## Known Limitations

1. **No authentication** (MVP stage)
2. **Synchronous feedback storage** (async processing only for AI)
3. **Keyword-based categorization** (could use ML models)
4. **No data retention policy** (stores feedback indefinitely)
5. **10-second polling** for dashboard refresh (not real-time)

## Cost

Estimated monthly cost for small-scale usage:
- Workers: $0.50 (1M requests)
- R2: $0.015 (1 GB storage)
- D1: $1.00 (1M queries)
- Vectorize: $0.20 (10K vectors)
- Workflows: $0.30 (1K executions)

**Total: ~$2-3/month**

## Product Insights

See [FRICTION_LOG.md](./FRICTION_LOG.md) for detailed Product Manager feedback on:
- Configuration complexity
- Local development gaps
- Error message clarity
- Documentation improvements
- Feature requests

## Deployment

```bash
# Deploy to Cloudflare Workers
npm run deploy

# Your app will be available at:
# https://feedback-intelligence.account.workers.dev
```

## Future Improvements

- [ ] User authentication (OAuth)
- [ ] WebSocket for real-time updates
- [ ] Advanced filtering (date range, sentiment, category)
- [ ] Bulk feedback import (CSV, JSON)
- [ ] Webhook integrations (Slack, Discord)
- [ ] Custom ML model fine-tuning
- [ ] Data export (PDF, CSV)
- [ ] Email digests of top feedback

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) - System design and data flow
- [FRICTION_LOG.md](./FRICTION_LOG.md) - Product Manager insights and feedback
- [schema.sql](./schema.sql) - Database schema
- [seed-data.ts](./seed-data.ts) - Mock feedback examples

## Support

For issues or questions:
1. Check the [ARCHITECTURE.md](./ARCHITECTURE.md) for system design questions
2. Review [FRICTION_LOG.md](./FRICTION_LOG.md) for known pain points
3. Check Cloudflare documentation links in code comments

## License

MIT

---

**Built with Cloudflare Workers**
- Workers, R2, D1, Workers AI, Vectorize, Workflows
