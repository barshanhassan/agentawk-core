import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from '../../prisma/prisma.service';
import { EntriService } from '../../libraries/entri.service';
import { DomainCacheService } from '../../cache/domain-cache.service';
import { AgencyUpdatedEvent } from '../events/agency-updated.event';
import { BrandingMediaService } from '../branding-media.service';

@Injectable()
export class OnAgencyUpdatedListener {
  private readonly logger = new Logger(OnAgencyUpdatedListener.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly entri: EntriService,
    private readonly domainCache: DomainCacheService,
    private readonly brandingMedia: BrandingMediaService,
  ) {}

  @OnEvent(AgencyUpdatedEvent.NAME)
  async handle(event: AgencyUpdatedEvent): Promise<void> {
    const agency = await this.prisma.agencies.findUnique({
      where: { id: event.agencyId },
    });
    if (!agency) return;

    // Status closed → suspend non-owner users + close workspaces (parity, scoped to side-effects)
    if ('status' in event.dirtyAttributes && agency.status === 'CLOSED') {
      this.logger.debug(`Agency ${agency.id} closed — suspending users/workspaces`);
      await this.prisma.users.updateMany({
        where: {
          modelable_id: agency.id,
          modelable_type: 'App\\Models\\Agency',
          is_owner: false,
          status: { in: ['PENDING', 'ACTIVE'] },
        },
        data: { status: 'SUSPENDED' },
      });
      // workspace close handled by workspace service (left as-is in scope of WL refactor)
    }

    // Branding toggle → cleanup or audit
    if ('branding_enabled' in event.dirtyAttributes) {
      if (!agency.branding_enabled) {
        await this.cleanupAgencyBranding(agency.id, event.userId);
      } else {
        await this.prisma.agency_logs.create({
          data: {
            agency_id: agency.id,
            event: 'whitelabel_purchased',
            user_id: event.userId ?? undefined,
            data: JSON.stringify({}),
          },
        });
      }
    }

    // Always invalidate domain cache for active domain (matches gateway Cache::forget)
    const activeDomain = await this.prisma.domains.findFirst({
      where: {
        modelable_id: agency.id,
        modelable_type: 'App\\Models\\Agency',
        active: true,
      },
    });
    if (activeDomain?.domain) {
      const host = activeDomain.domain.replace(/^https?:\/\//, '');
      await this.domainCache.invalidate(host);
    }
  }

  /**
   * Mirrors gateway OnAgencyUpdated cleanup branch:
   * - Delete custom (non-default) active domain via Entri
   * - Reset branding row colors and media references
   * - Log whitelabel_cancelled
   */
  private async cleanupAgencyBranding(
    agencyId: bigint,
    userId: bigint | null,
  ): Promise<void> {
    await this.prisma.agency_logs.create({
      data: {
        agency_id: agencyId,
        event: 'whitelabel_cancelled',
        user_id: userId ?? undefined,
        data: JSON.stringify({}),
      },
    });

    const domain = await this.prisma.domains.findFirst({
      where: {
        modelable_id: agencyId,
        modelable_type: 'App\\Models\\Agency',
        is_default: false,
        active: true,
      },
    });

    if (domain) {
      try {
        await this.entri.deletePowerDomain(
          `${domain.sub_domain}.${domain.root_domain}`,
        );
      } catch (err) {
        this.logger.warn(
          `Entri delete failed (continuing local cleanup): ${err.message}`,
        );
      }
      await this.prisma.$transaction([
        this.prisma.domains.updateMany({
          where: {
            modelable_id: agencyId,
            modelable_type: 'App\\Models\\Agency',
            is_default: true,
          },
          data: { active: true },
        }),
        this.prisma.domains.delete({ where: { id: domain.id } }),
      ]);

      const host = (domain.domain || '').replace(/^https?:\/\//, '');
      if (host) await this.domainCache.invalidate(host);
    }

    // Reset branding row + delete orphaned media files
    const branding = await this.prisma.brandings.findFirst({
      where: {
        brandable_id: agencyId,
        brandable_type: 'App\\Models\\Agency',
      },
    });
    if (branding) {
      // Capture media IDs BEFORE clearing the branding row
      const mediaIds = [
        branding.favicon_media_id,
        branding.mid_logo_light,
        branding.mid_logo_light_small,
        branding.mid_logo_dark,
        branding.mid_logo_dark_small,
      ];

      await this.prisma.brandings.update({
        where: { id: branding.id },
        data: {
          color: null,
          selection_color: null,
          link_color: null,
          incoming_chat_color: null,
          outgoing_chat_color: null,
          favicon_media_id: null,
          mid_logo_light: null,
          mid_logo_light_small: null,
          mid_logo_dark: null,
          mid_logo_dark_small: null,
        },
      });

      await this.brandingMedia.deleteBrandingMedia(mediaIds);
    }
  }
}
