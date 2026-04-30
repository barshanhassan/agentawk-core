/**
 * Mirrors gateway's WorkspaceResource shape.
 * Pass a Prisma workspace augmented with `branding`, `creator`,
 * `active_domain`, `system_domain` (caller is responsible for loading those).
 */
export interface WorkspaceResourceInput {
  workspace: any;
  branding?: any;
  creator?: any;
  active_domain?: any;
  system_domain?: any;
  domains?: any[];
}

const toS = (v: any) => (typeof v === 'bigint' ? v.toString() : v);

export class WorkspaceResource {
  static toJSON(input: WorkspaceResourceInput): any {
    const w = input.workspace;
    if (!w) return null;
    return {
      id: toS(w.id),
      name: w.name,
      slug: w.slug,
      agency_id: toS(w.agency_id),
      creator_id: toS(w.creator_id),
      timezone: w.timezone,
      status: w.status,
      allow_branding: w.allow_branding,
      allow_agents: w.allow_agents,
      allow_support: w.allow_support,
      agents_limit: w.agents_limit,
      contacts_counter: w.contacts_counter,
      limited_contacts: w.limited_contacts,
      maximum_contacts: w.maximum_contacts,
      whatsapp_channels_limit: w.whatsapp_channels_limit,
      instagram_channels_limit: w.instagram_channels_limit,
      facebook_channels_limit: w.facebook_channels_limit,
      telegram_channels_limit: w.telegram_channels_limit,
      twilio_channels_limit: w.twilio_channels_limit,
      evolution_channels_limit: w.evolution_channels_limit,
      zapi_channels_limit: w.zapi_channels_limit,
      webchat_channels_limit: w.webchat_channels_limit,
      chatgpt_assistant_limit: w.chatgpt_assistant_limit,
      created_at: w.created_at,
      updated_at: w.updated_at,

      branding: input.branding
        ? BrandingResource.toJSON(input.branding)
        : null,
      creator: input.creator
        ? {
            id: toS(input.creator.id),
            full_name:
              `${input.creator.first_name || ''} ${input.creator.last_name || ''}`.trim(),
            email: input.creator.email,
          }
        : null,
      active_domain: input.active_domain
        ? DomainResource.toJSON(input.active_domain)
        : null,
      system_domain: input.system_domain
        ? DomainResource.toJSON(input.system_domain)
        : null,
      domains: (input.domains || []).map((d) => DomainResource.toJSON(d)),
    };
  }
}

export class BrandingResource {
  static toJSON(b: any): any {
    if (!b) return null;
    return {
      id: toS(b.id),
      brandable_id: toS(b.brandable_id),
      brandable_type: b.brandable_type,
      color: b.color,
      selection_color: b.selection_color,
      link_color: b.link_color,
      incoming_chat_color: b.incoming_chat_color,
      incoming_chat_text_color: b.incoming_chat_text_color,
      outgoing_chat_color: b.outgoing_chat_color,
      outgoing_chat_text_color: b.outgoing_chat_text_color,
      mid_logo_light: toS(b.mid_logo_light),
      mid_logo_light_small: toS(b.mid_logo_light_small),
      mid_logo_dark: toS(b.mid_logo_dark),
      mid_logo_dark_small: toS(b.mid_logo_dark_small),
      favicon_media_id: toS(b.favicon_media_id),
    };
  }
}

export class DomainResource {
  static toJSON(d: any): any {
    if (!d) return null;
    return {
      id: toS(d.id),
      modelable_id: toS(d.modelable_id),
      modelable_type: d.modelable_type,
      sub_domain: d.sub_domain,
      root_domain: d.root_domain,
      domain: d.domain,
      is_default: d.is_default,
      active: d.active,
    };
  }
}
