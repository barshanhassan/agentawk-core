/**
 * WHITE-LABEL IMPLEMENTATION - QUICK START GUIDE
 * 
 * All core functionality is implemented locally (not pushed to Git)
 * Follow these steps to finalize the setup
 */

// ──────────────────────────────────────────────────────────────
// STEP 1: Install Required Dependencies
// ──────────────────────────────────────────────────────────────

// Add to package.json and install:
npm install ioredis

// ──────────────────────────────────────────────────────────────
// STEP 2: Configure Environment Variables (.env)
// ──────────────────────────────────────────────────────────────

// Redis Configuration
REDIS_HOST=localhost
REDIS_PORT=6379

// Chargebee White-Label Addon Pricing (from Chargebee dashboard)
BILLING_WHITELABEL_ADDON_PRICE_ID=price_xxxxx

// Optional: Custom domain whitelist
WHITELABEL_DOMAIN_WHITELIST=localhost,leadagent.io,app.leadagent.io

// Optional: Cache TTL (seconds)
WHITELABEL_CACHE_TTL=600

// ──────────────────────────────────────────────────────────────
// STEP 3: Database Setup (Already Complete - No Migrations Needed)
// ──────────────────────────────────────────────────────────────

// ✅ All required tables exist:
// - domains (with morphable relationships)
// - brandings (for colors/logos)
// - workspaces (with allow_branding flag)
// - agencies (with branding_enabled flag)
// - audit_logs (for event tracking)

// ──────────────────────────────────────────────────────────────
// STEP 4: Verify Implementation - File Check List
// ──────────────────────────────────────────────────────────────

// Phase 1: Middleware ✅
✓ src/interfaces/site-context.interface.ts
✓ src/middleware/domain-routing.middleware.ts
✓ src/middleware/domain-caching.middleware.ts
✓ src/app.module.ts (updated to register middleware)

// Phase 2: Billing ✅
✓ src/billing/white-label-billing.service.ts
✓ src/billing/billing.module.ts (updated)
✓ src/agency/agency.controller.ts (updated with 3 endpoints)

// Phase 3: User Routing ✅
✓ src/users/users.service.ts (added agenciesList method)
✓ src/auth/jwt.strategy.ts (updated with site context)

// ──────────────────────────────────────────────────────────────
// STEP 5: Test the Implementation
// ──────────────────────────────────────────────────────────────

// 5a. Start Redis (if not running):
redis-server

// 5b. Start the application:
npm run start:dev

// 5c. Test domain routing:
curl -H "Host: custom.example.com" http://localhost:3001/agencies
// Middleware will:
// - Extract Host header
// - Query domains table
// - Cache result for 10 minutes
// - Inject site context

// 5d. Test white-label billing (GET estimation):
curl -X GET \
  http://localhost:3001/agencies/workspaces/1/white-label/estimate \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

// Response:
{
  "success": true,
  "estimation": {
    "total": 4900,      // Cost in cents (49.00 USD)
    "tax": 0,
    "discount": 0
  },
  "message": "Cost estimation calculated"
}

// 5e. Test white-label billing (POST enable):
curl -X POST \
  http://localhost:3001/agencies/workspaces/1/white-label/enable \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "sub_domain": "mycompany",
    "root_domain": "example.com"
  }'

// Response:
{
  "success": true,
  "message": "White-label enabled successfully",
  "workspace": { ... },
  "domain": { ... }
}

// 5f. Test white-label cancellation:
curl -X DELETE \
  http://localhost:3001/agencies/workspaces/1/white-label \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

// ──────────────────────────────────────────────────────────────
// STEP 6: How It Works (Architecture Overview)
// ──────────────────────────────────────────────────────────────

// Request Flow for Custom Domain (e.g., https://mycompany.example.com):

