# Feedback Intelligence Platform - Architecture

## Overview

The Feedback Intelligence Platform is a Cloudflare Workers-based application that aggregates, analyzes, and enables semantic search across customer feedback. It mimics the functionality of "Rox" by Roshan Sanjeev, using Cloudflare's native products to build a complete feedback intelligence pipeline.

## High-Level Architecture

```
┌─────────────────────┐
│   Frontend (React)  │  Served via Workers Static Assets
│  - Feedback Stream  │  (public/index.html)
│  - Submit Form      │
│  - Search Interface │
└──────────┬──────────┘
           │ HTTP/HTTPS
           ▼
┌──────────────────────────────────────────────────┐
│         Cloudflare Workers (Hono API)            │
├──────────────────────────────────────────────────┤
│  POST   /api/feedback  → Create feedback         │
│  GET    /api/feedback  → List feedback           │
│  GET    /api/search    → Semantic search         │
│  GET    /api/health    → Health check            │
└──┬───────────────────┬──────────────┬────────────┘
   │                   │              │
   ▼                   ▼              ▼
┌──────────┐   ┌──────────┐   ┌──────────────┐
│   R2     │   │   D1     │   │ Workers AI   │
│ (The     │   │ (The     │   │              │
│  Lake)   │   │Warehouse)│   │ - Sentiment  │
│          │   │          │   │ - Embedding  │
└──────────┘   └──────────┘   └──────────────┘
               │
               ▼
         ┌──────────────┐
         │  Vectorize   │
         │ (AI Search)  │
         │  - Index     │
         │  - Query     │
         └──────────────┘

        Async Processing Flow:

┌─────────────────────────┐
│   Cloudflare Workflows  │
│  (The Agent)            │
├─────────────────────────┤
│ 1. Fetch from R2        │
│ 2. Analyze with AI      │
│ 3. Generate Vector      │
│ 4. Upsert to Vectorize  │
│ 5. Update D1            │
└─────────────────────────┘
```

## Cloudflare Products Used & Why

### 1. **Workers (Hono Framework)**
**Purpose**: API gateway and static asset host
**Why Chosen**:
- Provides serverless compute at edge locations globally
- Hono offers a lightweight, type-safe framework
- Built-in support for request routing and middleware
- Can serve static assets (frontend)
- Excellent TypeScript support

**Implementation**:
- `src/index.ts`: Main Hono application with routes
- Uses `serveStatic` to serve `public/index.html`
- Handles all HTTP endpoints for feedback submission and search

---

### 2. **R2 (Object Storage) - "The Lake"**
**Purpose**: Store raw, unstructured feedback data
**Why Chosen**:
- Designed for storing unstructured data at scale
- Serverless (no bucket management overhead)
- Native integration with Workers
- Cost-effective for large objects
- Perfect for archiving original feedback before processing

**Implementation**:
- Bucket: `feedback-raw`
- Stores JSON files with structure: `feedback/{feedbackId}.json`
- Binding: `R2_BUCKET` in `wrangler.toml`
- Used in: `POST /api/feedback` to store raw feedback

**Data Format**:
```json
{
  "id": "uuid",
  "text": "user feedback text",
  "source": "email|discord|twitter|web",
  "timestamp": "2025-01-19T..."
}
```

---

### 3. **D1 (Serverless SQL Database) - "The Warehouse"**
**Purpose**: Store structured metadata and analysis results
**Why Chosen**:
- Serverless SQL database (no provisioning needed)
- Perfect for metadata and queryable results
- Native bindings in Workers
- Good query performance for analytics
- Supports indexing for fast lookups

**Implementation**:
- Database: `feedback-warehouse`
- Table: `feedback` (see `schema.sql`)
- Binding: `D1_DB` in `wrangler.toml`

**Schema**:
```sql
CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  status TEXT ('PROCESSING' | 'COMPLETED'),
  r2_key TEXT (reference to R2 object),
  original_text TEXT,
  sentiment TEXT ('POSITIVE' | 'NEGATIVE' | 'NEUTRAL'),
  category TEXT,
  urgency TEXT ('critical' | 'high' | 'medium' | 'low'),
  summary TEXT,
  vector_id TEXT (reference to Vectorize),
  tags TEXT (comma-separated),
  updated_at TEXT,
  processing_completed_at TEXT
);
```

**Indices**:
- `idx_feedback_status`: Fast filtering by processing status
- `idx_feedback_sentiment`: Aggregate by sentiment
- `idx_feedback_category`: Group by category
- `idx_feedback_created_at`: Sort by recency

---

