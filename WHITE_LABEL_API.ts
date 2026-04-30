/**
 * WHITE-LABEL API ENDPOINTS
 * Ready to use immediately!
 */

// ══════════════════════════════════════════════════════════════════
// 1. DOMAIN MANAGEMENT
// ══════════════════════════════════════════════════════════════════

/**
 * Add Custom Domain (Already exists - now integrated with white-label)
 * POST /domains/add-custom-domain
 */
POST /domains/add-custom-domain
Authorization: Bearer {JWT_TOKEN}
Content-Type: application/json

{
  "sub_domain": "mycompany",
  "root_domain": "example.com"
}

Response: {
  "message": "Domain successfully updated",
  "domains": [
    {
      "id": "1",
      "domain": "https://mycompany.example.com",
      "active": true,
      "is_default": false,
      "modelable_type": "App\\Models\\Workspace",
      "modelable_id": "123"
    }
  ]
}

// ──────────────────────────────────────────────────────────────────

/**
 * Validate Domain Availability
 * GET /domains/validate-domain?sub_domain=mycompany&root_domain=example.com
 */
GET /domains/validate-domain?sub_domain=mycompany&root_domain=example.com
Authorization: Bearer {JWT_TOKEN}

Response: {
  "available": true
}

// ──────────────────────────────────────────────────────────────────

/**
 * Delete Custom Domain (Already exists - now integrated with white-label)
 * DELETE /domains/delete-custom-domain
 */
DELETE /domains/delete-custom-domain
Authorization: Bearer {JWT_TOKEN}

Response: {
  "message": "Domain successfully deleted",
  "domains": [
    {
      "id": "1",
      "domain": "https://default.leadagent.io",
      "active": true,
      "is_default": true
    }
  ]
}

// ══════════════════════════════════════════════════════════════════
// 2. WHITE-LABEL BILLING (NEW!)
// ══════════════════════════════════════════════════════════════════

/**
 * Get White-Label Cost Estimation
 * GET /agencies/workspaces/{workspace_id}/white-label/estimate
 */
GET /agencies/workspaces/123/white-label/estimate
Authorization: Bearer {JWT_TOKEN}

Response: {
  "success": true,
  "estimation": {
    "invoice_estimate": {
      "sub_total": 4900,          // $49.00
      "tax": 0,
      "discount": 0,
      "total": 4900,
      "currency_code": "USD"
    },
    "line_items": [
      {
        "item_price_id": "price_white_label_addon",
        "description": "White Label Pro",
        "quantity": 1,
        "unit_price": 4900,
        "amount": 4900
      }
    ]
  },
  "message": "Cost estimation calculated"
}

// ──────────────────────────────────────────────────────────────────

/**
 * Enable White-Label (Purchase Feature)
 * POST /agencies/workspaces/{workspace_id}/white-label/enable
 * 
 * This will:
 * 1. Charge customer via Chargebee
 * 2. Create custom domain
 * 3. Update workspace.allow_branding = true
 * 4. Log audit event
 */
POST /agencies/workspaces/123/white-label/enable
Authorization: Bearer {JWT_TOKEN}
Content-Type: application/json

{
  "sub_domain": "mycompany",
  "root_domain": "example.com"
}

Response: {
  "success": true,
  "message": "White-label enabled successfully",
  "workspace": {
    "id": "123",
    "name": "My Workspace",
    "allow_branding": true,      // NOW TRUE!
    "agency_id": "456"
  },
  "domain": {
    "id": "789",
    "domain": "https://mycompany.example.com",
    "active": true,
    "is_default": false,
    "modelable_type": "App\\Models\\Workspace",
    "modelable_id": "123"
  }
}

// ──────────────────────────────────────────────────────────────────

/**
 * Disable White-Label (Cancel Feature)
 * DELETE /agencies/workspaces/{workspace_id}/white-label
 * 
 * This will:
 * 1. Remove charge via Chargebee (prorated refund)
 * 2. Deactivate custom domain
 * 3. Update workspace.allow_branding = false
 * 4. Log audit event
 */
DELETE /agencies/workspaces/123/white-label
Authorization: Bearer {JWT_TOKEN}

Response: {
  "success": true,
  "message": "White-label disabled successfully",
  "workspace": {
    "id": "123",
    "name": "My Workspace",
    "allow_branding": false,     // NOW FALSE!
    "agency_id": "456"
  }
}