/*
  1. User accesses https://mycompany.example.com
  
  2. DomainCachingMiddleware intercepts request:
     - Extracts Host header: "mycompany.example.com"
     - Checks Redis cache for "domains.mycompany.example.com"
     - If not cached, queries database:
       SELECT * FROM domains 
       WHERE domain = 'https://mycompany.example.com' 
       AND active = true
     - Finds domain record with:
       modelable_type = 'App\\Models\\Workspace'
       modelable_id = 123 (workspace ID)
     - Caches result for 10 minutes
     - Injects into request:
       req.site_type = 'WORKSPACE'
       req.site_id = '123'
       req.site_domain = 'https://mycompany.example.com'
  
  3. JWT authentication decodes token:
     - JwtStrategy.validate() receives request
     - Passes site context to user object:
       user.site_type = 'WORKSPACE'
       user.site_id = '123'
       user.site_domain = 'https://mycompany.example.com'
  
  4. Controllers access site context:
     - Can check req.user.site_type
     - Can filter data by req.user.site_id
     - Workspace data shown only for that workspace
  
  5. APIs work correctly:
     - GET /workspaces/123 returns only workspace 123
     - GET /contacts returns contacts for workspace 123
     - All queries filtered by site context
*/

// ──────────────────────────────────────────────────────────────
// STEP 7: Key Features Implemented
// ──────────────────────────────────────────────────────────────

// ✅ Domain Detection
//    - Automatic detection of custom domains
//    - Platform domains (localhost, leadagent.io) always work
//    - Redis caching prevents DB hits
//    - 10-minute TTL balances freshness vs performance

// ✅ Multi-Tenant Isolation
//    - Users accessing custom domain see only their workspace
//    - agenciesList() filters by domain
//    - JWT payload includes site context
//    - All queries can be filtered by site_id

// ✅ White-Label Billing
//    - Estimate cost before charging
//    - Chargebee integration for actual billing
//    - Automatic domain creation on purchase
//    - Automatic domain deletion on cancellation
//    - Audit logging for compliance

// ✅ Branding Management
//    - Colors, logos, favicons
//    - Per-workspace customization
//    - Morphable relationships (Agency/Workspace)

// ────────────────────────────────────────────────────────────────
// STEP 8: Common Issues & Solutions
// ────────────────────────────────────────────────────────────────

// Issue: "Redis not available" warning
// Solution: Install Redis or disable caching:
//   - For caching: brew install redis (macOS) or apt-get install redis (Linux)
//   - Fallback: Middleware works without Redis (slower, no caching)

// Issue: "White-label pricing not configured"
// Solution: Set BILLING_WHITELABEL_ADDON_PRICE_ID in .env
//   - Get this from Chargebee dashboard
//   - Format: price_xxxxx

// Issue: "Domain not found or inactive"
// Solution: Ensure domain record exists and is_default=true
//   - Check: SELECT * FROM domains WHERE modelable_id=X

// Issue: Users see all workspaces instead of just theirs
// Solution: Ensure middleware is registered and running
//   - Check: Console logs should show "[DomainRouting]" messages
//   - Verify: req.site_type should be set in all requests

// ────────────────────────────────────────────────────────────────
// STEP 9: Next Steps (After Implementation)
// ────────────────────────────────────────────────────────────────

// 1. Run comprehensive tests
// 2. Update frontend to handle site context
// 3. Deploy to staging environment
// 4. Performance testing with cache
// 5. User acceptance testing (UAT)
// 6. Deploy to production

// ────────────────────────────────────────────────────────────────
// FILES MODIFIED
// ────────────────────────────────────────────────────────────────

/*
CREATED:
  src/interfaces/site-context.interface.ts
  src/middleware/domain-routing.middleware.ts
  src/middleware/domain-caching.middleware.ts
  src/billing/white-label-billing.service.ts

MODIFIED:
  src/app.module.ts
  src/billing/billing.module.ts
  src/agency/agency.controller.ts
  src/users/users.service.ts
  src/auth/jwt.strategy.ts

NO MIGRATIONS NEEDED - All database tables already exist!
*/