### 4. **Workers AI (Machine Learning) - "The Brain"**
**Purpose**: AI-powered analysis of feedback
**Why Chosen**:
- Runs directly in Workers (no external API calls)
- Offers pre-trained models (no training required)
- Fast inference at edge
- Native binding in Workers
- Supports sentiment, classification, and embeddings

**Models Used**:
1. **`@cf/huggingface/distilbert-sst-2-en`**: Sentiment analysis
   - Input: feedback text
   - Output: Positive/Negative sentiment label

2. **`@cf/baai/bge-base-en-v1.5`**: Text embeddings
   - Input: feedback text
   - Output: Vector (768 dimensions)
   - Used for: Semantic search in Vectorize

3. **Custom logic**: Category classification and urgency detection
   - Keyword-based (improved models could use ML)

**Implementation**:
- Used in `Workflow` (async processing)
- Generates insights after feedback submission
- Results stored back in D1

---

### 5. **Vectorize (Vector Database) - "AI Search"**
**Purpose**: Enable semantic search across feedback
**Why Chosen**:
- Managed vector database (no setup/ops overhead)
- Native integration with Workers
- Efficient similarity search
- Can index millions of vectors
- Low latency queries

**Implementation**:
- Index: `feedback-vectors`
- Stores embeddings for each feedback item
- Binding: `VECTORIZE_INDEX` in `wrangler.toml`
- Vector dimensions: 768 (from BGE model)

**Vector Storage Format**:
```typescript
{
  id: "feedback-id",
  values: [0.123, 0.456, ...],  // 768-dim embedding
  metadata: {
    feedbackId: "uuid",
    sentiment: "POSITIVE",
    category: "Feature Request"
  }
}
```

**Search Flow**:
1. Query text → embedding (Workers AI)
2. Query embedding → vector search (Vectorize)
3. Top matches → D1 hydration
4. Results → frontend

---

### 6. **Workflows (Orchestration) - "The Agent"**
**Purpose**: Async processing pipeline for feedback
**Why Chosen**:
- Orchestrates multi-step processes
- Retries and error handling built-in
- Persists state across steps
- Perfect for: fetch → analyze → embed → store pattern

**Implementation**:
- File: `src/workflows/process-feedback.ts`
- Binding: `WORKFLOW` in `wrangler.toml`
- Triggered by: `POST /api/feedback`

**Processing Steps**:
1. **Fetch from R2**: Retrieve raw feedback
2. **Analyze with AI**: Run sentiment, category, urgency analysis
3. **Generate Embedding**: Create vector representation
4. **Upsert to Vectorize**: Store vector + metadata
5. **Update D1**: Store analysis results, set status to COMPLETED

---

## Data Flow

### Feedback Submission Flow
```
User submits feedback
       ↓
POST /api/feedback (Worker)
       ↓
1. Generate UUID
2. Upload to R2: feedback/{id}.json
3. Insert into D1: status = 'PROCESSING'
       ↓
Return 202 Accepted
       ↓
[Async] Trigger Workflow
```

### Async Processing Flow (Workflow)
```
Workflow triggered
       ↓
Step 1: Fetch from R2
       ↓
Step 2: Analyze with Workers AI
   - Sentiment (distilbert)
   - Category (keyword-based)
   - Urgency (keyword-based)
   - Summary (truncation)
       ↓
Step 3: Generate embedding with Workers AI
   - Run BGE model on feedback text
   - Get 768-dim vector
       ↓
Step 4: Upsert to Vectorize
   - Store vector with metadata
       ↓
Step 5: Update D1
   - sentiment, category, urgency, summary
   - vector_id, tags
   - status = 'COMPLETED'
       ↓
Workflow complete
```

### Search Flow
```
User enters search query
       ↓
GET /api/search?q=<query>
       ↓
1. Generate embedding for query (Workers AI)
2. Query Vectorize: find similar vectors
3. Hydrate from D1: fetch full records
       ↓
Return results with matched feedback items
```

---

## API Endpoints

### Submit Feedback
```
POST /api/feedback
Content-Type: application/json

{
  "text": "User feedback text",
  "source": "email|discord|twitter|web" (optional)
}

Response: 202 Accepted
{
  "id": "uuid",
  "status": "PROCESSING",
  "r2_key": "feedback/{id}.json",
  "message": "Feedback submitted for processing"
}
```

### List Feedback
```
GET /api/feedback?limit=50&offset=0

Response: 200 OK
{
  "data": [
    {
      "id": "uuid",
      "created_at": "2025-01-19T...",
      "status": "COMPLETED|PROCESSING",
      "original_text": "feedback",
      "sentiment": "POSITIVE|NEGATIVE|NEUTRAL",
      "category": "Bug|Feature Request|...",
      "urgency": "critical|high|medium|low",
      "summary": "..."
    }
  ],
  "success": true
}
```

