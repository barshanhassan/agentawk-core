import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { DomainCachingMiddleware } from './middleware/domain-caching.middleware';
import { UsersModule } from './users/users.module';
import { WorkspacesModule } from './workspaces/workspaces.module';
import { AgencyModule } from './agency/agency.module';
import { TeamsModule } from './teams/teams.module';
import { WhatsappModule } from './whatsapp/whatsapp.module';
import { MessengerModule } from './messenger/messenger.module';
import { TelegramModule } from './telegram/telegram.module';
import { TwilioModule } from './twilio/twilio.module';
import { WabaModule } from './waba/waba.module';
import { WebchatModule } from './webchat/webchat.module';
import { InstagramModule } from './instagram/instagram.module';
import { UserStatesModule } from './user-states/user-states.module';
import { TtsModule } from './tts/tts.module';
import { ZapiModule } from './zapi/zapi.module';
import { WidgetsModule } from './widgets/widgets.module';
import { IframesModule } from './iframes/iframes.module';
import { PrismaModule } from './prisma/prisma.module';
import { ContactsModule } from './contacts/contacts.module';
import { CompanyModule } from './company/company.module';
import { LeadsModule } from './leads/leads.module';
import { PipelinesModule } from './pipelines/pipelines.module';
import { TagsModule } from './tags/tags.module';
import { NotesModule } from './notes/notes.module';
import { CustomFieldsModule } from './custom-fields/custom-fields.module';
import { TasksModule } from './tasks/tasks.module';
import { CalModule } from './cal/cal.module';
import { AutomationsModule } from './automations/automations.module';
import { BroadcastsModule } from './broadcasts/broadcasts.module';
import { NotificationsModule } from './notifications/notifications.module';
import { TriggersModule } from './triggers/triggers.module';
import { BillingModule } from './billing/billing.module';
import { StatisticsModule } from './statistics/statistics.module';
import { ChatStatisticsModule } from './chat-statistics/chat-statistics.module';
import { EventLogsModule } from './event-logs/event-logs.module';
import { ReportsModule } from './reports/reports.module';
import { GalleryModule } from './gallery/gallery.module';
import { TextToSpeechModule } from './text-to-speech/text-to-speech.module';
import { BaserowModule } from './baserow/baserow.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { MarketplaceModule } from './marketplace/marketplace.module';
import { DomainsModule } from './domains/domains.module';
import { SystemFieldsModule } from './system-fields/system-fields.module';
import { AiModule } from './ai/ai.module';
import { DifyModule } from './dify/dify.module';
import { AiThemesModule } from './ai-themes/ai-themes.module';
import { AiProductsModule } from './ai-products/ai-products.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { AiFeedersModule } from './ai-feeders/ai-feeders.module';
import { InboxModule } from './inbox/inbox.module';
import { ConversationEventsModule } from './conversation-events/conversation-events.module';
import { SupervisorChatStatisticsModule } from './supervisor-chat-statistics/supervisor-chat-statistics.module';
import { QuickResponseModule } from './quick-response/quick-response.module';
import { CompaniesModule } from './companies/companies.module';
import { ServeStaticModule } from '@nestjs/serve-static';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { join } from 'path';
import { ConfigModule } from '@nestjs/config';
import { LibrariesModule } from './libraries/libraries.module';
import { CacheModule } from './cache/cache.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ServeStaticModule.forRoot({
      rootPath: join(process.cwd(), 'uploads'),
      serveRoot: '/uploads',
    }),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    LibrariesModule,
    CacheModule,
    AuthModule,
    UsersModule,
    WorkspacesModule,
    AgencyModule,
    TeamsModule,
    WhatsappModule,
    MessengerModule,
    TelegramModule,
    TwilioModule,
    WabaModule,
    WebchatModule,
    InstagramModule,
    PrismaModule,
    ContactsModule,
    CompanyModule,
    LeadsModule,
    PipelinesModule,
    TagsModule,
    NotesModule,
    CustomFieldsModule,
    TasksModule,
    CalModule,
    AutomationsModule,
    BroadcastsModule,
    NotificationsModule,
    TriggersModule,
    BillingModule,
    StatisticsModule,
    ChatStatisticsModule,
    EventLogsModule,
    ReportsModule,
    GalleryModule,
    TextToSpeechModule,
    BaserowModule,
    WebhooksModule,
    MarketplaceModule,
    DomainsModule,
    SystemFieldsModule,
    AiModule,
    DifyModule,
    AiThemesModule,
    AiProductsModule,
    AiFeedersModule,
    InboxModule,
    ConversationEventsModule,
    SupervisorChatStatisticsModule,
    IntegrationsModule,
    QuickResponseModule,
    CompaniesModule,
    WidgetsModule,
    IframesModule,
    ZapiModule,
    TtsModule,
    UserStatesModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Register domain caching middleware for all routes
    consumer.apply(DomainCachingMiddleware).forRoutes('*');
  }
}
