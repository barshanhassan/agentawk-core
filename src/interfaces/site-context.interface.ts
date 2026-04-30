/**
 * Site Context Interface
 * Represents the context of the domain/workspace/agency being accessed
 */
export interface SiteContext {
  // Domain information
  domain: string;
  host: string;
  
  // Entity information
  site_type: 'AGENCY' | 'WORKSPACE' | null;
  site_id: bigint | null;
  site_model: any | null;
  
  // Timestamps
  cached_at?: number;
}

// Extended Express Request type
declare global {
  namespace Express {
    interface Request {
      siteContext?: SiteContext;
      site_type?: string;
      site_id?: string;
      site_domain?: string;
      site_model?: any;
    }
  }
}