### Get Single Feedback
```
GET /api/feedback/{id}

Response: 200 OK (single feedback object)
```

### Semantic Search
```
GET /api/search?q=<query>

Response: 200 OK
{
  "query": "search terms",
  "results": [
    {
      "id": "uuid",
      "original_text": "...",
      "sentiment": "POSITIVE",
      "category": "Feature Request"
    }
  ],
  "matches": 3
}
```

### Health Check
```
GET /api/health

Response: 200 OK
{
  "status": "ok"
}
```

---

## Frontend Architecture

The frontend is a single-page application (SPA) built with vanilla JavaScript (no build step needed for MVP).

**Features**:
- **Feedback Stream**: Displays all feedback with real-time stats
- **Submit Form**: UI for users to submit new feedback
- **Semantic Search**: Search feedback by semantic similarity
- **Auto-refresh**: Polls `/api/feedback` every 10 seconds
- **Responsive design**: Works on desktop and mobile

**Styling**:
- Cloudflare brand colors: Orange (`#F38020`), Black (`#000000`), White
- Font: Inter (system fallback)
- Dark theme (matches Cloudflare dashboard aesthetic)
- Badges for sentiment, urgency, category, status

**Components**:
- Header with branding
- Tab navigation
- Feedback cards with metadata
- Form for submission
- Search interface with results

---

## Development Setup

### Prerequisites
- Node.js 18+
- Cloudflare account
- wrangler CLI

### Local Development
```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Server runs on http://localhost:8787
# Frontend: http://localhost:8787/
# API: http://localhost:8787/api/feedback
```

### Create Database (Cloudflare Dashboard)
1. Go to Cloudflare Dashboard → D1
2. Create database: `feedback-warehouse`
3. Run schema: `schema.sql`
4. Update `wrangler.toml` with database ID

### Create R2 Bucket
1. Go to Cloudflare Dashboard → R2
2. Create bucket: `feedback-raw`
3. Note the bucket name in `wrangler.toml`

### Create Vectorize Index
1. Go to Cloudflare Dashboard → Vectorize
2. Create index: `feedback-vectors`
3. Dimensions: 768
4. Distance metric: cosine

### Deploy to Production
```bash
npm run deploy
# Deploys to feedback-intelligence.account.workers.dev
```

---

## Performance Considerations

### Caching
- Static assets cached at edge
- API responses not cached (real-time updates)
- Database queries use D1 indexes for performance

### Scalability
- Workers: Auto-scales globally
- R2: Unlimited storage
- D1: Supports millions of rows
- Vectorize: Supports millions of vectors

### Bottlenecks
- Workflow processing: Sequential steps (could parallelize)
- Vectorize queries: Dependent on index quality
- Workers AI: Rate limits per plan

---

## Security

### Current Implementation
- No authentication (MVP)
- Publicly accessible API
- HTTPS enforced (Workers default)

### Production Recommendations
- Add authentication (JWT, mTLS)
- Rate limiting on feedback submission
- Input validation and sanitization
- CORS restrictions
- API key authentication

---

## Cost Estimation

Based on Cloudflare pricing (as of Jan 2025):

| Service | Unit Cost | Estimated Monthly Usage | Est. Cost |
| --- | --- | --- | --- |
| Workers | $0.50 per million requests | 1M requests | $0.50 |
| R2 | $0.015 per GB | 1 GB | $0.015 |
| D1 | $0.75 + $0.20 per M reads | 1M queries | ~$1.00 |
| Vectorize | $0.20 per 100K dims | 10K vectors | $0.20 |
| Workflows | $0.30 per 1K executions | 1K workflows | $0.30 |

**Total Estimated**: ~$2-3/month for small-scale MVP

---

## Known Limitations

1. **No Authentication**: Anyone can submit/search feedback
2. **Basic Sentiment Analysis**: Uses simple models, not context-aware
3. **No Real-time Updates**: Frontend polls every 10 seconds
4. **No Data Retention Policy**: All feedback stored indefinitely
5. **Limited Search**: Only semantic, no keyword/filtering
6. **No Workflow Retry**: Failed workflows aren't retried
7. **Synchronous Feedback Submission**: Waits for R2 upload before returning

## Future Improvements

1. Add authentication and authorization
2. Implement WebSocket for real-time updates
3. Add feedback filtering/sorting UI
4. Multi-language sentiment analysis
5. Scheduled data retention cleanup
6. Advanced search (filters, date ranges)
7. Bulk import from external sources (GitHub, Discord, email)
8. Export reports (PDF, CSV)
9. Webhook integrations (Slack, Discord)
10. Custom ML model fine-tuning
