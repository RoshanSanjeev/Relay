# Deployment Guide

This guide walks through deploying the Feedback Intelligence Platform to Cloudflare Workers.

## Prerequisites

1. **Cloudflare Account** (free tier works for MVP)
2. **Node.js 18+** installed
3. **wrangler CLI** installed (`npm install -g wrangler`)
4. **Cloudflare API Token** for programmatic access

## Step-by-Step Deployment

### Step 1: Create Cloudflare Resources

#### 1a. Create D1 Database

1. Log in to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Navigate to **Workers & Pages** → **D1**
3. Click **Create database**
4. Enter name: `feedback-warehouse`
5. Click **Create**
6. Copy the **Database ID** (you'll need this for `wrangler.toml`)

**Initialize Schema:**
1. Go to your database in D1
2. Click **Console**
3. Copy the contents of `schema.sql` from this project
4. Paste into the console
5. Execute the SQL to create tables and indexes

**Expected Output:**
```
CREATE TABLE feedback (...)
CREATE INDEX idx_feedback_status ...
✓ All tables created successfully
```

#### 1b. Create R2 Bucket

1. Navigate to **R2** in Cloudflare Dashboard
2. Click **Create bucket**
3. Enter name: `feedback-raw`
4. Keep other settings default
5. Click **Create bucket**

**Note:** No additional configuration needed - binding will handle auth automatically

#### 1c. Create Vectorize Index

1. Navigate to **Vectorize** in Cloudflare Dashboard
2. Click **Create index**
3. Enter name: `feedback-vectors`
4. **Vector dimensions:** `768` (matches BGE embedding model)
5. **Distance metric:** `cosine`
6. Click **Create**

**Note:** Document the index name exactly as entered (case-sensitive)

#### 1d. Verify Workers AI Access

1. Navigate to **Workers AI** in Cloudflare Dashboard
2. Verify you have access to at least:
   - `@cf/huggingface/distilbert-sst-2-en` (sentiment)
   - `@cf/baai/bge-base-en-v1.5` (embeddings)

**Note:** Free tier may have rate limits. Production should upgrade to paid plan.

### Step 2: Update wrangler.toml

Replace placeholder values in `wrangler.toml`:

```toml
# Replace "mock-db-id" with your actual D1 database ID
[[d1_databases]]
binding = "D1_DB"
database_name = "feedback-warehouse"
database_id = "your-actual-database-id-here"  # <-- FROM STEP 1a
```

**To find your database ID:**
1. Go to D1 in dashboard
2. Click your database name
3. Copy the ID from the URL or info panel

### Step 3: Authenticate with Cloudflare

```bash
# Log in to Cloudflare
wrangler login

# This will open a browser to authenticate
# Authorize the CLI to access your account
```

**Verification:**
```bash
# Check authentication worked
wrangler whoami
# Should output your Cloudflare account info
```

### Step 4: Deploy to Workers

```bash
# From the project root
npm run deploy

# This will:
# 1. Build the project
# 2. Create/update the Worker
# 3. Bind all resources
# 4. Deploy to edge
```

**Expected Output:**
```
⛅️ wrangler 4.59.2
├ Uploading... [########] 100%
├ Uploading your Worker to Cloudflare...
└ ✨ Success! Your Worker is live

🔗 Deployed to: https://feedback-intelligence.account.workers.dev
```

### Step 5: Verify Deployment

**Test Health Endpoint:**
```bash
curl https://feedback-intelligence.account.workers.dev/api/health

# Expected response:
# {"status":"ok"}
```

**Test Frontend:**
```bash
# Open in browser
https://feedback-intelligence.account.workers.dev

# Should see:
# - Header: "🔍 Feedback Intelligence"
# - Three tabs: Feedback Stream, Submit Feedback, Search
# - Statistics dashboard (showing 0 items initially)
```

**Test Feedback Submission:**
```bash
curl -X POST https://feedback-intelligence.account.workers.dev/api/feedback \
  -H "Content-Type: application/json" \
  -d '{"text":"Test feedback from deployment","source":"cli"}'

# Expected response (202 Accepted):
# {
#   "id": "uuid-here",
#   "status": "PROCESSING",
#   "message": "Feedback submitted for processing"
# }
```

**Test List Endpoint:**
```bash
curl https://feedback-intelligence.account.workers.dev/api/feedback

# Expected response:
# {
#   "data": [...],
#   "success": true
# }
```

**Test Search (requires processed feedback):**
```bash
curl "https://feedback-intelligence.account.workers.dev/api/search?q=test"

# Note: May return empty results if workflows haven't processed yet
# This is expected initially
```

## Troubleshooting Deployment

### Issue: "Database ID not found"
**Solution:**
1. Verify database exists in D1 dashboard
2. Copy exact ID from dashboard (including hyphens)
3. Update `wrangler.toml`
4. Redeploy: `npm run deploy`

### Issue: "R2 bucket does not exist"
**Solution:**
1. Verify bucket exists in R2 dashboard
2. Verify bucket name matches exactly in `wrangler.toml`
3. Redeploy: `npm run deploy`

### Issue: "Vectorize index not found"
**Solution:**
1. Create Vectorize index in dashboard (see Step 1c)
2. Verify index name matches exactly
3. Ensure dimensions = 768, metric = cosine
4. Redeploy: `npm run deploy`

### Issue: "Workers AI models unavailable"
**Solution:**
1. Verify account has Workers AI access
2. Check rate limits (free tier: limited requests/day)
3. Try upgrading to paid plan if rate limited

### Issue: "403 Forbidden" on API calls
**Solution:**
1. Verify CORS settings (currently allows all origins)
2. Check request headers
3. Verify authentication if added

### Issue: Search returns no results
**Solution:**
1. This is normal for new deployments
2. Workflows need time to process feedback
3. Check D1 to see if feedback records exist
4. Check if status = 'COMPLETED' (not 'PROCESSING')

## Local Development

If you want to test locally before deploying:

```bash
# Start local dev server
npm run dev

# Server runs at http://localhost:8787
# Frontend: http://localhost:8787
# API: http://localhost:8787/api/feedback
```

**Local Limitations:**
- Vectorize won't work (no local emulator)
- Workflows won't execute (local only)
- R2 works with local emulation
- D1 works with local SQLite

For full local testing, you need:
1. Remote D1 database configured
2. Remote R2 bucket configured
3. Accept that Vectorize queries will fail

## Production Considerations

### Security
- [ ] Add authentication (JWT, OAuth)
- [ ] Add rate limiting
- [ ] Validate/sanitize inputs
- [ ] Set CORS restrictions
- [ ] Add API keys for programmatic access

### Performance
- [ ] Enable caching on static assets
- [ ] Set up CDN for images
- [ ] Optimize database indexes
- [ ] Monitor Worker duration/CPU time

### Operations
- [ ] Set up monitoring/alerting
- [ ] Enable analytics
- [ ] Create backup strategy for D1
- [ ] Set data retention policy

### Scaling
- [ ] Test with production load
- [ ] Monitor Vectorize index size
- [ ] Plan for R2 storage growth
- [ ] Set up auto-scaling triggers

## Monitoring Deployment

### View Logs
```bash
# Stream logs from deployed Worker
wrangler tail

# Filter to errors only
wrangler tail --status error
```

### Monitor Usage

In Cloudflare Dashboard → Workers → feedback-intelligence:
- **Requests**: Total API calls
- **Errors**: Any failed requests
- **Duration**: How long Worker took
- **CPU Time**: Computation time

## Rollback Deployment

If something goes wrong:

```bash
# View deployment history
wrangler deployments list

# Rollback to previous version (if available)
wrangler rollback

# Or redeploy from current code
npm run deploy
```

## Next Steps

1. ✅ Application is deployed and accessible
2. 📊 Monitor logs and metrics
3. 🔒 Add authentication for production
4. 📈 Set up analytics and monitoring
5. 🚀 Configure auto-scaling if needed
6. 📝 Create runbook for common issues

## Support

**Resources:**
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [D1 Documentation](https://developers.cloudflare.com/d1/)
- [R2 Documentation](https://developers.cloudflare.com/r2/)
- [Vectorize Docs](https://developers.cloudflare.com/vectorize/)
- [Workers AI Docs](https://developers.cloudflare.com/workers-ai/)

**Getting Help:**
1. Check [FRICTION_LOG.md](./FRICTION_LOG.md) for known issues
2. Review [ARCHITECTURE.md](./ARCHITECTURE.md) for system design
3. Check Cloudflare community forums
4. Review Worker logs: `wrangler tail`