// ══════════════════════════════════════════════════════════════════
// 3. BRANDING MANAGEMENT (Already exists - enhanced)
// ══════════════════════════════════════════════════════════════════

/**
 * Update Agency Branding (colors, logos, etc.)
 * PATCH /agencies/{agency_id}/branding
 */
PATCH /agencies/456/branding
Authorization: Bearer {JWT_TOKEN}
Content-Type: application/json

{
  "enabled": true,
  "mainTheme": "#FF6B35",
  "links": "#004E89",
  "incomingBubble": "#00A995",
  "incomingText": "#FFFFFF",
  "outgoingBubble": "#5E548E",
  "outgoingText": "#FFFFFF",
  "logoLightId": "123",
  "logoLightSmallId": "124",
  "logoDarkId": "125",
  "logoDarkSmallId": "126",
  "faviconId": "127"
}

Response: {
  "id": "1",
  "brandable_id": "456",
  "brandable_type": "App\\Models\\Agency",
  "color": "#FF6B35",
  "link_color": "#004E89",
  ...
}

// ══════════════════════════════════════════════════════════════════
// 4. AGENCY DATA RETRIEVAL (Enhanced with branding)
// ══════════════════════════════════════════════════════════════════

/**
 * Get Agency Details (with branding)
 * GET /agencies/{agency_id}
 */
GET /agencies/456
Authorization: Bearer {JWT_TOKEN}

Response: {
  "success": true,
  "agency": {
    "id": "456",
    "name": "My Agency",
    "customer_id": "cust_xxx",
    "branding_enabled": true,
    "branding": {
      "color": "#FF6B35",
      "link_color": "#004E89",
      "incoming_chat_color": "#00A995",
      ...
    },
    "address": {
      "street": "...",
      "city": "...",
      "state": "...",
      "zip": "...",
      "country": "..."
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// 5. WORKSPACE MANAGEMENT (Enhanced with white-label context)
// ══════════════════════════════════════════════════════════════════

/**
 * Get Workspaces for Agency
 * GET /agencies/{agency_id}/workspaces
 */
GET /agencies/456/workspaces
Authorization: Bearer {JWT_TOKEN}

Response: {
  "success": true,
  "workspaces": [
    {
      "id": "123",
      "name": "Sales",
      "allow_branding": true,
      "agency_id": "456"
    },
    {
      "id": "124",
      "name": "Support",
      "allow_branding": false,
      "agency_id": "456"
    }
  ]
}

// ──────────────────────────────────────────────────────────────────

/**
 * Create Workspace (with auto domain)
 * POST /agencies/{agency_id}/workspaces
 */
POST /agencies/456/workspaces
Authorization: Bearer {JWT_TOKEN}
Content-Type: application/json

{
  "name": "New Workspace",
  "slug": "new-workspace"
}

Response: {
  "success": true,
  "workspace": {
    "id": "125",
    "name": "New Workspace",
    "slug": "new-workspace",
    "agency_id": "456",
    "allow_branding": false,
    "created_at": "2024-04-30T12:00:00Z"
  }
}

// ══════════════════════════════════════════════════════════════════
// IMPORTANT: Multi-Tenant Behavior
// ══════════════════════════════════════════════════════════════════

/*
When accessing via CUSTOM DOMAIN (https://mycompany.example.com):

1. Middleware automatically detects the domain
2. Queries domains table to find modelable_id
3. Injects site_type, site_id into request context
4. JWT payload includes this context
5. Controllers use it to filter data

RESULT:
- User sees ONLY their workspace
- All APIs return data for that workspace
- Multi-tenant isolation is automatic

Example Request:
  Host: mycompany.example.com
  Authorization: Bearer {JWT_TOKEN}

Flow:
  Middleware → Finds domain → modelable_id=123 → type=WORKSPACE
  JWT Strategy → Adds site_id=123 to user
  Controllers → Filter data by site_id=123
  User sees only workspace 123 data

This happens transparently - no code changes needed in controllers!
*/

// ══════════════════════════════════════════════════════════════════
// ERROR RESPONSES
// ══════════════════════════════════════════════════════════════════

// 400 Bad Request - Invalid input
{
  "statusCode": 400,
  "message": "Domain is taken",
  "error": "Bad Request"
}

// 404 Not Found - Resource doesn't exist
{
  "statusCode": 404,
  "message": "Workspace not found",
  "error": "Not Found"
}

// 401 Unauthorized - No/invalid token
{
  "statusCode": 401,
  "message": "Unauthorized",
  "error": "Unauthorized"
}
