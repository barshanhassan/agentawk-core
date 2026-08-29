-- CreateTable
CREATE TABLE `acl_entity_permissions` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `entity_id` BIGINT UNSIGNED NOT NULL,
    `entity_type` VARCHAR(255) NOT NULL,
    `permission_id` MEDIUMINT UNSIGNED NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_acl_entity_permissions_on_permission_id`(`permission_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `acl_permissions` (
    `id` MEDIUMINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `_lft` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `_rgt` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `parent_id` INTEGER UNSIGNED NULL,
    `name` VARCHAR(200) NOT NULL,
    `key` VARCHAR(256) NULL,
    `slug` VARCHAR(250) NOT NULL,
    `description` VARCHAR(250) NULL,
    `icon` VARCHAR(100) NULL,
    `tooltip` TEXT NULL,
    `public` BOOLEAN NOT NULL DEFAULT true,
    `type` VARCHAR(100) NOT NULL DEFAULT 'DEFAULT',
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `acl_permissions__lft__rgt_parent_id_index`(`_lft`, `_rgt`, `parent_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `acl_role_permissions` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `role_id` INTEGER UNSIGNED NOT NULL,
    `permission_id` MEDIUMINT UNSIGNED NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_acl_role_permissions_on_permission_id`(`permission_id`),
    INDEX `idx_acl_role_permissions_on_role_id`(`role_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `acl_roleables` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `role_id` INTEGER UNSIGNED NOT NULL,
    `roleable_type` VARCHAR(255) NOT NULL,
    `roleable_id` BIGINT UNSIGNED NOT NULL,
    `deleteable` BOOLEAN NOT NULL DEFAULT false,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `acl_roleables_roleable_type_roleable_id_index`(`roleable_type`, `roleable_id`),
    INDEX `idx_acl_role_permissions_on_role_id`(`role_id`),
    INDEX `idx_acl_role_permissions_on_roleable_id`(`roleable_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `acl_roles` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(255) NOT NULL,
    `key` VARCHAR(256) NULL,
    `description` VARCHAR(255) NULL,
    `slug` VARCHAR(255) NOT NULL,
    `system` BOOLEAN NOT NULL DEFAULT false,
    `admin` BOOLEAN NOT NULL DEFAULT false,
    `ownerable_id` BIGINT UNSIGNED NULL,
    `ownerable_type` VARCHAR(255) NULL,
    `status` ENUM('ACTIVE', 'ARCHIVE') NOT NULL DEFAULT 'ACTIVE',
    `icon` VARCHAR(60) NOT NULL DEFAULT 'fa-person-military-pointing',
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `active_campaign_accounts` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `api_url` VARCHAR(250) NULL,
    `api_key` VARCHAR(250) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `addresses` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `addressable_type` VARCHAR(50) NOT NULL,
    `addressable_id` BIGINT UNSIGNED NOT NULL,
    `street` TEXT NULL,
    `city` VARCHAR(60) NULL,
    `state` VARCHAR(60) NULL,
    `zip` VARCHAR(30) NULL,
    `country` VARCHAR(30) NULL,
    `country_id` BIGINT UNSIGNED NULL,
    `country_iso2` CHAR(2) NULL,
    `country_iso3` CHAR(3) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_addresses_on_addressable_id`(`addressable_id`),
    INDEX `idx_addresses_on_addressable_type`(`addressable_type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `administrators` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(200) NOT NULL,
    `email` VARCHAR(250) NOT NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `password` VARCHAR(100) NOT NULL,
    `require_password_reset` BOOLEAN NOT NULL DEFAULT false,
    `remember_token` VARCHAR(100) NULL,
    `mobile_number` VARCHAR(20) NULL,
    `avatar_id` BIGINT UNSIGNED NULL,
    `timezone` VARCHAR(50) NOT NULL DEFAULT 'UTC',
    `locale` VARCHAR(10) NOT NULL DEFAULT 'en-US',
    `last_login_at` DATETIME(0) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `agencies` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `customer_id` VARCHAR(255) NULL,
    `name` VARCHAR(100) NOT NULL,
    `slug` VARCHAR(150) NOT NULL,
    `timezone` VARCHAR(255) NOT NULL DEFAULT 'UTC',
    `notification_language` VARCHAR(255) NOT NULL DEFAULT 'en-US',
    `email` VARCHAR(255) NOT NULL,
    `notification_email` VARCHAR(255) NULL,
    `tax_id` VARCHAR(255) NOT NULL,
    `vat` VARCHAR(255) NOT NULL,
    `billing_company` VARCHAR(255) NOT NULL,
    `billing_person` VARCHAR(255) NOT NULL,
    `status` ENUM('ACTIVE', 'CLOSED') NOT NULL DEFAULT 'ACTIVE',
    `mobile_app_subscription` VARCHAR(255) NULL,
    `branding_enabled` BOOLEAN NOT NULL DEFAULT false,
    `free_openai` BOOLEAN NOT NULL DEFAULT false,
    `vip_pass` BOOLEAN NOT NULL DEFAULT false,
    `vip_pass_key` CHAR(6) NULL,
    `onboarding_status` ENUM('PENDING', 'ACTIVE', 'CLOSED') NOT NULL DEFAULT 'PENDING',
    `onboarding_code` CHAR(6) NULL,
    `closed_at` DATETIME(0) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    UNIQUE INDEX `agencies_slug_unique`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `agency_accepted_terms` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `agency_id` BIGINT UNSIGNED NOT NULL,
    `system_legal_document_id` BIGINT UNSIGNED NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_agency_accepted_terms_on_agency_id`(`agency_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `agency_logs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `agency_id` BIGINT UNSIGNED NOT NULL,
    `event` VARCHAR(255) NOT NULL,
    `user_id` BIGINT UNSIGNED NULL,
    `modelable_type` VARCHAR(255) NULL,
    `modelable_id` BIGINT UNSIGNED NULL,
    `data` LONGTEXT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `agency_logs_agency_id_index`(`agency_id`),
    INDEX `agency_logs_modelable_type_modelable_id_index`(`modelable_type`, `modelable_id`),
    INDEX `agency_logs_user_id_index`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `agency_setup` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `agency_id` BIGINT UNSIGNED NOT NULL,
    `visible` BOOLEAN NOT NULL DEFAULT true,
    `created_workspace` BOOLEAN NOT NULL DEFAULT false,
    `upgraded` BOOLEAN NOT NULL DEFAULT false,
    `created_roles` BOOLEAN NOT NULL DEFAULT false,
    `added_members` BOOLEAN NOT NULL DEFAULT false,
    `added_terms` BOOLEAN NOT NULL DEFAULT false,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_accounts` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `api_key` VARCHAR(255) NOT NULL,
    `api_url` VARCHAR(255) NOT NULL,
    `chatgpt` BOOLEAN NOT NULL DEFAULT false,
    `voice_calls` BOOLEAN NOT NULL DEFAULT true,
    `transcribe` BOOLEAN NOT NULL DEFAULT false,
    `transcribe_outgoing` TINYINT NOT NULL DEFAULT 0,
    `vision` TINYINT NOT NULL DEFAULT 1,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_ai_accounts_on_workspace_id`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_agents` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `account_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(256) NOT NULL,
    `reference_id` VARCHAR(255) NULL,
    `instructions` LONGTEXT NOT NULL,
    `prompt_strategy` ENUM('fixed', 'dynamic') NOT NULL DEFAULT 'fixed',
    `source_type` VARCHAR(255) NULL,
    `model` VARCHAR(256) NULL,
    `tools` TEXT NULL,
    `api_version` VARCHAR(255) NOT NULL DEFAULT 'v2',
    `creativity` DOUBLE NULL,
    `diversity` DOUBLE NOT NULL DEFAULT 0,
    `status` VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `data` TEXT NULL,
    `curl` TEXT NULL,
    `curl_name` VARCHAR(60) NULL,
    `curl_slug` VARCHAR(100) NULL,
    `curl_description` TEXT NULL,
    `curl_parameters` TEXT NULL,
    `allow_in_feeder` BOOLEAN NOT NULL DEFAULT false,
    `history_limit` INTEGER NULL DEFAULT 0,
    `max_chunk_size_tokens` INTEGER NULL DEFAULT 300,
    `chunk_overlap_tokens` INTEGER NULL DEFAULT 50,
    `tokens` BIGINT NOT NULL DEFAULT 0,
    `vector_store_id` VARCHAR(255) NULL,
    `vector_payload` TEXT NULL,
    `response_tokens` INTEGER NULL DEFAULT 2,
    `total_quries` INTEGER NOT NULL DEFAULT 0,

    INDEX `idx_ai_agents_on_account_id`(`account_id`),
    INDEX `idx_ai_agents_on_workspace_id`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_feeders` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(250) NOT NULL,
    `ai_agent_id` BIGINT UNSIGNED NOT NULL,
    `automation_id` BIGINT UNSIGNED NOT NULL,
    `channel_type` ENUM('whatsapp', 'evolution', 'facebook', 'instagram', 'telegram', 'twilio', 'whatsappqr') NOT NULL,
    `channelable_type` VARCHAR(255) NOT NULL,
    `channelable_id` BIGINT UNSIGNED NOT NULL,
    `payload` VARCHAR(255) NULL,
    `payload_field` VARCHAR(255) NULL,
    `trigger_text` VARCHAR(255) NOT NULL,
    `trigger_url` VARCHAR(255) NULL,
    `feed` LONGTEXT NOT NULL,
    `notes` TEXT NULL,
    `files` TEXT NULL,
    `ai_file_id` BIGINT UNSIGNED NULL,
    `creator_id` BIGINT UNSIGNED NOT NULL,
    `updater_id` BIGINT UNSIGNED NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `ai_feeders_channelable_type_channelable_id_index`(`channelable_type`, `channelable_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_files` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `agent_id` BIGINT UNSIGNED NOT NULL,
    `gallery_media_id` BIGINT UNSIGNED NULL,
    `url` TEXT NULL,
    `content` TEXT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `tokens` INTEGER NULL,
    `type` VARCHAR(255) NOT NULL DEFAULT 'TEXT',
    `status` VARCHAR(255) NULL,
    `file_id` VARCHAR(255) NULL,

    INDEX `idx_ai_files_on_agent_id`(`agent_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_functions` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `agent_id` BIGINT UNSIGNED NOT NULL,
    `is_active` TINYINT NOT NULL DEFAULT 0,
    `name` VARCHAR(255) NOT NULL,
    `slug` VARCHAR(255) NOT NULL,
    `description` VARCHAR(255) NULL,
    `type` ENUM('CURL', 'API', 'SAVE_DATA', 'ADD_TAG', 'TRIGGER_SF', 'BASEROW') NOT NULL DEFAULT 'CURL',
    `enable_curl` TINYINT NOT NULL DEFAULT 1,
    `api` VARCHAR(255) NOT NULL,
    `parameters` TEXT NULL,
    `custom_field_id` BIGINT UNSIGNED NULL,
    `data` TEXT NULL,
    `remove_from_sf` TINYINT NOT NULL DEFAULT 0,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `http_request` TEXT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_knowledgebases` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `status` VARCHAR(255) NOT NULL DEFAULT 'PENDING',
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_logs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `agent_id` BIGINT UNSIGNED NOT NULL,
    `ai_function_id` BIGINT UNSIGNED NULL,
    `ai_message_id` BIGINT UNSIGNED NULL,
    `request` TEXT NULL,
    `response` LONGTEXT NULL,
    `status` VARCHAR(255) NULL,
    `error` TEXT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_message_daily_stats` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `date` DATE NOT NULL,
    `count` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    UNIQUE INDEX `ai_message_daily_stats_workspace_id_date_unique`(`workspace_id`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_messages` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `agent_id` BIGINT UNSIGNED NULL,
    `thread_id` BIGINT UNSIGNED NULL,
    `message_id` BIGINT UNSIGNED NOT NULL,
    `run_id` VARCHAR(256) NULL,
    `tmessage_id` VARCHAR(256) NULL,
    `tthread_id` VARCHAR(256) NULL,
    `content` TEXT NULL,
    `content_type` VARCHAR(255) NOT NULL DEFAULT 'text',
    `response_data` LONGTEXT NULL,
    `role` VARCHAR(10) NOT NULL DEFAULT 'user',
    `status` VARCHAR(255) NULL DEFAULT 'waiting',
    `merged_with` BIGINT UNSIGNED NULL,
    `failed_reason` TEXT NULL,
    `tries` INTEGER NOT NULL DEFAULT 0,
    `is_action` TINYINT NOT NULL DEFAULT 0,
    `activity_id` BIGINT NULL,
    `reply_sent` SMALLINT NULL DEFAULT 0,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_ai_messages_on_message_id`(`message_id`),
    INDEX `idx_ai_messages_on_thread_id`(`thread_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_products` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `ai_theme_id` BIGINT UNSIGNED NOT NULL,
    `external_id` VARCHAR(255) NULL,
    `name` VARCHAR(255) NOT NULL,
    `payload` VARCHAR(255) NULL,
    `link_text` VARCHAR(255) NULL,
    `trigger_url` VARCHAR(255) NULL,
    `properties` TEXT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_questions` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `ai_topic_id` BIGINT UNSIGNED NOT NULL,
    `question` VARCHAR(255) NOT NULL,
    `answer` TEXT NOT NULL,
    `creator_id` BIGINT UNSIGNED NOT NULL,
    `updater_id` BIGINT UNSIGNED NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_themes` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `subtitle` VARCHAR(1024) NULL,
    `type` VARCHAR(255) NOT NULL,
    `automation_id` BIGINT UNSIGNED NULL,
    `channel` TEXT NULL,
    `payload` TEXT NULL,
    `properties` TEXT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_threads` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `agent_id` BIGINT UNSIGNED NOT NULL,
    `contact_id` BIGINT UNSIGNED NOT NULL,
    `thread_id` VARCHAR(255) NULL,
    `assistant_id` VARCHAR(255) NULL,
    `run_id` VARCHAR(256) NULL,
    `channel` ENUM('WHATSAPP', 'FACEBOOK', 'TELEGRAM', 'TWILIO', 'INSTAGRAM', 'EVOLUTION', 'ZAPI', 'WEBCHAT') NOT NULL,
    `status` VARCHAR(30) NULL,
    `job_time` DATETIME(0) NULL,
    `modelable_type` VARCHAR(255) NOT NULL,
    `modelable_id` BIGINT UNSIGNED NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `ai_threads_modelable_type_modelable_id_index`(`modelable_type`, `modelable_id`),
    INDEX `idx_ai_threads_on_agent_id`(`agent_id`),
    INDEX `idx_ai_threads_on_contact_id`(`contact_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_topics` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `ai_agent_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(250) NOT NULL,
    `ai_file_id` BIGINT UNSIGNED NULL,
    `creator_id` BIGINT UNSIGNED NOT NULL,
    `updater_id` BIGINT UNSIGNED NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_voice_agent_file` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `ai_voice_agent_id` BIGINT UNSIGNED NOT NULL,
    `ai_voice_file_id` BIGINT UNSIGNED NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_voice_agent_functions` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `ai_voice_agent_id` BIGINT UNSIGNED NOT NULL,
    `is_active` TINYINT NOT NULL DEFAULT 0,
    `type` VARCHAR(255) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `description` VARCHAR(255) NOT NULL,
    `slug` VARCHAR(255) NOT NULL,
    `data` TEXT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_voice_agent_knowledgebase` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `ai_voice_agent_id` BIGINT UNSIGNED NOT NULL,
    `ai_knowledgebase_id` BIGINT UNSIGNED NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_voice_agents` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `account_id` BIGINT UNSIGNED NOT NULL,
    `twilio_number_id` BIGINT UNSIGNED NULL,
    `type` VARCHAR(255) NULL,
    `external_agent_id` VARCHAR(255) NULL,
    `external_knowledgebase_id` VARCHAR(255) NULL,
    `name` VARCHAR(255) NOT NULL,
    `greeting` TEXT NULL,
    `instructions` LONGTEXT NOT NULL,
    `record_calls` BOOLEAN NOT NULL DEFAULT false,
    `call_ending_message` TEXT NULL,
    `call_limit` INTEGER NULL,
    `allowed_minutes_enabled` BOOLEAN NOT NULL DEFAULT false,
    `allowed_minutes` INTEGER NULL,
    `used_minutes` DOUBLE NOT NULL DEFAULT 0,
    `reference_id` VARCHAR(255) NULL,
    `model` VARCHAR(255) NULL,
    `api_version` VARCHAR(255) NOT NULL DEFAULT 'v3',
    `temperature` DOUBLE NULL,
    `confidence` DOUBLE NULL,
    `voice` VARCHAR(255) NULL,
    `language` VARCHAR(10) NULL,
    `tools` TEXT NULL,
    `status` VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
    `allow_in_feeder` BOOLEAN NOT NULL DEFAULT false,
    `automation_enabled` BOOLEAN NOT NULL DEFAULT false,
    `automation_id` BIGINT UNSIGNED NULL,
    `call_transfer_config` TEXT NULL,
    `generate_summary` BOOLEAN NOT NULL DEFAULT false,
    `summary_model` VARCHAR(255) NULL,
    `summary_prompt` TEXT NULL,
    `summary_custom_field` TEXT NULL,
    `design_config` TEXT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `ai_voice_agents_account_id_index`(`account_id`),
    INDEX `ai_voice_agents_twilio_number_id_foreign`(`twilio_number_id`),
    INDEX `ai_voice_agents_workspace_id_index`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_voice_files` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NULL,
    `ai_knowledgebase_id` BIGINT UNSIGNED NOT NULL,
    `external_knowledgebase_id` VARCHAR(255) NULL,
    `gallery_media_id` BIGINT UNSIGNED NULL,
    `url` TEXT NULL,
    `content` TEXT NULL,
    `type` VARCHAR(255) NOT NULL DEFAULT 'TEXT',
    `status` VARCHAR(255) NOT NULL DEFAULT 'PENDING',
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_voice_logs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `contact_id` BIGINT UNSIGNED NULL,
    `ai_voice_agent_id` BIGINT UNSIGNED NOT NULL,
    `call_id` VARCHAR(255) NULL,
    `started_at` DATETIME(0) NULL,
    `ended_at` DATETIME(0) NULL,
    `direction` VARCHAR(255) NULL,
    `duration` DOUBLE NULL,
    `from_number` VARCHAR(255) NULL,
    `to_number` VARCHAR(255) NULL,
    `status` VARCHAR(255) NULL,
    `end_reason` VARCHAR(255) NULL,
    `recording_url` VARCHAR(255) NULL,
    `transcript` TEXT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `api_trigger_requests` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `api_trigger_id` BIGINT UNSIGNED NOT NULL,
    `data_keys` LONGTEXT NULL,
    `payload` LONGTEXT NULL,
    `status` ENUM('SUCCESS', 'FAILED') NULL,
    `error_code` VARCHAR(250) NULL,
    `error` TEXT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_api_trigger_requests_on_api_trigger_id`(`api_trigger_id`),
    INDEX `idx_api_trigger_requests_on_status`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `api_triggers` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `slug` VARCHAR(255) NOT NULL,
    `live` BOOLEAN NOT NULL DEFAULT false,
    `mapping` LONGTEXT NULL,
    `mapped_keys` LONGTEXT NULL,
    `new_keys` LONGTEXT NULL,
    `index_field` ENUM('primary_mobile', 'primary_whatsapp', 'primary_email') NULL,
    `update_duplicates` BOOLEAN NOT NULL DEFAULT false,
    `created_tags` LONGTEXT NULL,
    `updated_tags` LONGTEXT NULL,
    `creator_id` BIGINT UNSIGNED NOT NULL,
    `updater_id` BIGINT UNSIGNED NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_api_triggers_on_index_field`(`index_field`),
    INDEX `idx_api_triggers_on_workspace_id`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_logs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NULL,
    `modelable_type` VARCHAR(255) NULL,
    `modelable_id` BIGINT UNSIGNED NULL,
    `event` VARCHAR(255) NOT NULL,
    `data` LONGTEXT NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `audit_logs_modelable_type_modelable_id_index`(`modelable_type`, `modelable_id`),
    INDEX `idx_audit_logs_on_event`(`event`),
    INDEX `idx_audit_logs_on_modelable_id`(`modelable_id`),
    INDEX `idx_audit_logs_on_modelable_type`(`modelable_type`),
    INDEX `idx_audit_logs_on_user_id`(`user_id`),
    INDEX `idx_audit_logs_on_workspace_id`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `automation_activity_clicks` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `automation_id` BIGINT UNSIGNED NOT NULL,
    `activity_slug` VARCHAR(255) NOT NULL,
    `contact_id` BIGINT UNSIGNED NOT NULL,
    `clicks` INTEGER UNSIGNED NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_automation_activity_clicks_automation_id`(`automation_id`),
    INDEX `idx_automation_activity_clicks_on_clicks`(`clicks`),
    INDEX `idx_automation_activity_clicks_on_contact_id`(`contact_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `automation_activity_iterations` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `contact_id` BIGINT UNSIGNED NOT NULL,
    `activity_id` BIGINT UNSIGNED NOT NULL,
    `runs` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_automation_activity_iterations_on_activity_id`(`activity_id`),
    INDEX `idx_automation_activity_iterations_on_contact_id`(`contact_id`),
    INDEX `idx_automation_activity_iterations_on_runs`(`runs`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `automation_activity_statistics` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `activity_slug` VARCHAR(255) NOT NULL,
    `stats` LONGTEXT NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_automation_activity_statistics_on_activity_slug`(`activity_slug`),
    INDEX `idx_automation_activity_statistics_on_stats`(`stats`(768)),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `automation_flow` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `automation_version_id` BIGINT UNSIGNED NOT NULL,
    `slug` VARCHAR(255) NULL,
    `next_step_id` BIGINT UNSIGNED NOT NULL,
    `connector_id` BIGINT UNSIGNED NOT NULL,
    `deleteable` BOOLEAN NOT NULL DEFAULT true,
    `connector_type` VARCHAR(255) NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `deleted_at` TIMESTAMP(0) NULL,

    INDEX `idx_automation_flow_on_automation_next_connector_id`(`connector_id`),
    INDEX `idx_automation_flow_on_automation_next_step_id`(`next_step_id`),
    INDEX `idx_automation_flow_on_automation_version_id`(`automation_version_id`),
    INDEX `idx_automation_flow_on_connector_id`(`connector_id`),
    INDEX `idx_automation_flow_on_connector_type`(`connector_type`),
    INDEX `idx_automation_flow_on_next_step_id`(`next_step_id`),
    INDEX `idx_automation_flow_on_slug`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `automation_folders` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_automation_folders_on_workspace_id`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `automation_objects` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `automation_id` BIGINT UNSIGNED NOT NULL,
    `automation_version_id` BIGINT UNSIGNED NOT NULL,
    `object_id` BIGINT UNSIGNED NOT NULL,
    `object_type` VARCHAR(255) NOT NULL,
    `runs` BIGINT NOT NULL,
    `last_run_at` TIMESTAMP(0) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_automation_objects_on_automation_id`(`automation_id`),
    INDEX `idx_automation_objects_on_automation_version_id`(`automation_version_id`),
    INDEX `idx_automation_objects_on_object_id`(`object_id`),
    INDEX `idx_automation_objects_on_object_type`(`object_type`),
    INDEX `idx_automation_objects_on_runs`(`runs`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `automation_queue` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `object_id` BIGINT UNSIGNED NOT NULL,
    `object_type` VARCHAR(255) NOT NULL,
    `flow_id` BIGINT UNSIGNED NOT NULL,
    `step_id` BIGINT UNSIGNED NOT NULL,
    `activity_id` BIGINT UNSIGNED NOT NULL,
    `activity_slug` VARCHAR(255) NULL,
    `reserved` TIMESTAMP(0) NULL,
    `reserve_code` ENUM('AUTOMATION', 'AUTOMATION_PAUSED_FOR_CONTACT') NULL,
    `payload` TEXT NULL,
    `is_locked` SMALLINT NULL DEFAULT 0,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_automation_queue_on_activity_id`(`activity_id`),
    INDEX `idx_automation_queue_on_flow_id`(`flow_id`),
    INDEX `idx_automation_queue_on_object_id`(`object_id`),
    INDEX `idx_automation_queue_on_object_type`(`object_type`),
    INDEX `idx_automation_queue_on_reserved`(`reserved`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `automation_quick_replies` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `automation_step_id` BIGINT UNSIGNED NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `slug` VARCHAR(255) NULL,
    `order` INTEGER NOT NULL DEFAULT 0,
    `stats` LONGTEXT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `deleted_at` TIMESTAMP(0) NULL,

    INDEX `idx_automation_quick_replies_on_automation_step_id`(`automation_step_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `automation_quick_reply_clicks` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `automation_id` BIGINT UNSIGNED NOT NULL,
    `qr_slug` VARCHAR(255) NOT NULL,
    `contact_id` BIGINT UNSIGNED NOT NULL,
    `clicks` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_automation_quick_reply_clicks_on_automation_id`(`automation_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `automation_quick_reply_followups` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `chat_id` BIGINT UNSIGNED NOT NULL,
    `chat_type` VARCHAR(255) NOT NULL,
    `automation_step_id` BIGINT UNSIGNED NOT NULL,
    `wait_till` TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_automation_quick_reply_followups_on_automation_step_id`(`automation_step_id`),
    INDEX `idx_automation_quick_reply_followups_on_chat_id`(`chat_id`),
    INDEX `idx_automation_quick_reply_followups_on_chat_type`(`chat_type`),
    INDEX `idx_automation_quick_reply_followups_on_wait_till`(`wait_till`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `automation_quick_reply_retries` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `chat_id` BIGINT UNSIGNED NOT NULL,
    `chat_type` VARCHAR(255) NOT NULL,
    `automation_step_id` BIGINT UNSIGNED NOT NULL,
    `attempts` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `max_attempts` INTEGER UNSIGNED NOT NULL DEFAULT 3,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_automation_quick_reply_retries_on_attempts`(`attempts`),
    INDEX `idx_automation_quick_reply_retries_on_automation_step_id`(`automation_step_id`),
    INDEX `idx_automation_quick_reply_retries_on_chat_id`(`chat_id`),
    INDEX `idx_automation_quick_reply_retries_on_chat_type`(`chat_type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `automation_runs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `automation_id` BIGINT UNSIGNED NOT NULL,
    `contact_id` BIGINT UNSIGNED NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_automation_runs_on_automation_id`(`automation_id`),
    INDEX `idx_automation_runs_on_contact_id`(`contact_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `automation_step_activities` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `slug` VARCHAR(255) NULL,
    `step_id` BIGINT UNSIGNED NOT NULL,
    `parent_id` BIGINT UNSIGNED NULL,
    `event` VARCHAR(100) NULL,
    `properties` MEDIUMTEXT NULL,
    `linkable` BOOLEAN NOT NULL DEFAULT false,
    `order` INTEGER NOT NULL DEFAULT 0,
    `modelable_type` VARCHAR(255) NULL,
    `modelable_id` BIGINT UNSIGNED NULL,
    `stats` LONGTEXT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `deleted_at` TIMESTAMP(0) NULL,

    INDEX `automation_step_activities_modelable_type_modelable_id_index`(`modelable_type`, `modelable_id`),
    INDEX `idx_automation_step_activities_on_event`(`event`),
    INDEX `idx_automation_step_activities_on_properties`(`properties`(768)),
    INDEX `idx_automation_step_activities_on_slug`(`slug`),
    INDEX `idx_automation_step_activities_on_step_id`(`step_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `automation_step_statistics` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `step_slug` VARCHAR(255) NOT NULL,
    `stats` LONGTEXT NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_automation_step_statistics_on_step_slug`(`step_slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `automation_steps` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `automation_version_id` BIGINT UNSIGNED NOT NULL,
    `slug` VARCHAR(255) NULL,
    `title` VARCHAR(255) NOT NULL,
    `type` VARCHAR(255) NOT NULL DEFAULT 'action',
    `properties` MEDIUMTEXT NULL,
    `cloneable` BOOLEAN NOT NULL DEFAULT true,
    `deletable` BOOLEAN NOT NULL DEFAULT true,
    `linkable` BOOLEAN NOT NULL DEFAULT true,
    `stats` LONGTEXT NULL,
    `comment` TEXT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `deleted_at` TIMESTAMP(0) NULL,

    INDEX `idx_automation_steps_on_automation_version_id`(`automation_version_id`),
    INDEX `idx_automation_steps_on_type`(`type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `automation_versions` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `automation_id` BIGINT UNSIGNED NOT NULL,
    `number` BIGINT UNSIGNED NOT NULL DEFAULT 1,
    `status` ENUM('draft', 'published') NOT NULL DEFAULT 'draft',
    `publisher_id` BIGINT UNSIGNED NULL,
    `published_at` TIMESTAMP(0) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_automation_steps_on_automation_id`(`automation_id`),
    INDEX `idx_automation_steps_on_number`(`number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `automations` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `slug` VARCHAR(50) NULL,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `folder_id` BIGINT UNSIGNED NULL,
    `name` VARCHAR(255) NOT NULL,
    `template` VARCHAR(255) NULL,
    `published_version_id` BIGINT UNSIGNED NULL,
    `draft_version_id` BIGINT UNSIGNED NULL,
    `status` ENUM('draft', 'active', 'unpublished', 'archive', 'delete', 'error') NOT NULL DEFAULT 'draft',
    `error_code` ENUM('LOOP') NULL,
    `moduleable_type` VARCHAR(255) NULL,
    `moduleable_id` BIGINT UNSIGNED NULL,
    `total_runs` BIGINT NOT NULL DEFAULT 0,
    `unique_runs` BIGINT NOT NULL DEFAULT 0,
    `total_clicks` BIGINT NOT NULL DEFAULT 0,
    `unique_clicks` BIGINT NOT NULL DEFAULT 0,
    `total_ctr` DECIMAL(8, 2) NOT NULL DEFAULT 0.00,
    `unique_ctr` DECIMAL(8, 2) NOT NULL DEFAULT 0.00,
    `allow_in_feeder` BOOLEAN NOT NULL DEFAULT false,
    `bundle_id` BIGINT UNSIGNED NULL,
    `bundle_automation_id` BIGINT UNSIGNED NULL,
    `published_at` TIMESTAMP(0) NULL,
    `creator_id` BIGINT UNSIGNED NOT NULL,
    `updater_id` BIGINT UNSIGNED NOT NULL,
    `deleted_at` TIMESTAMP(0) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `automations_moduleable_type_moduleable_id_index`(`moduleable_type`, `moduleable_id`),
    INDEX `automations_status_workspace_id_slug_index`(`status`, `workspace_id`, `slug`),
    INDEX `idx_automations_on_folder_id`(`folder_id`),
    INDEX `idx_automations_on_published_version_id`(`published_version_id`),
    INDEX `idx_automations_on_status`(`status`),
    INDEX `idx_automations_on_total_clicks`(`total_clicks`),
    INDEX `idx_automations_on_total_ctr`(`total_ctr`),
    INDEX `idx_automations_on_total_runs`(`total_runs`),
    INDEX `idx_automations_on_unique_runs`(`unique_runs`),
    INDEX `idx_automations_on_workspace_id`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `baserow_accounts` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `database_id` VARCHAR(255) NULL,
    `access_token` VARCHAR(255) NOT NULL,
    `tables` LONGTEXT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `billing_addons` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `item_id` VARCHAR(255) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `external_name` VARCHAR(255) NOT NULL,
    `resource_version` VARCHAR(255) NOT NULL,
    `item_family_id` VARCHAR(255) NOT NULL,
    `type` VARCHAR(255) NOT NULL,
    `object` VARCHAR(255) NOT NULL,
    `status` VARCHAR(255) NOT NULL,
    `addon_type` ENUM('workspace') NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `deleted_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `billing_charges` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `item_id` VARCHAR(255) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `external_name` VARCHAR(255) NOT NULL,
    `resource_version` VARCHAR(255) NOT NULL,
    `item_family_id` VARCHAR(255) NOT NULL,
    `type` VARCHAR(255) NOT NULL,
    `object` VARCHAR(255) NOT NULL,
    `status` VARCHAR(255) NOT NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `deleted_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `billing_coupons` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `coupon_id` VARCHAR(255) NOT NULL,
    `invoice_name` VARCHAR(255) NULL,
    `discount_type` VARCHAR(255) NULL,
    `discount_amount` BIGINT UNSIGNED NULL,
    `discount_percentage` DECIMAL(8, 2) NULL,
    `duration_type` VARCHAR(255) NULL,
    `status` VARCHAR(255) NOT NULL,
    `apply_discount_on` VARCHAR(255) NULL,
    `apply_on` VARCHAR(255) NULL,
    `currency_code` CHAR(3) NULL,
    `redemptions` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_billing_coupons_on_coupon_id`(`coupon_id`),
    INDEX `idx_billing_coupons_on_discount_amount`(`discount_amount`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `billing_customer_contacts` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `agency_id` BIGINT UNSIGNED NOT NULL,
    `contact_id` VARCHAR(255) NOT NULL,
    `email` VARCHAR(255) NOT NULL,
    `first_name` VARCHAR(255) NULL,
    `last_name` VARCHAR(255) NULL,

    INDEX `idx_billing_coupons_on_agency_id`(`agency_id`),
    INDEX `idx_billing_customer_contacts_on_agency_id`(`agency_id`),
    INDEX `idx_billing_customer_contacts_on_email`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `billing_differential_prices` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `billing_item_price_id` BIGINT UNSIGNED NOT NULL,
    `price_id` VARCHAR(255) NOT NULL,
    `item_price_id` VARCHAR(255) NOT NULL,
    `parent_item_id` VARCHAR(255) NOT NULL,
    `price` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `status` VARCHAR(255) NOT NULL,
    `currency_code` VARCHAR(255) NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `billing_events` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `event_id` VARCHAR(50) NOT NULL,
    `event_type` VARCHAR(50) NOT NULL,
    `source` VARCHAR(50) NOT NULL,
    `user` VARCHAR(100) NULL,
    `api_version` VARCHAR(10) NOT NULL,
    `content` LONGTEXT NOT NULL,
    `webhooks` VARCHAR(255) NULL,
    `status` ENUM('NEW', 'PROCESSING', 'PROCESSED', 'FAILED') NOT NULL DEFAULT 'NEW',
    `note` TEXT NULL,
    `occurred_at` VARCHAR(255) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_billing_events_on_event_id`(`event_id`),
    INDEX `idx_billing_events_on_event_type`(`event_type`),
    INDEX `idx_billing_events_on_source`(`source`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `billing_item_price_tiers` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `billing_item_price_id` BIGINT UNSIGNED NOT NULL,
    `starting_unit` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `ending_unit` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `price` INTEGER UNSIGNED NOT NULL DEFAULT 0,

    INDEX `idx_billing_item_price_tiers_on_billing_item_price_id`(`billing_item_price_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `billing_item_prices` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `itemable_type` VARCHAR(255) NOT NULL,
    `itemable_id` BIGINT UNSIGNED NOT NULL,
    `price_id` VARCHAR(255) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `external_name` VARCHAR(255) NOT NULL,
    `item_family_id` VARCHAR(255) NOT NULL,
    `pricing_model` VARCHAR(255) NOT NULL,
    `price` INTEGER UNSIGNED NULL,
    `period` SMALLINT UNSIGNED NULL,
    `currency_code` CHAR(3) NOT NULL,
    `period_unit` VARCHAR(255) NULL,
    `status` ENUM('active', 'archived', 'deleted') NOT NULL DEFAULT 'active',
    `item_type` VARCHAR(255) NOT NULL,
    `is_taxable` BOOLEAN NOT NULL DEFAULT true,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `deleted_at` TIMESTAMP(0) NULL,

    INDEX `billing_item_prices_itemable_type_itemable_id_index`(`itemable_type`, `itemable_id`),
    INDEX `idx_billing_item_prices_on_itemable_id`(`itemable_id`),
    INDEX `idx_billing_item_prices_on_itemable_type`(`itemable_type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `billing_plans` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `item_id` VARCHAR(255) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `external_name` VARCHAR(255) NOT NULL,
    `description` VARCHAR(500) NULL,
    `resource_version` VARCHAR(255) NOT NULL,
    `item_family_id` VARCHAR(255) NOT NULL,
    `type` VARCHAR(255) NOT NULL,
    `object` VARCHAR(255) NOT NULL,
    `status` VARCHAR(255) NOT NULL,
    `free` BOOLEAN NOT NULL DEFAULT false,
    `plan_order` INTEGER NOT NULL DEFAULT 0,
    `maximum_workspaces` INTEGER UNSIGNED NOT NULL DEFAULT 99,
    `free_workspaces` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `free_agents` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `free_channels` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `maximum_automations` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `maximum_tags` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `maximum_custom_fields` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `maximum_contacts` INTEGER UNSIGNED NOT NULL DEFAULT 100,
    `free_contacts` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `free_ai_agents` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    `free_cal_accounts` TINYINT NOT NULL DEFAULT 2,
    `allow_branding` BOOLEAN NOT NULL DEFAULT false,
    `free_workspace_branding` BOOLEAN NOT NULL DEFAULT false,
    `free_agency_branding` BOOLEAN NOT NULL DEFAULT false,
    `allow_import_contacts` BOOLEAN NOT NULL DEFAULT false,
    `allow_manage_acl` BOOLEAN NOT NULL DEFAULT false,
    `allow_teams` BOOLEAN NOT NULL DEFAULT false,
    `allow_api` BOOLEAN NOT NULL DEFAULT false,
    `allow_broadcasts` BOOLEAN NOT NULL DEFAULT false,
    `allow_contact_deletion` BOOLEAN NOT NULL DEFAULT false,
    `allow_contact_merge` BOOLEAN NOT NULL DEFAULT false,
    `free_support_agents` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `updated_at` TIMESTAMP(0) NULL,
    `deleted_at` TIMESTAMP(0) NULL,

    INDEX `idx_billing_plans_on_item_id`(`item_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `billing_subscription_items` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `billing_subscription_id` BIGINT UNSIGNED NOT NULL,
    `amount` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `unit_price` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `quantity` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `free_quantity` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `billing_cycles` VARCHAR(255) NULL,
    `item_price_id` VARCHAR(255) NULL,
    `item_type` VARCHAR(255) NULL,
    `object` VARCHAR(255) NULL,

    INDEX `idx_billing_subscription_items_on_billing_subscription_id`(`billing_subscription_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `billing_subscriptions` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `agency_id` BIGINT UNSIGNED NOT NULL,
    `subscription_id` VARCHAR(255) NOT NULL,
    `customer_id` VARCHAR(255) NOT NULL,
    `billing_plan_id` BIGINT UNSIGNED NULL,
    `default` BOOLEAN NOT NULL DEFAULT false,
    `status` ENUM('future', 'in_trial', 'active', 'non_renewing', 'paused', 'cancelled') NOT NULL,
    `billing_period` SMALLINT UNSIGNED NULL,
    `billing_period_unit` VARCHAR(255) NULL,
    `currency_code` CHAR(3) NULL,
    `current_term_start` TIMESTAMP(0) NULL,
    `current_term_end` TIMESTAMP(0) NULL,
    `next_billing_at` TIMESTAMP(0) NULL,
    `trial_start` TIMESTAMP(0) NULL,
    `trial_end` TIMESTAMP(0) NULL,
    `activated_at` TIMESTAMP(0) NULL,
    `started_at` TIMESTAMP(0) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `cancelled_at` TIMESTAMP(0) NULL,
    `cancel_reason` ENUM('not_paid', 'no_card', 'fraud_review_failed', 'non_compliant_eu_customer', 'tax_calculation_failed', 'currency_incompatible_with_gateway', 'non_compliant_customer') NULL,
    `cancel_reason_code` VARCHAR(255) NULL,
    `due_since` TIMESTAMP(0) NULL,
    `total_dues` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `current_estimated_total` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `current_estimated_at` DATETIME(0) NULL,
    `meta_data` LONGTEXT NULL,
    `deleted_at` TIMESTAMP(0) NULL,
    `coupons` TEXT NULL,
    `api_triggers` BIGINT UNSIGNED NOT NULL DEFAULT 0,

    INDEX `idx_billing_subscriptions_on_billing_plan_id`(`billing_plan_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `invoices` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `agency_id` BIGINT UNSIGNED NOT NULL,
    `billing_subscription_id` BIGINT UNSIGNED NULL,
    `invoice_number` VARCHAR(64) NOT NULL,
    `plan_name` VARCHAR(255) NOT NULL,
    `amount` DECIMAL(12, 2) NOT NULL,
    `currency` VARCHAR(10) NOT NULL DEFAULT 'USD',
    `status` VARCHAR(30) NOT NULL DEFAULT 'paid',
    `billing_company` VARCHAR(255) NULL,
    `billing_person` VARCHAR(255) NULL,
    `tax_id` VARCHAR(255) NULL,
    `vat` VARCHAR(255) NULL,
    `address_street` VARCHAR(255) NULL,
    `address_city` VARCHAR(255) NULL,
    `address_state` VARCHAR(255) NULL,
    `address_zip` VARCHAR(255) NULL,
    `address_country` VARCHAR(255) NULL,
    `pdf_s3_key` VARCHAR(500) NULL,
    `issued_at` TIMESTAMP(0) NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    UNIQUE INDEX `invoices_invoice_number_unique`(`invoice_number`),
    INDEX `idx_invoices_on_agency_id`(`agency_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `billing_sync` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `start_time` BIGINT UNSIGNED NOT NULL,
    `end_time` BIGINT UNSIGNED NOT NULL,
    `offset` VARCHAR(255) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `booking_logs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `contact_id` BIGINT UNSIGNED NULL,
    `event_type` ENUM('create_booking', 'resechedule', 'availability', 'find_booking', 'cancel_booking') NOT NULL,
    `error_message` TEXT NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `bookings` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `account_id` BIGINT UNSIGNED NULL,
    `contact_id` BIGINT UNSIGNED NOT NULL,
    `booking_id` VARCHAR(255) NULL,
    `eventTypeId` VARCHAR(255) NULL,
    `eventTitle` VARCHAR(255) NULL,
    `start` TIMESTAMP(0) NULL,
    `timeZone` VARCHAR(255) NULL,
    `language` VARCHAR(255) NULL,
    `title` VARCHAR(255) NULL,
    `description` TEXT NULL,
    `status` TEXT NULL,
    `responses` TEXT NULL,
    `booking_data` TEXT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `end` TIMESTAMP(0) NULL,
    `duration` INTEGER NULL,
    `reminders` TEXT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `brandings` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `brandable_id` BIGINT UNSIGNED NOT NULL,
    `brandable_type` VARCHAR(50) NOT NULL,
    `locale` VARCHAR(10) NOT NULL DEFAULT 'en-US',
    `color` VARCHAR(30) NULL,
    `selection_color` VARCHAR(30) NULL,
    `link_color` VARCHAR(30) NULL,
    `incoming_chat_color` VARCHAR(30) NULL,
    `incoming_chat_text_color` VARCHAR(30) NOT NULL DEFAULT '#ffffff',
    `outgoing_chat_color` VARCHAR(30) NULL,
    `outgoing_chat_text_color` VARCHAR(30) NOT NULL DEFAULT '#ffffff',
    `mid_logo_light` BIGINT UNSIGNED NULL,
    `mid_logo_light_small` BIGINT UNSIGNED NULL,
    `mid_logo_dark` BIGINT UNSIGNED NULL,
    `mid_logo_dark_small` BIGINT UNSIGNED NULL,
    `favicon_media_id` BIGINT UNSIGNED NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_brandings_on_brandable_id`(`brandable_id`),
    INDEX `idx_brandings_on_brandable_type`(`brandable_type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `broadcasts` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `channel_type` VARCHAR(255) NOT NULL,
    `channelable_type` VARCHAR(255) NOT NULL,
    `channelable_id` BIGINT UNSIGNED NOT NULL,
    `message` VARCHAR(2000) NULL,
    `wa_template_id` INTEGER UNSIGNED NULL,
    `metadata` LONGTEXT NULL,
    `total_audience` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `total_sent` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `automation_id` INTEGER UNSIGNED NULL,
    `status` ENUM('draft', 'pending', 'in_progress', 'completed', 'failed') NOT NULL DEFAULT 'draft',
    `fail_reason` VARCHAR(255) NULL,
    `scheduled_at` DATETIME(0) NULL,
    `ttl_at` DATETIME(0) NULL,
    `do_not_send_if_marketing` BOOLEAN NOT NULL DEFAULT false,
    `filters` LONGTEXT NOT NULL,
    `locked` BOOLEAN NOT NULL DEFAULT false,
    `creator_id` BIGINT UNSIGNED NOT NULL,
    `updater_id` BIGINT UNSIGNED NULL,
    `started_at` DATETIME(0) NULL,
    `finished_at` DATETIME(0) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `broadcasts_channelable_type_channelable_id_index`(`channelable_type`, `channelable_id`),
    INDEX `idx_broadcasts_on_automation_id`(`automation_id`),
    INDEX `idx_broadcasts_on_channel_type`(`channel_type`),
    INDEX `idx_broadcasts_on_channelable_id`(`channelable_id`),
    INDEX `idx_broadcasts_on_channelable_type`(`channelable_type`),
    INDEX `idx_broadcasts_on_filters`(`filters`(768)),
    INDEX `idx_broadcasts_on_status`(`status`),
    INDEX `idx_broadcasts_on_workspace_id`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `bundle_downloads` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `bundle_id` BIGINT UNSIGNED NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `bundle_downloads_bundle_id_foreign`(`bundle_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `bundle_instructions` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `bundle_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `content` LONGTEXT NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `deleted_at` TIMESTAMP(0) NULL,

    INDEX `idx_bundle_id_on_bundle_instructions`(`bundle_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `bundle_prompts` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `bundle_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `instructions` LONGTEXT NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `deleted_at` TIMESTAMP(0) NULL,

    INDEX `idx_bundle_id_on_bundle_prompts`(`bundle_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `bundle_resources` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `bundle_id` BIGINT UNSIGNED NOT NULL,
    `type` ENUM('tag', 'custom_field', 'automation', 'ai_agent', 'pipeline', 'role') NOT NULL,
    `resourceable_type` VARCHAR(255) NOT NULL,
    `resourceable_id` BIGINT UNSIGNED NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `deleted_at` TIMESTAMP(0) NULL,

    INDEX `bundle_resources_resourceable_type_resourceable_id_index`(`resourceable_type`, `resourceable_id`),
    INDEX `idx_bundle_id_on_bundle_resources`(`bundle_id`),
    UNIQUE INDEX `bundle_resource_unique`(`bundle_id`, `type`, `resourceable_id`, `resourceable_type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `bundle_shares` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `bundle_id` BIGINT UNSIGNED NOT NULL,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `pass_code` VARCHAR(30) NULL,
    `consumed_at` DATETIME(0) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `deleted_at` TIMESTAMP(0) NULL,

    INDEX `idx_bundle_id_on_bundle_shares`(`bundle_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `bundles` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` INTEGER UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NULL,
    `slug` VARCHAR(255) NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `description` VARCHAR(500) NOT NULL,
    `published` BOOLEAN NOT NULL DEFAULT false,
    `published_at` DATETIME(0) NULL,
    `premium` BOOLEAN NOT NULL DEFAULT false,
    `price` DECIMAL(8, 2) NOT NULL DEFAULT 0.00,
    `has_whatsapp` BOOLEAN NOT NULL DEFAULT false,
    `has_zapi` BOOLEAN NOT NULL DEFAULT false,
    `has_instagram` BOOLEAN NOT NULL DEFAULT false,
    `has_facebook` BOOLEAN NOT NULL DEFAULT false,
    `has_telegram` BOOLEAN NOT NULL DEFAULT false,
    `has_twilio` BOOLEAN NOT NULL DEFAULT false,
    `has_webchat` BOOLEAN NOT NULL DEFAULT false,
    `has_openai` BOOLEAN NOT NULL DEFAULT false,
    `has_make` BOOLEAN NOT NULL DEFAULT false,
    `has_mstts` BOOLEAN NOT NULL DEFAULT false,
    `has_cloudinary` BOOLEAN NOT NULL DEFAULT false,
    `has_active_campaign` BOOLEAN NOT NULL DEFAULT false,
    `has_eleven_labs` BOOLEAN NOT NULL DEFAULT false,
    `has_cal` BOOLEAN NOT NULL DEFAULT false,
    `has_dify` BOOLEAN NOT NULL DEFAULT false,
    `has_llm_whisper` BOOLEAN NOT NULL DEFAULT false,
    `has_baserow` BOOLEAN NOT NULL DEFAULT false,
    `has_woovi` BOOLEAN NOT NULL DEFAULT false,
    `creator_id` INTEGER UNSIGNED NOT NULL,
    `downloads` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `deleted_at` TIMESTAMP(0) NULL,

    UNIQUE INDEX `idx_slug_in_bundles`(`slug`),
    INDEX `idx_workspace_on_bundles`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cal_accounts` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `version` VARCHAR(255) NOT NULL DEFAULT 'v1',
    `name` VARCHAR(60) NULL DEFAULT 'Cal.com',
    `username` VARCHAR(255) NULL,
    `api_key` VARCHAR(255) NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `capi` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `modelable_type` VARCHAR(255) NULL,
    `modelable_id` BIGINT UNSIGNED NULL,
    `dataset_id` VARCHAR(255) NOT NULL,
    `name` VARCHAR(60) NOT NULL,
    `token` TEXT NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `capi_modelable_type_modelable_id_index`(`modelable_type`, `modelable_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `capi_logs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `capi_id` BIGINT UNSIGNED NOT NULL,
    `contact_id` BIGINT UNSIGNED NOT NULL,
    `event_type` VARCHAR(255) NOT NULL,
    `action_source` VARCHAR(255) NOT NULL,
    `event_received` TINYINT NOT NULL,
    `payload` TEXT NOT NULL,
    `response` TEXT NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `channel_opts` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `contact_id` BIGINT UNSIGNED NOT NULL,
    `channel` ENUM('sms', 'call', 'email', 'telegram', 'whatsapp', 'messenger', 'instagram', 'evolution', 'zapi', 'webchat') NOT NULL,
    `modelable_id` BIGINT UNSIGNED NULL,
    `modelable_type` VARCHAR(255) NULL,
    `contactable_id` BIGINT UNSIGNED NULL,
    `contactable_type` VARCHAR(255) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_channel_opts_on_channel`(`channel`),
    INDEX `idx_channel_opts_on_contact_id`(`contact_id`),
    INDEX `idx_channel_opts_on_contactable_id`(`contactable_id`),
    INDEX `idx_channel_opts_on_contactable_type`(`contactable_type`),
    INDEX `idx_channel_opts_on_modelable_id`(`modelable_id`),
    INDEX `idx_channel_opts_on_modelable_type`(`modelable_type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `chat_inputs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `contact_id` BIGINT UNSIGNED NOT NULL,
    `channel` ENUM('whatsapp', 'zapi', 'instagram', 'facebook', 'telegram', 'twilio', 'webchat') NULL,
    `chatable_type` VARCHAR(255) NOT NULL,
    `chatable_id` BIGINT UNSIGNED NOT NULL,
    `activity_slug` VARCHAR(255) NOT NULL,
    `expiry` DATETIME(0) NOT NULL,
    `attempts` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `chat_inputs_channel_index`(`channel`),
    INDEX `chat_inputs_chatable_type_chatable_id_index`(`chatable_type`, `chatable_id`),
    INDEX `chat_inputs_workspace_id_index`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `chatbot_chats` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `chatbot_id` BIGINT UNSIGNED NOT NULL,
    `contact_id` BIGINT UNSIGNED NOT NULL,
    `first_name` VARCHAR(255) NULL,
    `last_name` VARCHAR(255) NULL,
    `input_activity_id` BIGINT UNSIGNED NULL,
    `input_expected_till` TIMESTAMP(0) NULL,
    `input_attempts` BIGINT UNSIGNED NOT NULL DEFAULT 0,
    `question_activity_id` BIGINT UNSIGNED NULL,
    `question_expected_till` TIMESTAMP(0) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_chatbot_chats_on_chatbot_id`(`chatbot_id`),
    INDEX `idx_chatbot_chats_on_contact_id`(`contact_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `chatbot_messages` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `chat_id` BIGINT UNSIGNED NOT NULL,
    `parent_id` BIGINT UNSIGNED NULL,
    `sender_id` BIGINT UNSIGNED NULL,
    `type` ENUM('text', 'image', 'delay', 'input', 'audio', 'video') NOT NULL,
    `direction` ENUM('INCOMING', 'OUTGOING') NOT NULL DEFAULT 'INCOMING',
    `text` VARCHAR(255) NULL,
    `status` ENUM('pending', 'sent', 'delivered', 'failed') NOT NULL DEFAULT 'pending',
    `reply_to` BIGINT UNSIGNED NULL,
    `payload` TEXT NULL,
    `data` TEXT NULL,
    `media` TEXT NULL,
    `gallery_media_id` BIGINT UNSIGNED NULL,
    `error_code` VARCHAR(100) NULL,
    `communication_mode` ENUM('INBOX', 'AUTOMATION') NOT NULL DEFAULT 'INBOX',
    `automation_queue_id` BIGINT UNSIGNED NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_chatbot_messages_on_chat_id`(`chat_id`),
    INDEX `idx_chatbot_messages_on_parent_id`(`parent_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `chatbot_statistics` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `chatbot_id` BIGINT UNSIGNED NULL,
    `chatbot_name` VARCHAR(255) NULL,
    `direction` ENUM('INCOMING', 'OUTGOING') NULL,
    `message_type` VARCHAR(255) NULL,
    `created_at` DATETIME(0) NOT NULL,

    INDEX `idx_chatbot_statistics_on_chatbot_id`(`chatbot_id`),
    INDEX `idx_chatbot_statistics_on_workspace_id`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `chatbots` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `slug` VARCHAR(255) NOT NULL,
    `name` VARCHAR(30) NOT NULL,
    `status` ENUM('ACTIVE', 'DELETING', 'DELETED') NOT NULL DEFAULT 'ACTIVE',
    `options` LONGTEXT NULL,
    `creator_id` BIGINT UNSIGNED NOT NULL,
    `updater_id` BIGINT UNSIGNED NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_chatbots_on_creator_id`(`creator_id`),
    INDEX `idx_chatbots_on_status`(`status`),
    INDEX `idx_chatbots_on_workspace_id`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cloudinary` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `cloud_name` VARCHAR(25) NOT NULL,
    `api_key` VARCHAR(25) NOT NULL,
    `api_secret` VARCHAR(50) NOT NULL,
    `number_sequence` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `letter_sequence` VARCHAR(255) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `companies` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `description` TEXT NULL,
    `url` TEXT NULL,
    `address_id` BIGINT UNSIGNED NULL,
    `gallery_media_id` BIGINT UNSIGNED NULL,
    `tax_id` VARCHAR(50) NULL,
    `industry` VARCHAR(255) NULL,
    `status` ENUM('ACTIVE', 'TRASH', 'DELETED') NOT NULL DEFAULT 'ACTIVE',
    `trashed_at` TIMESTAMP(0) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `deleted_at` TIMESTAMP(0) NULL,

    INDEX `idx_companies_on_user_id`(`user_id`),
    INDEX `idx_companies_on_workspace_id`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `contact_date_triggers` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `contact_id` BIGINT UNSIGNED NOT NULL,
    `activity_slug` VARCHAR(255) NOT NULL,
    `triggered_at` DATETIME(0) NOT NULL,

    INDEX `idx_contact_date_triggers_on_contact_id`(`contact_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `contact_date_values` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `contact_id` BIGINT UNSIGNED NOT NULL,
    `value` DATETIME(0) NOT NULL,
    `field_slug` VARCHAR(255) NULL,
    `field_type` ENUM('SYSTEM', 'CUSTOM') NULL,
    `channel_id` BIGINT UNSIGNED NULL,
    `channel` ENUM('TELEGRAM', 'WHATSAPP', 'MESSENGER', 'INSTAGRAM', 'TWILIO', 'EVOLUTION', 'ZAPI') NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_contact_date_values_on_channel`(`channel`),
    INDEX `idx_contact_date_values_on_channel_id`(`channel_id`),
    INDEX `idx_contact_date_values_on_contact_id`(`contact_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `contact_emails` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `ownership_type` VARCHAR(255) NOT NULL,
    `ownership_id` BIGINT UNSIGNED NOT NULL,
    `modelable_type` VARCHAR(255) NOT NULL,
    `modelable_id` BIGINT UNSIGNED NOT NULL,
    `email` VARCHAR(255) NOT NULL,
    `slug` VARCHAR(30) NULL,
    `type` VARCHAR(10) NULL,
    `is_primary` TINYINT NOT NULL DEFAULT 0,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `contact_emails_modelable_type_modelable_id_index`(`modelable_type`, `modelable_id`),
    INDEX `contact_emails_ownership_type_ownership_id_index`(`ownership_type`, `ownership_id`),
    INDEX `idx_contact_emails_email`(`email`),
    INDEX `idx_contact_emails_on_email`(`email`),
    INDEX `idx_contact_emails_on_modelable_id`(`modelable_id`),
    INDEX `idx_contact_emails_on_modelable_type`(`modelable_type`),
    INDEX `idx_contact_emails_on_ownership_id`(`ownership_id`),
    INDEX `idx_contact_emails_on_ownership_type`(`ownership_type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `contact_export_requests` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `total` INTEGER UNSIGNED NOT NULL,
    `contact_ids` LONGTEXT NULL,
    `status` ENUM('NEW', 'RUNNING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'NEW',
    `fail_reason` LONGTEXT NULL,
    `file_path` TINYTEXT NOT NULL,
    `expires_at` DATETIME(0) NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `contact_last_messages` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `contact_id` BIGINT UNSIGNED NOT NULL,
    `channel` ENUM('whatsapp', 'messenger', 'instagram', 'telegram', 'twilio', 'evolution', 'zapi', 'webchat') NOT NULL,
    `messageable_type` VARCHAR(255) NOT NULL,
    `messageable_id` BIGINT UNSIGNED NOT NULL,
    `chatable_type` VARCHAR(255) NOT NULL,
    `chatable_id` BIGINT UNSIGNED NOT NULL,
    `channelable_type` VARCHAR(255) NOT NULL,
    `channelable_id` BIGINT UNSIGNED NOT NULL,
    `message` TEXT NULL,
    `message_type` VARCHAR(255) NULL,
    `media_url` TEXT NULL,
    `created_at` TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    INDEX `contact_last_messages_channel_index`(`channel`),
    INDEX `contact_last_messages_channelable_type_channelable_id_index`(`channelable_type`, `channelable_id`),
    INDEX `contact_last_messages_chatable_type_chatable_id_index`(`chatable_type`, `chatable_id`),
    INDEX `contact_last_messages_messageable_type_messageable_id_index`(`messageable_type`, `messageable_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `contact_mobiles` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `ownership_type` VARCHAR(255) NOT NULL,
    `ownership_id` BIGINT UNSIGNED NOT NULL,
    `modelable_type` VARCHAR(255) NOT NULL,
    `modelable_id` BIGINT UNSIGNED NOT NULL,
    `country_code` VARCHAR(60) NULL,
    `mobile_number` VARCHAR(60) NULL,
    `national_mobile_number` VARCHAR(20) NULL,
    `full_mobile_number` VARCHAR(60) NULL,
    `country_id` BIGINT UNSIGNED NOT NULL,
    `slug` VARCHAR(30) NULL,
    `type` VARCHAR(10) NULL,
    `is_primary` TINYINT NOT NULL DEFAULT 0,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `contact_mobiles_modelable_type_modelable_id_index`(`modelable_type`, `modelable_id`),
    INDEX `contact_mobiles_ownership_type_ownership_id_index`(`ownership_type`, `ownership_id`),
    INDEX `idx_contact_mobiles_full_number`(`full_mobile_number`),
    INDEX `idx_contact_mobiles_on_full_mobile_number`(`full_mobile_number`),
    INDEX `idx_contact_mobiles_on_modelable_id`(`modelable_id`),
    INDEX `idx_contact_mobiles_on_modelable_type`(`modelable_type`),
    INDEX `idx_contact_mobiles_on_ownership_id`(`ownership_id`),
    INDEX `idx_contact_mobiles_on_ownership_type`(`ownership_type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `contacts` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NULL,
    `first_name` VARCHAR(255) NULL,
    `last_name` VARCHAR(255) NULL,
    `full_name` VARCHAR(255) NULL,
    `title` VARCHAR(255) NULL,
    `gender` VARCHAR(255) NULL,
    `timezone` VARCHAR(255) NULL,
    `source` ENUM('MANUAL', 'IMPORT', 'SMS', 'EMAIL', 'TELEGRAM', 'WHATSAPP', 'INSTAGRAM', 'MESSENGER', 'API', 'VISUAL_API', 'WEBCHAT', 'VOICE_AI', 'ZAPI') NOT NULL DEFAULT 'MANUAL',
    `source_name` VARCHAR(255) NULL,
    `gallery_media_id` BIGINT UNSIGNED NULL,
    `status` ENUM('PENDING', 'ACTIVE', 'TRASH', 'DELETED') NOT NULL DEFAULT 'PENDING',
    `delete_status` ENUM('PENDING', 'PROCESSING', 'COMPLETED') NULL,
    `automations_paused_till` DATETIME(0) NULL,
    `locale` VARCHAR(30) NULL,
    `language` VARCHAR(30) NULL,
    `instagram_handler` VARCHAR(255) NULL,
    `trashed_at` TIMESTAMP(0) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `deleted_at` TIMESTAMP(0) NULL,
    `sourceable_type` VARCHAR(255) NULL,
    `sourceable_id` BIGINT UNSIGNED NULL,

    INDEX `contacts_sourceable_type_sourceable_id_index`(`sourceable_type`, `sourceable_id`),
    INDEX `idx_contacts_on_company_id`(`company_id`),
    INDEX `idx_contacts_on_full_name`(`full_name`),
    INDEX `idx_contacts_on_workspace_id`(`workspace_id`),
    INDEX `idx_contacts_workspace_deleted`(`workspace_id`, `deleted_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `conversion_events` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `value` VARCHAR(255) NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_conversion_events_on_workspace_id`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `countries` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(255) NOT NULL,
    `iso3` CHAR(3) NOT NULL,
    `iso2` CHAR(2) NOT NULL,
    `region` ENUM('EUROPE', 'ASIA', 'MIDDLE EAST', 'AFRICA', 'SOUTH AMERICA', 'NORTH AMERICA', 'CENTRAL AMERICA', 'AUSTRALIA', 'ANTARCTICA') NULL DEFAULT 'ASIA',
    `phone_code` VARCHAR(20) NULL,
    `phone_digits` SMALLINT NULL,
    `placeholder` VARCHAR(30) NULL,
    `capital` VARCHAR(30) NULL,
    `currency` VARCHAR(3) NULL,
    `currency_value` DOUBLE NULL,
    `status` ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `csv_webhook_data` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `csv_webhook_id` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `import_id` VARCHAR(60) NOT NULL,
    `sheet_id` VARCHAR(60) NOT NULL,
    `status` ENUM('PENDING', 'INPROCESS', 'COMPLETED', 'FAILED') NOT NULL,
    `data` TEXT NOT NULL,
    `expiry` DATETIME(0) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `csv_webhooks` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `data` LONGTEXT NOT NULL,
    `status` ENUM('PENDING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `custom_field_entities` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `entity_type` VARCHAR(255) NOT NULL,
    `entity_id` BIGINT UNSIGNED NOT NULL,
    `custom_field_id` BIGINT UNSIGNED NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `custom_field_entities_entity_type_entity_id_index`(`entity_type`, `entity_id`),
    INDEX `idx_custom_field_entities_on_custom_field_id`(`custom_field_id`),
    INDEX `idx_custom_field_entities_on_entity_id`(`entity_id`),
    INDEX `idx_custom_field_entities_on_entity_type`(`entity_type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `custom_field_entity_values` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `cf_entity_id` BIGINT UNSIGNED NOT NULL,
    `cf_property_id` BIGINT UNSIGNED NULL,
    `modelable_type` VARCHAR(255) NULL,
    `modelable_id` BIGINT UNSIGNED NULL,
    `value` TEXT NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `custom_field_entity_values_modelable_type_modelable_id_index`(`modelable_type`, `modelable_id`),
    INDEX `idx_custom_field_entity_values_on_cf_entity_id`(`cf_entity_id`),
    INDEX `idx_custom_field_entity_values_on_cf_property_id`(`cf_property_id`),
    INDEX `idx_custom_field_entity_values_on_modelable_id`(`modelable_id`),
    INDEX `idx_custom_field_entity_values_on_modelable_type`(`modelable_type`),
    INDEX `idx_custom_field_entity_values_on_value`(`value`(768)),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `custom_field_folders` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `custom_field_properties` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `custom_field_id` BIGINT UNSIGNED NOT NULL,
    `value` VARCHAR(255) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_custom_field_properties_on_custom_field_id`(`custom_field_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `custom_fields` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `modelable_type` VARCHAR(255) NOT NULL,
    `modelable_id` BIGINT UNSIGNED NOT NULL,
    `for` ENUM('COMPANY', 'WORKSPACE', 'OPPORTUNITY', 'CONTACT') NOT NULL,
    `folder_id` BIGINT UNSIGNED NULL,
    `slug` VARCHAR(60) NOT NULL,
    `label` VARCHAR(60) NOT NULL,
    `description` TEXT NULL,
    `content_type` ENUM('COUNTRY', 'CURRENCY', 'DATE', 'DATETIME', 'GENDER', 'NUMBER', 'PHONE', 'TEXT', 'URL', 'EMAIL', 'JSON', 'FIXED') NOT NULL,
    `input_type` ENUM('checkbox', 'multiselect', 'radio', 'select', 'text', 'textarea', 'email', 'number', 'paragraph') NOT NULL,
    `list_type` ENUM('create', 'import') NOT NULL,
    `validation` TEXT NULL,
    `has_properties` TINYINT NOT NULL DEFAULT 0,
    `is_multiselect` TINYINT NOT NULL DEFAULT 0,
    `system_defined` TINYINT NOT NULL DEFAULT 0,
    `allow_in_feeder` BOOLEAN NOT NULL DEFAULT false,
    `is_fixed` TINYINT NOT NULL DEFAULT 0,
    `fixed_value` TEXT NULL,
    `display_inbox` TINYINT NOT NULL DEFAULT 1,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `custom_fields_modelable_type_modelable_id_index`(`modelable_type`, `modelable_id`),
    INDEX `idx_custom_fields_on_custom_field_id`(`user_id`),
    INDEX `idx_custom_fields_on_modelable_id`(`modelable_id`),
    INDEX `idx_custom_fields_on_modelable_type`(`modelable_type`),
    INDEX `idx_custom_fields_on_workspace_id`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `dify_bots` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `api_key` VARCHAR(255) NOT NULL,
    `api_url` VARCHAR(255) NOT NULL,
    `bot_type` ENUM('chatbot', 'text_generator', 'agent', 'workflow') NULL DEFAULT 'chatbot',
    `method` ENUM('basic', 'chatflow') NULL DEFAULT 'basic',
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `dify_messages` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `dify_bot_id` BIGINT UNSIGNED NOT NULL,
    `contact_id` BIGINT UNSIGNED NOT NULL,
    `channel` VARCHAR(255) NOT NULL,
    `modelable_type` VARCHAR(255) NOT NULL,
    `modelable_id` BIGINT UNSIGNED NOT NULL,
    `model_message_id` BIGINT UNSIGNED NULL,
    `query` LONGTEXT NULL,
    `answer` LONGTEXT NULL,
    `task_id` VARCHAR(255) NULL,
    `process_id` VARCHAR(255) NULL,
    `message_id` VARCHAR(255) NULL,
    `conversation_id` VARCHAR(255) NULL,
    `status` VARCHAR(255) NULL,
    `failed_reason` TEXT NULL,
    `error_logs` TEXT NULL,
    `process_at` DATETIME(0) NULL,
    `mode` VARCHAR(255) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `dify_messages_modelable_type_modelable_id_index`(`modelable_type`, `modelable_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `domains` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `modelable_type` VARCHAR(255) NOT NULL,
    `modelable_id` BIGINT UNSIGNED NOT NULL,
    `sub_domain` VARCHAR(255) NOT NULL,
    `root_domain` VARCHAR(255) NOT NULL,
    `domain` VARCHAR(255) NOT NULL,
    `is_default` BOOLEAN NOT NULL DEFAULT true,
    `active` BOOLEAN NOT NULL DEFAULT false,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    UNIQUE INDEX `domains_domain_unique`(`domain`),
    INDEX `domains_modelable_type_modelable_id_index`(`modelable_type`, `modelable_id`),
    INDEX `idx_domains_on_active`(`active`),
    INDEX `idx_domains_on_modelable_id`(`modelable_id`),
    INDEX `idx_domains_on_modelable_type`(`modelable_type`),
    INDEX `idx_domains_on_sub_domain`(`sub_domain`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `elevenlabs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `api_key` VARCHAR(255) NOT NULL,
    `creator_id` BIGINT UNSIGNED NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `email_templates` (
    `id` INTEGER UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT NOT NULL,
    `accountable` ENUM('USER', 'ADMIN') NOT NULL DEFAULT 'USER',
    `slug` VARCHAR(60) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `description` TEXT NULL,
    `subject` VARCHAR(255) NOT NULL,
    `content` TEXT NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    UNIQUE INDEX `email_templates_slug_unique`(`slug`),
    INDEX `idx_email_templates_on_user_id`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `event_logs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `loggable_type` VARCHAR(50) NOT NULL,
    `loggable_id` BIGINT UNSIGNED NOT NULL,
    `action` VARCHAR(255) NOT NULL,
    `details` TEXT NULL,
    `data` LONGTEXT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_event_logs_on_loggable_id`(`loggable_id`),
    INDEX `idx_event_logs_on_loggable_type`(`loggable_type`),
    INDEX `idx_event_logs_on_user_id`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `events_queue` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `entity_type` VARCHAR(255) NOT NULL,
    `entity_id` BIGINT UNSIGNED NOT NULL,
    `event` VARCHAR(255) NOT NULL,
    `event_data` LONGTEXT NULL,
    `trigger_at` TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `repeat` BOOLEAN NOT NULL DEFAULT false,
    `repeat_period` ENUM('hour', 'day', 'month', 'year') NULL,
    `repeat_unit` BIGINT UNSIGNED NULL,
    `field_id` BIGINT UNSIGNED NULL,
    `field_type` ENUM('CUSTOM', 'SYTEM') NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `events_queue_entity_type_entity_id_index`(`entity_type`, `entity_id`),
    INDEX `idx_events_queue_on_workspace_id`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `evolution_chats` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `evolution_instance_id` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NULL,
    `contact_id` BIGINT UNSIGNED NOT NULL,
    `mobile_number` VARCHAR(255) NOT NULL,
    `profile_name` VARCHAR(255) NULL,
    `is_primary` BOOLEAN NOT NULL DEFAULT true,
    `last_auto_reply` TIMESTAMP(0) NULL,
    `last_business_interaction` TIMESTAMP(0) NULL,
    `last_client_interaction` TIMESTAMP(0) NULL,
    `input_activity_id` BIGINT UNSIGNED NULL,
    `input_expected_till` TIMESTAMP(0) NULL,
    `input_attempts` BIGINT UNSIGNED NOT NULL DEFAULT 0,
    `question_activity_id` BIGINT UNSIGNED NULL,
    `question_expected_till` DATETIME(0) NULL,
    `profile_attempts` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `evolution_instances` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `instance_id` VARCHAR(255) NULL,
    `name` VARCHAR(255) NOT NULL,
    `global_key` VARCHAR(255) NOT NULL,
    `api_url` VARCHAR(255) NOT NULL,
    `api_key` VARCHAR(255) NULL,
    `status` ENUM('PENDING', 'ACTIVE', 'FAILED', 'DELETING', 'DELETED', 'DISCONNECTED') NOT NULL DEFAULT 'PENDING',
    `state` VARCHAR(255) NULL,
    `fail_reason` VARCHAR(255) NULL,
    `delete_from_server` BOOLEAN NOT NULL DEFAULT false,
    `allow_in_feeder` BOOLEAN NOT NULL DEFAULT false,
    `webhook` VARCHAR(255) NULL,
    `creator_id` BIGINT UNSIGNED NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `deleted_at` TIMESTAMP(0) NULL,
    `phone_number` VARCHAR(255) NULL,
    `profile_name` VARCHAR(255) NULL,
    `profile_picture` VARCHAR(1000) NULL,
    `auto_reply_automation_id` BIGINT UNSIGNED NULL,
    `auto_reply_interval` VARCHAR(255) NOT NULL DEFAULT '247',

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `evolution_messages` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `evolution_chat_id` BIGINT UNSIGNED NOT NULL,
    `sender_id` BIGINT UNSIGNED NULL,
    `parent_id` BIGINT UNSIGNED NULL,
    `message_id` VARCHAR(255) NULL,
    `mobile_number` VARCHAR(255) NOT NULL,
    `type` VARCHAR(255) NOT NULL,
    `direction` ENUM('OUTGOING', 'INCOMING') NOT NULL DEFAULT 'INCOMING',
    `text` LONGTEXT NULL,
    `reply_to` BIGINT UNSIGNED NULL,
    `data` LONGTEXT NULL,
    `files` LONGTEXT NULL,
    `media` LONGTEXT NULL,
    `gallery_media_id` VARCHAR(255) NULL,
    `status` VARCHAR(255) NOT NULL DEFAULT 'sent',
    `automation_queue_id` BIGINT UNSIGNED NULL,
    `communication_mode` ENUM('INBOX', 'AUTOMATION') NOT NULL DEFAULT 'INBOX',
    `payload` TEXT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_evolution_messages_chat_created`(`evolution_chat_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `evolution_statistics` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `evolution_instance_id` BIGINT UNSIGNED NULL,
    `instance_name` VARCHAR(255) NULL,
    `direction` ENUM('INCOMING', 'OUTGOING') NULL,
    `message_type` VARCHAR(255) NULL,
    `created_at` DATETIME(0) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `failed_jobs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `uuid` VARCHAR(255) NOT NULL,
    `connection` TEXT NOT NULL,
    `queue` TEXT NOT NULL,
    `payload` LONGTEXT NOT NULL,
    `exception` LONGTEXT NOT NULL,
    `failed_at` TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    UNIQUE INDEX `failed_jobs_uuid_unique`(`uuid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `fb_chats` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `fb_page_id` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `contact_id` BIGINT UNSIGNED NULL,
    `is_primary` BOOLEAN NOT NULL DEFAULT true,
    `first_name` VARCHAR(255) NULL,
    `last_name` VARCHAR(255) NULL,
    `gender` VARCHAR(255) NULL,
    `timezone` VARCHAR(255) NULL,
    `locale` VARCHAR(255) NULL,
    `language` VARCHAR(255) NULL,
    `sender_id` VARCHAR(255) NOT NULL,
    `recipient_id` VARCHAR(255) NOT NULL,
    `last_interacted_at` DATETIME(0) NULL,
    `last_business_interaction` TIMESTAMP(0) NULL,
    `last_client_interaction` TIMESTAMP(0) NULL,
    `last_auto_reply` TIMESTAMP(0) NULL,
    `profile_last_updated` TIMESTAMP(0) NULL,
    `input_activity_id` BIGINT UNSIGNED NULL,
    `input_expected_till` TIMESTAMP(0) NULL,
    `input_attempts` BIGINT UNSIGNED NOT NULL DEFAULT 0,
    `question_activity_id` BIGINT NULL,
    `question_activity_slug` VARCHAR(255) NULL,
    `question_expected_till` TIMESTAMP(0) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_fb_chats_on_contact_id`(`contact_id`),
    INDEX `idx_fb_chats_on_fb_page_id`(`fb_page_id`),
    INDEX `idx_fb_chats_on_recipient_id`(`recipient_id`),
    INDEX `idx_fb_chats_on_sender_id`(`sender_id`),
    INDEX `idx_fb_chats_on_user_id`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `fb_features` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `fb_page_id` BIGINT UNSIGNED NOT NULL,
    `type` VARCHAR(30) NULL,
    `text` TEXT NULL,
    `payload_type` VARCHAR(20) NULL,
    `payload` TEXT NULL,
    `modelable_id` BIGINT UNSIGNED NULL,
    `modelable_type` VARCHAR(60) NULL,
    `is_published` TINYINT NOT NULL DEFAULT 0,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_fb_features_on_fb_page_id`(`fb_page_id`),
    INDEX `idx_fb_features_on_type`(`type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `fb_messages` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `fb_page_id` BIGINT UNSIGNED NOT NULL,
    `fb_chat_id` BIGINT UNSIGNED NOT NULL,
    `sender_id` BIGINT UNSIGNED NULL,
    `parent_id` BIGINT UNSIGNED NULL,
    `reply_to` BIGINT UNSIGNED NULL,
    `type` VARCHAR(255) NOT NULL,
    `direction` VARCHAR(255) NOT NULL,
    `text` LONGTEXT NULL,
    `referral` TEXT NULL,
    `data` LONGTEXT NULL,
    `gallery_media_id` BIGINT UNSIGNED NULL,
    `status` VARCHAR(255) NULL,
    `remind_at` TIMESTAMP(0) NULL,
    `error_code` VARCHAR(100) NULL,
    `communication_mode` ENUM('INBOX', 'AUTOMATION', 'BROADCAST') NOT NULL DEFAULT 'INBOX',
    `payload` TEXT NULL,
    `mid` VARCHAR(255) NULL,
    `automation_queue_id` BIGINT UNSIGNED NULL,
    `timestamp` VARCHAR(255) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_fb_messages_chat_created`(`fb_chat_id`, `created_at`),
    INDEX `idx_fb_messages_on_fb_chat_id`(`fb_chat_id`),
    INDEX `idx_fb_messages_on_fb_page_id`(`fb_page_id`),
    INDEX `idx_fb_messages_on_mid`(`mid`),
    INDEX `idx_fb_messages_on_parent_id`(`parent_id`),
    INDEX `idx_fb_messages_on_sender_id`(`sender_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `fb_otn_requests` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `fb_page_id` BIGINT UNSIGNED NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `description` VARCHAR(100) NOT NULL,
    `otn_type` VARCHAR(30) NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_fb_otn_requests_on_fb_page_id`(`fb_page_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `fb_otn_subscribers` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `fb_otn_request_id` BIGINT UNSIGNED NOT NULL,
    `fb_chat_id` BIGINT UNSIGNED NOT NULL,
    `contact_id` BIGINT UNSIGNED NULL,
    `title` TEXT NULL,
    `subscription_sent_on` TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `subscribed_at` TIMESTAMP(0) NULL,
    `notification_sent_on` TIMESTAMP(0) NULL,
    `token` TEXT NULL,
    `token_expiry` TEXT NULL,
    `token_status` TEXT NULL,
    `timezone` TEXT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_fb_otn_subscribers_on_contact_id`(`contact_id`),
    INDEX `idx_fb_otn_subscribers_on_fb_chat_id`(`fb_chat_id`),
    INDEX `idx_fb_otn_subscribers_on_fb_fb_otn_request_id`(`fb_otn_request_id`),
    INDEX `idx_fb_otn_subscribers_on_fb_otn_request_id`(`fb_otn_request_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `fb_page_users` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `fb_page_id` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_fb_page_users_on_fb_page_id`(`fb_page_id`),
    INDEX `idx_fb_page_users_on_user_id`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `fb_pages` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `access_token` VARCHAR(255) NOT NULL,
    `page_id` VARCHAR(255) NOT NULL,
    `name` VARCHAR(255) NULL,
    `username` VARCHAR(100) NULL,
    `status` ENUM('PENDING', 'ACTIVE', 'FAILED', 'DELETING', 'DELETED', 'NOT_CONNECTED', 'DISCONNECTED', 'ERROR') NOT NULL,
    `fail_reason` VARCHAR(500) NULL,
    `service_account_id` VARCHAR(255) NULL,
    `webhook` VARCHAR(255) NULL,
    `webhook_token` VARCHAR(255) NULL,
    `media` VARCHAR(255) NULL,
    `data` TEXT NULL,
    `gallery_media_id` BIGINT UNSIGNED NULL,
    `auto_reply_automation_id` BIGINT UNSIGNED NULL,
    `auto_reply_interval` VARCHAR(255) NOT NULL DEFAULT '247',
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `deleted_at` TIMESTAMP(0) NULL,
    `allow_in_feeder` SMALLINT NULL DEFAULT 0,

    INDEX `idx_fb_pages_on_page_id`(`page_id`),
    INDEX `idx_fb_pages_on_status`(`status`),
    INDEX `idx_fb_pages_on_user_id`(`user_id`),
    INDEX `idx_fb_pages_on_workspace_id`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `fb_statistics` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `page_id` BIGINT UNSIGNED NULL,
    `page_name` VARCHAR(255) NULL,
    `direction` ENUM('INCOMING', 'OUTGOING') NULL,
    `message_type` VARCHAR(255) NULL,
    `created_at` DATETIME(0) NOT NULL,

    INDEX `idx_fb_statistics_on_page_id`(`page_id`),
    INDEX `idx_fb_statistics_on_workspace_id`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `iframe_menus` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `iframe_permissions` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `iframe_id` BIGINT UNSIGNED NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `iframes` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `menu` VARCHAR(255) NULL,
    `placement` VARCHAR(20) NOT NULL DEFAULT 'settings_menu',
    `icon` VARCHAR(255) NULL,
    `menu_text` VARCHAR(255) NULL,
    `html` TEXT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inbox` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NULL,
    `assigned_by` BIGINT UNSIGNED NULL,
    `assigned_on` DATETIME(0) NULL DEFAULT CURRENT_TIMESTAMP(0),
    `type` ENUM('TELEGRAM', 'WHATSAPP', 'SMS', 'EMAIL', 'TASK', 'MESSENGER', 'INSTAGRAM', 'EVOLUTION', 'ZAPI', 'WEBCHAT') NOT NULL,
    `status` ENUM('ACTIVE', 'COMPLETED', 'UNASSIGNED', 'DELETED') NOT NULL,
    `is_read` TINYINT NOT NULL DEFAULT 1,
    `is_assigned` TINYINT NOT NULL DEFAULT 0,
    `snooze` DATETIME(0) NOT NULL,
    `modelable_type` VARCHAR(255) NOT NULL,
    `modelable_id` BIGINT UNSIGNED NOT NULL,
    `folder_id` BIGINT UNSIGNED NULL,
    `closed_by` BIGINT UNSIGNED NULL,
    `closed_at` DATETIME(0) NULL,
    `queued_at` TIMESTAMP(0) NULL,
    `last_updated` DATETIME(0) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_inbox_is_read`(`is_read`),
    INDEX `idx_inbox_last_updated`(`last_updated`),
    INDEX `idx_inbox_on_modelable_id`(`modelable_id`),
    INDEX `idx_inbox_on_modelable_type`(`modelable_type`),
    INDEX `idx_inbox_on_status`(`status`),
    INDEX `idx_inbox_on_user_id`(`user_id`),
    INDEX `idx_inbox_on_workspace_id`(`workspace_id`),
    INDEX `idx_inbox_snooze`(`snooze`),
    INDEX `idx_inbox_workspace_is_read`(`workspace_id`, `is_read`),
    INDEX `idx_inbox_workspace_snooze`(`workspace_id`, `snooze`),
    INDEX `idx_inbox_workspace_status_folder`(`workspace_id`, `status`, `folder_id`),
    INDEX `idx_inbox_workspace_user_status`(`workspace_id`, `user_id`, `status`),
    INDEX `inbox_modelable_type_modelable_id_index`(`modelable_type`, `modelable_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inbox_folders` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(30) NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `assigned_to` BIGINT UNSIGNED NULL,
    `assign_to` VARCHAR(30) NULL,

    INDEX `idx_inbox_folders_workspace_assign`(`workspace_id`, `assign_to`, `assigned_to`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inbox_settings` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `module` ENUM('INBOX') NOT NULL,
    `key` VARCHAR(255) NOT NULL,
    `value` VARCHAR(255) NOT NULL,
    `save_to_custom_field` TINYINT NOT NULL DEFAULT 0,
    `custom_field` TEXT NULL,
    `data_format` VARCHAR(30) NOT NULL DEFAULT 'json',
    `append_username` SMALLINT NOT NULL,
    `ai_prompt` TEXT NOT NULL,
    `ai_model` VARCHAR(30) NOT NULL DEFAULT 'gpt-4o-mini',
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `save_chat` TINYINT NOT NULL,
    `save_chat_as` VARCHAR(10) NOT NULL DEFAULT 'json',
    `chat_field` TEXT NULL,
    `automatically_pause_automation` BOOLEAN NOT NULL DEFAULT true,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inbox_system_fields` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` INTEGER UNSIGNED NOT NULL,
    `value` VARCHAR(255) NOT NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT false,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `insta_chats` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `insta_page_id` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `contact_id` BIGINT UNSIGNED NULL,
    `is_primary` BOOLEAN NOT NULL DEFAULT true,
    `name` VARCHAR(255) NULL,
    `username` VARCHAR(255) NULL,
    `sender_id` VARCHAR(255) NOT NULL,
    `is_verified_user` BOOLEAN NOT NULL DEFAULT false,
    `follower_count` INTEGER NOT NULL DEFAULT 0,
    `is_user_follow_business` BOOLEAN NOT NULL DEFAULT false,
    `is_business_follow_user` BOOLEAN NOT NULL DEFAULT false,
    `profile_last_updated` DATETIME(0) NULL,
    `recipient_id` VARCHAR(255) NOT NULL,
    `last_interacted_at` DATETIME(0) NULL,
    `last_business_interaction` TIMESTAMP(0) NULL,
    `last_client_interaction` TIMESTAMP(0) NULL,
    `last_auto_reply` TIMESTAMP(0) NULL,
    `input_activity_id` BIGINT UNSIGNED NULL,
    `input_expected_till` TIMESTAMP(0) NULL,
    `question_activity_id` BIGINT UNSIGNED NULL,
    `question_activity_slug` VARCHAR(255) NULL,
    `question_expected_till` TIMESTAMP(0) NULL,
    `input_attempts` BIGINT UNSIGNED NOT NULL DEFAULT 0,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_insta_chats_on_contact_id`(`contact_id`),
    INDEX `idx_insta_chats_on_insta_page_id`(`insta_page_id`),
    INDEX `idx_insta_chats_on_sender_id`(`sender_id`),
    INDEX `idx_insta_chats_on_user_id`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `insta_features` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `insta_page_id` BIGINT UNSIGNED NOT NULL,
    `type` VARCHAR(30) NULL,
    `text` TEXT NULL,
    `payload_type` VARCHAR(20) NULL,
    `payload` TEXT NULL,
    `modelable_id` BIGINT UNSIGNED NULL,
    `modelable_type` VARCHAR(60) NULL,
    `is_published` TINYINT NOT NULL DEFAULT 0,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_insta_features_on_modelable_id`(`modelable_id`),
    INDEX `idx_insta_features_on_modelable_type`(`modelable_type`),
    INDEX `idx_insta_features_on_sender_id`(`insta_page_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `insta_messages` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `insta_page_id` BIGINT UNSIGNED NOT NULL,
    `insta_chat_id` BIGINT UNSIGNED NOT NULL,
    `sender_id` BIGINT UNSIGNED NULL,
    `parent_id` BIGINT UNSIGNED NULL,
    `reply_to` BIGINT UNSIGNED NULL,
    `type` VARCHAR(255) NOT NULL,
    `direction` VARCHAR(255) NOT NULL,
    `text` LONGTEXT NULL,
    `referral` TEXT NULL,
    `data` LONGTEXT NULL,
    `gallery_media_id` BIGINT UNSIGNED NULL,
    `story_id` VARCHAR(255) NULL,
    `status` VARCHAR(255) NOT NULL DEFAULT 'sent',
    `remind_at` TIMESTAMP(0) NULL,
    `communication_mode` ENUM('INBOX', 'AUTOMATION') NOT NULL DEFAULT 'INBOX',
    `payload` TEXT NULL,
    `status_code` VARCHAR(255) NULL,
    `mid` VARCHAR(255) NULL,
    `automation_queue_id` BIGINT UNSIGNED NULL,
    `timestamp` VARCHAR(255) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_insta_messages_chat_created`(`insta_chat_id`, `created_at`),
    INDEX `idx_insta_messages_on_insta_chat_id`(`insta_chat_id`),
    INDEX `idx_insta_messages_on_insta_page_id`(`insta_page_id`),
    INDEX `idx_insta_messages_on_mid`(`mid`),
    INDEX `idx_insta_messages_on_parent_id`(`parent_id`),
    INDEX `idx_insta_messages_on_sender_id`(`sender_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `insta_page_users` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `insta_page_id` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_insta_page_users_on_insta_page_id`(`insta_page_id`),
    INDEX `idx_insta_page_users_on_user_id`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `insta_pages` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `access_token` VARCHAR(255) NOT NULL,
    `token_expirey` DATETIME(0) NULL,
    `page_id` VARCHAR(255) NULL,
    `ig_user_id` VARCHAR(255) NULL,
    `name` VARCHAR(255) NULL,
    `username` VARCHAR(255) NULL,
    `followers_count` INTEGER NOT NULL DEFAULT 0,
    `follows_count` INTEGER NOT NULL DEFAULT 0,
    `media_count` BIGINT NULL,
    `gallery_media_id` BIGINT UNSIGNED NULL,
    `auto_reply_automation_id` BIGINT UNSIGNED NULL,
    `auto_reply_interval` VARCHAR(255) NOT NULL DEFAULT '247',
    `status` ENUM('PENDING', 'ACTIVE', 'FAILED', 'DELETING', 'DELETED', 'NOT_CONNECTED', 'DISCONNECTED', 'ERROR') NOT NULL,
    `account_type` VARCHAR(30) NOT NULL,
    `platform` VARCHAR(60) NOT NULL DEFAULT 'facebook',
    `fail_reason` VARCHAR(500) NULL,
    `service_account_id` VARCHAR(255) NULL,
    `data` TEXT NULL,
    `permissions` TEXT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `deleted_at` TIMESTAMP(0) NULL,
    `allow_in_feeder` SMALLINT NULL DEFAULT 0,

    INDEX `idx_insta_page_users_on_ig_user_id`(`ig_user_id`),
    INDEX `idx_insta_page_users_on_page_id`(`page_id`),
    INDEX `idx_insta_page_users_on_status`(`status`),
    INDEX `idx_insta_page_users_on_user_id`(`user_id`),
    INDEX `idx_insta_page_users_on_workspace_id`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `insta_statistics` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `page_id` BIGINT UNSIGNED NULL,
    `page_name` VARCHAR(255) NULL,
    `direction` ENUM('INCOMING', 'OUTGOING') NULL,
    `message_type` VARCHAR(255) NULL,
    `created_at` DATETIME(0) NOT NULL,

    INDEX `idx_insta_statistics_on_direction`(`direction`),
    INDEX `idx_insta_statistics_on_message_type`(`message_type`),
    INDEX `idx_insta_statistics_on_page_id`(`page_id`),
    INDEX `idx_insta_statistics_on_workspace_id`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `instance_fields` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `instance_id` BIGINT NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `value` VARCHAR(255) NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `integrations` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `type` VARCHAR(60) NOT NULL,
    `modelable_type` VARCHAR(255) NOT NULL,
    `modelable_id` BIGINT UNSIGNED NOT NULL,
    `status` ENUM('PENDING', 'ACTIVE', 'PAUSED', 'SUSPENDED') NOT NULL DEFAULT 'ACTIVE',
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_integrations_on_modelable_id`(`modelable_id`),
    INDEX `idx_integrations_on_modelable_type`(`modelable_type`),
    INDEX `idx_integrations_on_status`(`status`),
    INDEX `idx_integrations_on_type`(`type`),
    INDEX `idx_integrations_on_workspace_id`(`workspace_id`),
    INDEX `integrations_modelable_type_modelable_id_index`(`modelable_type`, `modelable_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `job_batches` (
    `id` VARCHAR(255) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `total_jobs` INTEGER NOT NULL,
    `pending_jobs` INTEGER NOT NULL,
    `failed_jobs` INTEGER NOT NULL,
    `failed_job_ids` LONGTEXT NOT NULL,
    `options` MEDIUMTEXT NULL,
    `cancelled_at` INTEGER NULL,
    `created_at` INTEGER NOT NULL,
    `finished_at` INTEGER NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `jobs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `queue` VARCHAR(255) NOT NULL,
    `payload` LONGTEXT NOT NULL,
    `attempts` TINYINT UNSIGNED NOT NULL,
    `reserved_at` INTEGER UNSIGNED NULL,
    `available_at` INTEGER UNSIGNED NOT NULL,
    `created_at` INTEGER UNSIGNED NOT NULL,

    INDEX `jobs_queue_index`(`queue`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `legal_documents` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `modelable_type` VARCHAR(255) NOT NULL,
    `modelable_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `link_text` VARCHAR(100) NOT NULL,
    `label` VARCHAR(2000) NOT NULL,
    `type` ENUM('CHECKBOX1', 'CHECKBOX2') NOT NULL,
    `status` ENUM('ACTIVE', 'ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
    `file_url` VARCHAR(2000) NULL,
    `file_media_id` BIGINT UNSIGNED NULL,
    `creator_id` BIGINT UNSIGNED NOT NULL,
    `updater_id` BIGINT UNSIGNED NOT NULL,
    `archived_at` DATETIME(0) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_legal_documents_on_creator_id`(`creator_id`),
    INDEX `idx_legal_documents_on_file_url`(`file_url`(768)),
    INDEX `idx_legal_documents_on_modelable_id`(`modelable_id`),
    INDEX `idx_legal_documents_on_modelable_type`(`modelable_type`),
    INDEX `idx_legal_documents_on_status`(`status`),
    INDEX `legal_documents_modelable_type_modelable_id_index`(`modelable_type`, `modelable_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `make_webhooks` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `webhook_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `url` VARCHAR(255) NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `deleted_at` TIMESTAMP(0) NULL,

    INDEX `idx_make_webhooks_on_user_id`(`user_id`),
    INDEX `idx_make_webhooks_on_webhook_id`(`webhook_id`),
    INDEX `idx_make_webhooks_on_workspace_id`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `marketplace` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `agency_id` BIGINT UNSIGNED NOT NULL,
    `slug` VARCHAR(255) NOT NULL,
    `representative` VARCHAR(250) NOT NULL,
    `email` VARCHAR(255) NOT NULL,
    `mobile_number` VARCHAR(255) NOT NULL,
    `whatsapp_number` VARCHAR(255) NULL,
    `business_name` VARCHAR(255) NOT NULL,
    `main_language` VARCHAR(255) NOT NULL,
    `other_languages` LONGTEXT NULL,
    `website` VARCHAR(1000) NULL,
    `x` VARCHAR(1000) NULL,
    `instagram` VARCHAR(1000) NULL,
    `linkedin` VARCHAR(1000) NULL,
    `services` LONGTEXT NULL,
    `about` MEDIUMTEXT NOT NULL,
    `badge` ENUM('silver', 'gold') NULL,
    `status` ENUM('PENDING', 'APPROVED', 'DECLINED') NOT NULL DEFAULT 'PENDING',
    `priority` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `decline_reason` TEXT NULL,
    `certified` BOOLEAN NOT NULL DEFAULT false,
    `show_in_marketplace` BOOLEAN NOT NULL DEFAULT true,
    `avatar_id` BIGINT UNSIGNED NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `fkAgency`(`agency_id`),
    INDEX `indStatus`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `media_gallery` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NULL,
    `workspace_id` BIGINT UNSIGNED NULL,
    `modelable_type` VARCHAR(255) NOT NULL,
    `modelable_id` BIGINT UNSIGNED NOT NULL,
    `object_type` VARCHAR(255) NULL,
    `parent_id` BIGINT UNSIGNED NULL,
    `_lft` INTEGER NULL DEFAULT 0,
    `_rgt` INTEGER NULL DEFAULT 0,
    `object_name` VARCHAR(100) NULL,
    `object_id` VARCHAR(60) NULL,
    `media_type` ENUM('FILE', 'FOLDER', 'IMAGE', 'VIDEO', 'DOCUMENT', 'AUDIO') NOT NULL DEFAULT 'IMAGE',
    `file_size` INTEGER NOT NULL DEFAULT 0,
    `mime_type` VARCHAR(50) NULL,
    `extension` VARCHAR(10) NULL,
    `object_status` ENUM('AVAILABLE', 'DELETED') NOT NULL DEFAULT 'AVAILABLE',
    `hidden` BOOLEAN NOT NULL DEFAULT false,
    `expiry` DATETIME(0) NULL,
    `file_path` VARCHAR(500) NULL,
    `file_url` TEXT NULL,
    `thumb_200` VARCHAR(1000) NULL,
    `thumb_200_path` VARCHAR(500) NULL,
    `privacy` ENUM('PUBLIC', 'PRIVATE') NOT NULL DEFAULT 'PRIVATE',
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `deleted_at` TIMESTAMP(0) NULL,

    INDEX `idx_expiry`(`expiry`),
    INDEX `idx_media_gallery_on_media_type`(`media_type`),
    INDEX `idx_media_gallery_on_modelable_id`(`modelable_id`),
    INDEX `idx_media_gallery_on_modelable_type`(`modelable_type`),
    INDEX `idx_media_gallery_on_parent_id`(`parent_id`),
    INDEX `idx_media_gallery_on_user_id`(`user_id`),
    INDEX `media_gallery_modelable_type_modelable_id_index`(`modelable_type`, `modelable_id`),
    INDEX `media_gallery_object_name_index`(`object_name`),
    INDEX `media_gallery_user_id_index`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `message_reactions` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `sender_id` BIGINT UNSIGNED NULL,
    `message_type` VARCHAR(255) NOT NULL,
    `message_id` BIGINT UNSIGNED NOT NULL,
    `reaction` VARCHAR(24) NULL,
    `direction` VARCHAR(255) NOT NULL DEFAULT 'INCOMING',
    `communication_mode` VARCHAR(255) NOT NULL DEFAULT 'INBOX',
    `payload` TEXT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `message_reactions_message_type_message_id_index`(`message_type`, `message_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `migrations` (
    `id` INTEGER UNSIGNED NOT NULL AUTO_INCREMENT,
    `migration` VARCHAR(255) NOT NULL,
    `batch` INTEGER NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `mobile_app_tokens` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `fcm_token` TEXT NOT NULL,
    `device_id` VARCHAR(255) NOT NULL,
    `app_name` LONGTEXT NULL,
    `version` VARCHAR(255) NOT NULL,
    `device_type` VARCHAR(30) NOT NULL,
    `data` TEXT NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ms_text_to_speech` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `title` VARCHAR(60) NULL,
    `key` TEXT NOT NULL,
    `region` VARCHAR(60) NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notes` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NULL,
    `company_id` BIGINT UNSIGNED NULL,
    `contact_id` BIGINT UNSIGNED NULL,
    `type` VARCHAR(30) NOT NULL DEFAULT 'NOTE',
    `modelable_type` VARCHAR(255) NOT NULL,
    `modelable_id` BIGINT UNSIGNED NOT NULL,
    `text` TEXT NULL,
    `icon` VARCHAR(100) NOT NULL,
    `data` LONGTEXT NULL,
    `gallery_media_id` BIGINT UNSIGNED NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_notes_on_company_id`(`company_id`),
    INDEX `idx_notes_on_contact_id`(`contact_id`),
    INDEX `idx_notes_on_type`(`type`),
    INDEX `idx_notes_on_user_id`(`user_id`),
    INDEX `notes_modelable_type_modelable_id_index`(`modelable_type`, `modelable_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notification_emails` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `modelable_type` VARCHAR(255) NOT NULL,
    `modelable_id` BIGINT UNSIGNED NOT NULL,
    `prefix` VARCHAR(100) NOT NULL,
    `domain` VARCHAR(100) NOT NULL,
    `email` VARCHAR(250) NOT NULL,
    `request_id` VARCHAR(250) NULL,
    `dkim_expected` VARCHAR(250) NULL,
    `dkim_selector` VARCHAR(50) NULL,
    `dkim_verified` BOOLEAN NOT NULL DEFAULT false,
    `dkim_status` TEXT NULL,
    `dkim_value` VARCHAR(250) NULL,
    `rpath_expected` VARCHAR(250) NULL,
    `rpath_selector` VARCHAR(50) NULL,
    `rpath_verified` BOOLEAN NOT NULL DEFAULT false,
    `rpath_status` TEXT NULL,
    `rpath_value` VARCHAR(250) NULL,
    `cname_expected` VARCHAR(250) NULL,
    `cname_selector` VARCHAR(50) NULL,
    `cname_verified` BOOLEAN NOT NULL DEFAULT false,
    `cname_status` TEXT NULL,
    `cname_value` VARCHAR(250) NULL,
    `status` ENUM('UNVERIFIED', 'VERIFIED') NOT NULL DEFAULT 'UNVERIFIED',
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_notes_on_modelable_email`(`email`),
    INDEX `idx_notes_on_modelable_modelable_id`(`modelable_id`),
    INDEX `idx_notes_on_modelable_type`(`modelable_type`),
    INDEX `notification_emails_modelable_type_modelable_id_index`(`modelable_type`, `modelable_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notifications` (
    `id` CHAR(36) NOT NULL,
    `slug` VARCHAR(255) NOT NULL,
    `type` VARCHAR(255) NOT NULL,
    `notifiable_type` VARCHAR(255) NOT NULL,
    `notifiable_id` BIGINT UNSIGNED NOT NULL,
    `data` TEXT NOT NULL,
    `read_at` TIMESTAMP(0) NULL,
    `read` TINYINT NOT NULL DEFAULT 0,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `triggerable_type` VARCHAR(255) NULL,
    `triggerable_id` BIGINT UNSIGNED NULL,

    INDEX `idx_notifications_on_notifiable_id`(`notifiable_id`),
    INDEX `idx_notifications_on_notifiable_type`(`notifiable_type`),
    INDEX `idx_notifications_on_slug`(`slug`),
    INDEX `idx_notifications_on_type`(`type`),
    INDEX `notifications_notifiable_type_notifiable_id_index`(`notifiable_type`, `notifiable_id`),
    INDEX `notifications_triggerable_type_triggerable_id_index`(`triggerable_type`, `triggerable_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `oauth_access_tokens` (
    `id` VARCHAR(100) NOT NULL,
    `user_id` BIGINT UNSIGNED NULL,
    `client_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(255) NULL,
    `scopes` TEXT NULL,
    `revoked` BOOLEAN NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `expires_at` DATETIME(0) NULL,

    INDEX `oauth_access_tokens_user_id_index`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `oauth_auth_codes` (
    `id` VARCHAR(100) NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `client_id` BIGINT UNSIGNED NOT NULL,
    `scopes` TEXT NULL,
    `revoked` BOOLEAN NOT NULL,
    `expires_at` DATETIME(0) NULL,

    INDEX `oauth_auth_codes_user_id_index`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `oauth_clients` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NULL,
    `name` VARCHAR(255) NOT NULL,
    `secret` VARCHAR(100) NULL,
    `provider` VARCHAR(255) NULL,
    `redirect` TEXT NOT NULL,
    `personal_access_client` BOOLEAN NOT NULL,
    `password_client` BOOLEAN NOT NULL,
    `revoked` BOOLEAN NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `oauth_clients_user_id_index`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `oauth_personal_access_clients` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `client_id` BIGINT UNSIGNED NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_oauth_personal_access_clients_on_client_id`(`client_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `oauth_refresh_tokens` (
    `id` VARCHAR(100) NOT NULL,
    `access_token_id` VARCHAR(100) NOT NULL,
    `revoked` BOOLEAN NOT NULL,
    `expires_at` DATETIME(0) NULL,

    INDEX `idx_oauth_refresh_tokens_on_access_token_id`(`access_token_id`),
    INDEX `oauth_refresh_tokens_access_token_id_index`(`access_token_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `opportunity_actions` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `op_id` BIGINT UNSIGNED NULL,
    `triggered` TINYINT NOT NULL DEFAULT 0,
    `triggered_at` TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `otp_codes` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `key` VARCHAR(255) NOT NULL,
    `code` CHAR(5) NOT NULL,
    `expiry` TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `password_resets` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `email` VARCHAR(255) NOT NULL,
    `token` VARCHAR(255) NOT NULL,
    `created_at` TIMESTAMP(0) NULL,

    INDEX `password_resets_email_index`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `personal_access_tokens` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `tokenable_type` VARCHAR(255) NOT NULL,
    `tokenable_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `token` VARCHAR(64) NOT NULL,
    `abilities` TEXT NULL,
    `last_used_at` TIMESTAMP(0) NULL,
    `expires_at` TIMESTAMP(0) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    UNIQUE INDEX `personal_access_tokens_token_unique`(`token`),
    INDEX `idx_personal_access_tokens_on_tokenable_id`(`tokenable_id`),
    INDEX `idx_personal_access_tokens_on_tokenable_type`(`tokenable_type`),
    INDEX `idx_personal_tokens_last_used`(`last_used_at`),
    INDEX `personal_access_tokens_tokenable_type_tokenable_id_index`(`tokenable_type`, `tokenable_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pipeline_actions` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `pl_id` BIGINT UNSIGNED NOT NULL,
    `pl_step_id` BIGINT UNSIGNED NULL,
    `action_type` VARCHAR(30) NOT NULL,
    `data_type` VARCHAR(30) NOT NULL DEFAULT 'fixed',
    `actionable_type` VARCHAR(255) NULL,
    `actionable_id` BIGINT UNSIGNED NULL,
    `condition` LONGTEXT NULL,
    `data` LONGTEXT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `pipeline_actions_actionable_type_actionable_id_index`(`actionable_type`, `actionable_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pipeline_lost_reasons` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `title` VARCHAR(250) NULL,
    `pl_id` BIGINT UNSIGNED NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_pipeline_lost_reasons_on_pl_id`(`pl_id`),
    INDEX `idx_pipeline_lost_reasons_on_user_id`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pipeline_opportunities` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `title` VARCHAR(255) NULL,
    `pl_id` BIGINT UNSIGNED NOT NULL,
    `pl_step_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `contact_id` BIGINT UNSIGNED NOT NULL,
    `assign_to` BIGINT UNSIGNED NULL,
    `probability` INTEGER NOT NULL DEFAULT 5,
    `currency` CHAR(5) NOT NULL,
    `country_id` SMALLINT UNSIGNED NOT NULL,
    `value` DOUBLE NOT NULL,
    `closing_date` DATETIME(0) NULL,
    `note` TEXT NULL,
    `status` ENUM('ACTIVE', 'WON', 'LOST') NOT NULL DEFAULT 'ACTIVE',
    `status_changed_at` DATETIME(0) NULL,
    `lost_reason_id` BIGINT UNSIGNED NULL,
    `order` SMALLINT NOT NULL DEFAULT 1,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_pipeline_opportunities_on_assign_to`(`assign_to`),
    INDEX `idx_pipeline_opportunities_on_closing_date`(`closing_date`),
    INDEX `idx_pipeline_opportunities_on_company_id`(`company_id`),
    INDEX `idx_pipeline_opportunities_on_contact_id`(`contact_id`),
    INDEX `idx_pipeline_opportunities_on_pl_id`(`pl_id`),
    INDEX `idx_pipeline_opportunities_on_pl_step_id`(`pl_step_id`),
    INDEX `idx_pipeline_opportunities_on_status`(`status`),
    INDEX `idx_pipeline_opportunities_on_user_id`(`user_id`),
    INDEX `idx_pipeline_opportunities_on_workspace_id`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pipeline_opportunity_contacts` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `opportunity_id` BIGINT UNSIGNED NOT NULL,
    `contact_id` BIGINT UNSIGNED NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_pipeline_opportunity_contacts_on_contact_id`(`contact_id`),
    INDEX `idx_pipeline_opportunity_contacts_on_opportunity_id`(`opportunity_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pipeline_opportunity_notes` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `opportunity_id` BIGINT UNSIGNED NOT NULL,
    `gallery_media_id` BIGINT UNSIGNED NULL,
    `note` TEXT NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_pipeline_opportunity_notes_on_gallery_media_id`(`gallery_media_id`),
    INDEX `idx_pipeline_opportunity_notes_on_opportunity_id`(`opportunity_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pipeline_opportunity_step_logs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `opportunity_id` BIGINT UNSIGNED NOT NULL,
    `pl_id` BIGINT UNSIGNED NOT NULL,
    `from_step_id` BIGINT UNSIGNED NULL,
    `to_step_id` BIGINT UNSIGNED NOT NULL,
    `changed_at` TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `user_id` BIGINT UNSIGNED NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `pipeline_opportunity_step_logs_from_step_id_foreign`(`from_step_id`),
    INDEX `pipeline_opportunity_step_logs_opportunity_id_foreign`(`opportunity_id`),
    INDEX `pipeline_opportunity_step_logs_pl_id_foreign`(`pl_id`),
    INDEX `pipeline_opportunity_step_logs_to_step_id_foreign`(`to_step_id`),
    INDEX `pipeline_opportunity_step_logs_user_id_foreign`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pipeline_permissions` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `pl_id` BIGINT UNSIGNED NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_pipeline_permissions_on_pl_id`(`pl_id`),
    INDEX `idx_pipeline_permissions_on_user_id`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pipeline_steps` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `pl_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `order` SMALLINT NOT NULL DEFAULT 1,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `bg_color` VARCHAR(10) NOT NULL DEFAULT '#eab308',
    `txt_color` VARCHAR(10) NOT NULL DEFAULT '#000000',

    INDEX `idx_pipeline_steps_on_order`(`order`),
    INDEX `idx_pipeline_steps_on_pl_id`(`pl_id`),
    INDEX `idx_pipeline_steps_on_user_id`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `pipelines` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `country_id` BIGINT UNSIGNED NOT NULL,
    `currency` CHAR(5) NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_pipelines_on_user_id`(`user_id`),
    INDEX `idx_pipelines_on_workspace_id`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `premium_support_users` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `agency_id` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `email` VARCHAR(255) NOT NULL,
    `mobile_number` VARCHAR(255) NOT NULL,
    `mobile_country_id` INTEGER UNSIGNED NOT NULL,
    `mobile_suffix` VARCHAR(255) NOT NULL,
    `whatsapp_number` VARCHAR(255) NOT NULL,
    `whatsapp_country_id` INTEGER UNSIGNED NOT NULL,
    `whatsapp_suffix` VARCHAR(255) NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `quick_filters` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `filter` TEXT NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_quick_filters_on_user_id`(`user_id`),
    INDEX `idx_quick_filters_on_workspace_id`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `quick_response_media` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `quick_response_id` BIGINT UNSIGNED NOT NULL,
    `gallery_media_id` BIGINT UNSIGNED NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_quick_response_media_on_quick_response_id`(`quick_response_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `quick_responses` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `parent_id` BIGINT UNSIGNED NULL,
    `title` VARCHAR(80) NOT NULL,
    `text` TEXT NULL,
    `type` ENUM('text', 'media') NOT NULL DEFAULT 'text',
    `share` ENUM('private', 'public', 'users', 'group') NOT NULL DEFAULT 'private',
    `bindings` TEXT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_quick_responses_on_parent_id`(`parent_id`),
    INDEX `idx_quick_responses_on_user_id`(`user_id`),
    INDEX `idx_quick_responses_on_workspace_id`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `referrals` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `contact_id` BIGINT UNSIGNED NOT NULL,
    `modelable_type` VARCHAR(255) NULL,
    `modelable_id` BIGINT UNSIGNED NULL,
    `ad_id` VARCHAR(255) NOT NULL,
    `title` VARCHAR(255) NULL,
    `subtitle` VARCHAR(255) NULL,
    `source` VARCHAR(255) NULL,
    `type` VARCHAR(255) NULL,
    `data` TEXT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `referrals_modelable_type_modelable_id_index`(`modelable_type`, `modelable_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `reports` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `type` VARCHAR(255) NOT NULL DEFAULT 'text',
    `model` VARCHAR(255) NOT NULL,
    `save_pdf` BOOLEAN NOT NULL DEFAULT false,
    `prompt` TEXT NOT NULL,
    `run_started_at` DATETIME(0) NULL,
    `response` TEXT NULL,
    `generated_pdf` VARCHAR(255) NULL,
    `generated_at` TIMESTAMP(0) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `services` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(255) NOT NULL,
    `url` VARCHAR(255) NOT NULL,
    `status` ENUM('RUNNING', 'ERROR') NOT NULL DEFAULT 'RUNNING',
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `settings` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(255) NOT NULL,
    `slug` VARCHAR(255) NOT NULL,
    `value` TEXT NULL,
    `category` VARCHAR(250) NULL,
    `visible` BOOLEAN NOT NULL DEFAULT true,
    `field_type` ENUM('TEXT', 'TEXTAREA', 'CHOICES', 'EDITOR') NOT NULL DEFAULT 'TEXT',

    INDEX `idx_settings_on_category`(`category`),
    INDEX `idx_settings_on_slug`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `smtp2go_templates` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(250) NOT NULL,
    `template_id` BIGINT UNSIGNED NOT NULL,
    `subject` TEXT NOT NULL,
    `type` VARCHAR(255) NOT NULL,
    `locale` ENUM('en-US', 'pt-BR', 'es-ES') NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `support_numbers` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `contact_id` BIGINT UNSIGNED NOT NULL,
    `inbox_id` BIGINT UNSIGNED NOT NULL,
    `sn_number` VARCHAR(30) NOT NULL,
    `is_open` SMALLINT NOT NULL DEFAULT 1,
    `time_difference` BIGINT UNSIGNED NULL,
    `channel_type` ENUM('whatsapp', 'zapi', 'telegram', 'instagram', 'messenger', 'sms', 'email', 'task') NOT NULL,
    `chatable_type` VARCHAR(255) NOT NULL,
    `chatable_id` BIGINT UNSIGNED NOT NULL,
    `channelable_type` VARCHAR(255) NOT NULL,
    `channelable_id` BIGINT UNSIGNED NOT NULL,
    `closed_at` DATETIME(0) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_support_numbers_inbox_open`(`inbox_id`, `is_open`),
    INDEX `idx_support_numbers_workspace_sn`(`workspace_id`, `sn_number`),
    INDEX `support_numbers_channelable_type_channelable_id_index`(`channelable_type`, `channelable_id`),
    INDEX `support_numbers_chatable_type_chatable_id_index`(`chatable_type`, `chatable_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `swich_accounts` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NULL,
    `agency_id` BIGINT UNSIGNED NULL,
    `environment` VARCHAR(20) NOT NULL DEFAULT 'sandbox',
    `client_id` VARCHAR(255) NOT NULL,
    `client_secret` VARCHAR(255) NOT NULL,
    `pwa_client_id` VARCHAR(255) NULL,
    `pwa_client_secret` VARCHAR(255) NULL,
    `checksum_secret` VARCHAR(255) NULL,
    `aes_encryption_key` VARCHAR(255) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_swich_accounts_workspace_id`(`workspace_id`),
    INDEX `idx_swich_accounts_agency_id`(`agency_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `swich_transactions` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NULL,
    `agency_id` BIGINT UNSIGNED NULL,
    `swich_account_id` BIGINT UNSIGNED NULL,
    `customer_transaction_id` VARCHAR(50) NOT NULL,
    `channel` VARCHAR(30) NOT NULL,
    `swich_transaction_id` VARCHAR(50) NULL,
    `swich_order_id` VARCHAR(50) NULL,
    `amount` DECIMAL(12, 2) NULL,
    `currency` VARCHAR(10) NULL DEFAULT 'PKR',
    `status` VARCHAR(30) NOT NULL DEFAULT 'pending',
    `msisdn` VARCHAR(20) NULL,
    `request_payload` JSON NULL,
    `response_payload` JSON NULL,
    `callback_payload` JSON NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    UNIQUE INDEX `uq_swich_transactions_customer_transaction_id`(`customer_transaction_id`),
    INDEX `idx_swich_transactions_workspace_id`(`workspace_id`),
    INDEX `idx_swich_transactions_agency_id`(`agency_id`),
    INDEX `idx_swich_transactions_swich_account_id`(`swich_account_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `system_fields` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(255) NOT NULL,
    `slug` VARCHAR(255) NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `system_legal_documents` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(100) NOT NULL,
    `link_text` VARCHAR(100) NOT NULL,
    `label` VARCHAR(2000) NOT NULL,
    `type` ENUM('REGISTER1', 'REGISTER2', 'REGISTER3') NOT NULL,
    `status` ENUM('ACTIVE', 'ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
    `file_url` VARCHAR(2000) NULL,
    `file_media_id` BIGINT UNSIGNED NULL,
    `creator_id` BIGINT UNSIGNED NOT NULL,
    `updater_id` BIGINT UNSIGNED NOT NULL,
    `archived_at` DATETIME(0) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tag_folders` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(25) NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_tag_folders_on_workspace_id`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tag_links` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `linkable_type` VARCHAR(255) NOT NULL,
    `linkable_id` BIGINT UNSIGNED NOT NULL,
    `tag_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(25) NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_linkable_type_on_linkable_id`(`linkable_id`),
    INDEX `idx_linkable_type_on_linkable_type`(`linkable_type`),
    INDEX `idx_linkable_type_on_tag_id`(`tag_id`),
    INDEX `tag_links_linkable_type_linkable_id_index`(`linkable_type`, `linkable_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tags` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `folder_id` BIGINT UNSIGNED NULL,
    `taggable_type` VARCHAR(255) NOT NULL,
    `taggable_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(25) NOT NULL,
    `display_inbox` TINYINT NOT NULL DEFAULT 1,
    `bg_color` VARCHAR(255) NOT NULL DEFAULT '#f3f4f6',
    `text_color` VARCHAR(255) NOT NULL DEFAULT '#111827',
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_tags_on_folder_id`(`folder_id`),
    INDEX `idx_tags_on_taggable_id`(`taggable_id`),
    INDEX `idx_tags_on_taggable_type`(`taggable_type`),
    INDEX `idx_tags_on_user_id`(`user_id`),
    INDEX `idx_tags_on_workspace_id`(`workspace_id`),
    INDEX `tags_taggable_type_taggable_id_index`(`taggable_type`, `taggable_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `task_messages` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NULL,
    `task_id` BIGINT UNSIGNED NOT NULL,
    `text` TEXT NOT NULL,
    `type` VARCHAR(255) NOT NULL,
    `data` LONGTEXT NULL,
    `gallery_media_id` BIGINT UNSIGNED NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `parent_id` BIGINT UNSIGNED NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tasks` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NULL,
    `creator_id` BIGINT UNSIGNED NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `contact_id` BIGINT UNSIGNED NULL,
    `support_number` VARCHAR(256) NULL,
    `status` ENUM('ACTIVE', 'COMPLETED') NOT NULL DEFAULT 'ACTIVE',
    `description` TEXT NOT NULL,
    `datetime` DATETIME(0) NOT NULL,
    `created_by` BIGINT UNSIGNED NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_tasks_on_company_id`(`company_id`),
    INDEX `idx_tasks_on_contact_id`(`contact_id`),
    INDEX `idx_tasks_on_user_id`(`user_id`),
    INDEX `idx_tasks_on_workspace_id`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `team_members` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `team_id` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `priority` TINYINT NULL,
    `last_outgoing_call` DATETIME(0) NULL,
    `last_incoming_call` DATETIME(0) NULL,
    `opportunity_counter` BIGINT UNSIGNED NOT NULL DEFAULT 0,
    `last_opportunity_assigned_at` TIMESTAMP(0) NULL,
    `conversation_counter` BIGINT UNSIGNED NOT NULL DEFAULT 0,
    `last_conversation_assigned_at` TIMESTAMP(0) NULL,
    `creator_id` BIGINT UNSIGNED NOT NULL,
    `updater_id` BIGINT UNSIGNED NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_team_members_on_team_id`(`team_id`),
    INDEX `idx_team_members_on_user_id`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `teams` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `created_by` BIGINT UNSIGNED NOT NULL,
    `updated_by` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(60) NOT NULL,
    `distribution` ENUM('EQUAL', 'PRIORITY') NOT NULL DEFAULT 'EQUAL',
    `auto_assign` TINYINT NOT NULL DEFAULT 0,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_teams_on_workspace_id`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `telegram_bot_users` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `telegram_bot_id` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_telegram_bot_users_on_telegram_bot_id`(`telegram_bot_id`),
    INDEX `idx_telegram_bot_users_on_user_id`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `telegram_bots` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(30) NOT NULL,
    `tg_name` VARCHAR(255) NULL,
    `tg_code` VARCHAR(255) NULL,
    `token` TEXT NOT NULL,
    `old_token` VARCHAR(100) NULL,
    `verified` BOOLEAN NOT NULL DEFAULT false,
    `tg_bot_id` BIGINT UNSIGNED NULL,
    `slug` VARCHAR(50) NULL,
    `status` ENUM('PENDING', 'ACTIVE', 'FAILED', 'DELETING', 'DELETED', 'DISCONNECTED') NOT NULL DEFAULT 'PENDING',
    `auto_reply_automation_id` BIGINT UNSIGNED NULL,
    `auto_reply_interval` VARCHAR(255) NOT NULL DEFAULT '247',
    `fail_reason` VARCHAR(500) NULL,
    `creator_id` BIGINT UNSIGNED NOT NULL,
    `updater_id` BIGINT UNSIGNED NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `deleted_at` TIMESTAMP(0) NULL,

    INDEX `idx_telegram_bots_on_tg_bot_id`(`tg_bot_id`),
    INDEX `idx_telegram_bots_on_workspace_id`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `telegram_chats` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `telegram_bot_id` BIGINT UNSIGNED NOT NULL,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `from_id` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `contact_id` BIGINT UNSIGNED NOT NULL,
    `company_id` BIGINT UNSIGNED NOT NULL,
    `first_name` VARCHAR(30) NULL,
    `last_name` VARCHAR(30) NULL,
    `username` VARCHAR(250) NULL,
    `full_name` VARCHAR(250) NULL,
    `is_bot` TINYINT NOT NULL,
    `language_code` VARCHAR(60) NOT NULL,
    `is_primary` BOOLEAN NOT NULL DEFAULT true,
    `status` ENUM('SUBSCRIBED', 'UNSUBSCRIBED') NOT NULL DEFAULT 'SUBSCRIBED',
    `last_interacted_at` DATETIME(0) NULL,
    `last_auto_reply` TIMESTAMP(0) NULL,
    `input_activity_id` BIGINT UNSIGNED NULL,
    `input_expected_till` TIMESTAMP(0) NULL,
    `input_attempts` BIGINT UNSIGNED NOT NULL DEFAULT 0,
    `question_activity_id` BIGINT NULL,
    `question_activity_slug` VARCHAR(255) NULL,
    `question_expected_till` TIMESTAMP(0) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_telegram_chats_on_contact_id`(`contact_id`),
    INDEX `idx_telegram_chats_on_telegram_bot_id`(`telegram_bot_id`),
    INDEX `idx_telegram_chats_on_user_id`(`user_id`),
    INDEX `idx_telegram_chats_on_workspace_id`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `telegram_contacts` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `telegram_bot_id` BIGINT UNSIGNED NOT NULL,
    `telegram_chat_id` BIGINT UNSIGNED NOT NULL,
    `contact_id` BIGINT UNSIGNED NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_telegram_contacts_on_contact_id`(`contact_id`),
    INDEX `idx_telegram_contacts_on_telegram_bot_id`(`telegram_bot_id`),
    INDEX `idx_telegram_contacts_on_telegram_chat_id`(`telegram_chat_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `telegram_messages` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `telegram_chat_id` BIGINT UNSIGNED NOT NULL,
    `message_number` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NULL,
    `message_id` VARCHAR(255) NOT NULL,
    `parent_id` BIGINT UNSIGNED NULL,
    `reply_to` BIGINT UNSIGNED NULL,
    `type` VARCHAR(60) NOT NULL,
    `seen` BOOLEAN NOT NULL,
    `direction` ENUM('INCOMING', 'OUTGOING') NOT NULL DEFAULT 'INCOMING',
    `text` TEXT NULL,
    `media` TEXT NULL,
    `gallery_media_id` BIGINT UNSIGNED NULL,
    `status` ENUM('SENT', 'FAILED') NOT NULL DEFAULT 'SENT',
    `remind_at` TIMESTAMP(0) NULL,
    `communication_mode` ENUM('INBOX', 'AUTOMATION', 'BROADCAST') NOT NULL DEFAULT 'INBOX',
    `payload` TEXT NULL,
    `data` TEXT NOT NULL,
    `date` TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `created_at` TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `updated_at` TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `deleted_at` TIMESTAMP(0) NULL,
    `error_data` TEXT NULL,

    INDEX `idx_telegram_messages_chat_created`(`telegram_chat_id`, `created_at`),
    INDEX `idx_telegram_messages_on_message_id`(`message_id`),
    INDEX `idx_telegram_messages_on_message_number`(`message_number`),
    INDEX `idx_telegram_messages_on_parent_id`(`parent_id`),
    INDEX `idx_telegram_messages_on_telegram_chat_id`(`telegram_chat_id`),
    INDEX `idx_telegram_messages_on_user_id`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `telegram_statistics` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `bot_id` BIGINT UNSIGNED NULL,
    `bot_name` VARCHAR(255) NULL,
    `direction` ENUM('INCOMING', 'OUTGOING') NULL,
    `message_type` VARCHAR(255) NULL,
    `created_at` DATETIME(0) NOT NULL,

    INDEX `idx_telegram_statistics_on_bot_id`(`bot_id`),
    INDEX `idx_telegram_statistics_on_workspace_id`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `template_keys` (
    `id` INTEGER UNSIGNED NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(60) NOT NULL,
    `slug` VARCHAR(60) NOT NULL,
    `description` TEXT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `translations` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `locale` VARCHAR(6) NOT NULL,
    `namespace` VARCHAR(256) NOT NULL,
    `group` VARCHAR(150) NOT NULL,
    `item` VARCHAR(150) NOT NULL,
    `text` TEXT NOT NULL,
    `unstable` TINYINT NOT NULL DEFAULT 0,
    `locked` TINYINT NOT NULL DEFAULT 0,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `translations_group_index`(`group`),
    INDEX `translations_item_index`(`item`),
    INDEX `translations_locale_index`(`locale`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `twilio_account_users` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `twilio_account_id` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_twilio_account_users_on_twilio_account_id`(`twilio_account_id`),
    INDEX `idx_twilio_account_users_on_user_id`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `twilio_accounts` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(50) NOT NULL,
    `type` VARCHAR(255) NULL DEFAULT 'notification',
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `media_gallery_id` BIGINT UNSIGNED NOT NULL DEFAULT 0,
    `creator_id` BIGINT UNSIGNED NOT NULL,
    `twilio_account_sid` VARCHAR(100) NOT NULL,
    `twilio_auth_token` TEXT NULL,
    `status` ENUM('PENDING', 'VERIFIED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `deleted_at` TIMESTAMP(0) NULL,

    INDEX `idx_twilio_accounts_on_creator_id`(`creator_id`),
    INDEX `idx_twilio_accounts_on_status`(`status`),
    INDEX `idx_twilio_accounts_on_twilio_account_sid`(`twilio_account_sid`),
    INDEX `idx_twilio_accounts_on_workspace_id`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `twilio_call_logs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `twilio_account_id` BIGINT UNSIGNED NOT NULL,
    `call_sid` VARCHAR(255) NULL,
    `from_number` VARCHAR(20) NOT NULL,
    `twilio_number_id` BIGINT UNSIGNED NULL,
    `to_number` VARCHAR(20) NOT NULL,
    `second_number` VARCHAR(20) NULL,
    `call_duration` VARCHAR(20) NULL,
    `call_type` VARCHAR(20) NULL,
    `metadata` LONGTEXT NULL,
    `twilio_metadata` LONGTEXT NULL,
    `status` VARCHAR(255) NOT NULL DEFAULT 'success',
    `second_call_status` VARCHAR(255) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_twilio_call_logs_from_number`(`from_number`),
    INDEX `idx_twilio_call_logs_status`(`status`),
    INDEX `idx_twilio_call_logs_to_number`(`to_number`),
    INDEX `idx_twilio_call_logs_twilio_account_id`(`twilio_account_id`),
    INDEX `idx_twilio_call_logs_twilio_number_id`(`twilio_number_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `twilio_chats` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `contact_id` BIGINT UNSIGNED NOT NULL,
    `twilio_account_id` BIGINT UNSIGNED NOT NULL,
    `twilio_number_id` BIGINT UNSIGNED NULL,
    `from_number` VARCHAR(20) NOT NULL,
    `to_number` VARCHAR(20) NOT NULL,
    `last_message` TEXT NULL,
    `last_message_at` TIMESTAMP(0) NULL,
    `last_message_sent_status` ENUM('PENDING', 'SENT', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `unread_count` INTEGER NOT NULL DEFAULT 0,
    `input_activity_id` BIGINT UNSIGNED NULL,
    `input_expected_till` TIMESTAMP(0) NULL,
    `input_attempts` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_twilio_chats_on_contact_id`(`contact_id`),
    INDEX `idx_twilio_chats_on_from_number`(`from_number`),
    INDEX `idx_twilio_chats_on_twilio_account_id`(`twilio_account_id`),
    INDEX `idx_twilio_chats_on_twilio_number_id`(`twilio_number_id`),
    INDEX `idx_twilio_chats_on_user_id`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `twilio_messages` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `twilio_chat_id` BIGINT UNSIGNED NOT NULL,
    `parent_id` BIGINT UNSIGNED NULL,
    `user_id` BIGINT UNSIGNED NULL,
    `text` LONGTEXT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    `url` TEXT NULL,
    `send_by` ENUM('from', 'to') NOT NULL DEFAULT 'from',
    `direction` ENUM('OUTGOING', 'INCOMING') NOT NULL DEFAULT 'INCOMING',
    `gallery_media_id` BIGINT UNSIGNED NULL,
    `sender_id` BIGINT UNSIGNED NULL,
    `data` LONGTEXT NULL,
    `type` ENUM('text', 'image', 'input', 'note') NOT NULL,
    `reply_to` BIGINT UNSIGNED NULL,
    `communication_mode` ENUM('INBOX', 'AUTOMATION', 'BROADCAST') NOT NULL DEFAULT 'INBOX',
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_twilio_messages_chat_created`(`twilio_chat_id`, `created_at`),
    INDEX `idx_twilio_messages_on_parent_id`(`parent_id`),
    INDEX `idx_twilio_messages_on_sender_id`(`sender_id`),
    INDEX `idx_twilio_messages_on_twilio_chat_id`(`twilio_chat_id`),
    INDEX `idx_twilio_messages_on_user_id`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `twilio_numbers` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `twilio_account_id` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NULL,
    `type` VARCHAR(255) NULL,
    `twilio_phone_number` VARCHAR(20) NOT NULL,
    `country_id` BIGINT UNSIGNED NULL,
    `forward_type` ENUM('NONE', 'NUMBER', 'AGENT', 'TEAM') NOT NULL DEFAULT 'NONE',
    `forward_id` BIGINT UNSIGNED NULL,
    `forward_to` VARCHAR(20) NULL,
    `forward_to_country_id` BIGINT UNSIGNED NULL,
    `auto_reply_media_id` BIGINT UNSIGNED NULL,
    `status` ENUM('PENDING', 'VERIFIED', 'FAILED', 'DISCONNECTED') NOT NULL DEFAULT 'PENDING',
    `ai_ready` BOOLEAN NOT NULL DEFAULT false,
    `creator_id` BIGINT UNSIGNED NOT NULL,
    `updater_id` BIGINT UNSIGNED NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `deleted_at` TIMESTAMP(0) NULL,

    INDEX `idx_twilio_numbers_on_twilio_account_id`(`twilio_account_id`),
    INDEX `idx_twilio_numbers_on_twilio_phone_number`(`twilio_phone_number`),
    INDEX `idx_twilio_numbers_on_user_id`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `twilio_sip_credentials` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `username` VARCHAR(255) NOT NULL,
    `password` VARCHAR(255) NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `twilio_sms_statistics` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `twilio_account_id` BIGINT UNSIGNED NULL,
    `twilio_account_name` VARCHAR(255) NULL,
    `direction` ENUM('INCOMING', 'OUTGOING') NULL,
    `message_type` VARCHAR(255) NULL,
    `created_at` DATETIME(0) NOT NULL,

    INDEX `idx_twilio_sms_statistics_on_twilio_account_id`(`twilio_account_id`),
    INDEX `idx_twilio_sms_statistics_on_workspace_id`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `unstract_accounts` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `api_url` VARCHAR(255) NOT NULL,
    `api_key` VARCHAR(255) NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_accepted_terms` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `legal_document_id` BIGINT UNSIGNED NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_user_accepted_terms_on_user_id`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_accesses` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `accessable_type` VARCHAR(255) NOT NULL,
    `accessable_id` BIGINT UNSIGNED NOT NULL,

    INDEX `user_accesses_accessable_type_accessable_id_index`(`accessable_type`, `accessable_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_call_counters` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `counter_date` DATE NOT NULL,
    `outbound_counter` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `inbound_counter` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `counter` BIGINT UNSIGNED NOT NULL DEFAULT 0,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_user_call_counters_on_user_id`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_limits` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `enable_opportunities` TINYINT UNSIGNED NOT NULL DEFAULT 0,
    `opportunities_limit` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    `enable_conversation` TINYINT UNSIGNED NOT NULL DEFAULT 0,
    `conversation_limit` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    `enable_tasks` TINYINT UNSIGNED NOT NULL DEFAULT 0,
    `tasks_limit` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    `enable_call_limit` TINYINT UNSIGNED NOT NULL DEFAULT 0,
    `calls_limit` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_user_limits_on_user_id`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_login_policies` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `limit_by_ip` BOOLEAN NOT NULL DEFAULT false,
    `ip` VARCHAR(255) NULL,
    `monday_login` VARCHAR(255) NULL,
    `monday_logout` VARCHAR(255) NULL,
    `tuesday_login` VARCHAR(255) NULL,
    `tuesday_logout` VARCHAR(255) NULL,
    `wednesday_login` VARCHAR(255) NULL,
    `wednesday_logout` VARCHAR(255) NULL,
    `thursday_login` VARCHAR(255) NULL,
    `thursday_logout` VARCHAR(255) NULL,
    `friday_login` VARCHAR(255) NULL,
    `friday_logout` VARCHAR(255) NULL,
    `saturday_login` VARCHAR(255) NULL,
    `saturday_logout` VARCHAR(255) NULL,
    `sunday_login` VARCHAR(255) NULL,
    `sunday_logout` VARCHAR(255) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_states` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `type` VARCHAR(60) NOT NULL DEFAULT 'PROFILE',
    `data` LONGTEXT NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_user_states_on_type`(`type`),
    INDEX `idx_user_states_on_user_id`(`user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `users` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `first_name` VARCHAR(100) NULL,
    `last_name` VARCHAR(100) NULL,
    `full_name` VARCHAR(250) NULL,
    `email` VARCHAR(255) NOT NULL,
    `email_verification_code` VARCHAR(255) NULL,
    `email_verified_at` TIMESTAMP(0) NULL,
    `modelable_id` BIGINT UNSIGNED NOT NULL,
    `modelable_type` VARCHAR(50) NOT NULL,
    `is_owner` BOOLEAN NOT NULL DEFAULT false,
    `password` VARCHAR(255) NULL,
    `mobile_access` TINYINT NOT NULL DEFAULT 1,
    `timezone` VARCHAR(100) NOT NULL DEFAULT 'UTC',
    `locale` VARCHAR(10) NOT NULL DEFAULT 'en-US',
    `date_format` VARCHAR(15) NOT NULL DEFAULT 'YYYY-MM-DD',
    `time_format` VARCHAR(10) NOT NULL DEFAULT 'hh:mm a',
    `gallery_media_id` BIGINT UNSIGNED NULL,
    `last_login_at` DATETIME(0) NULL,
    `active_workspace_id` BIGINT UNSIGNED NULL,
    `status` ENUM('PENDING', 'ACTIVE', 'SUSPENDED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `availability` ENUM('AVAILABLE', 'OFFLINE') NOT NULL DEFAULT 'AVAILABLE',
    `last_seen_at` DATETIME(0) NULL,
    `api_token` TEXT NULL,
    `receive_sms_notification` BOOLEAN NOT NULL DEFAULT false,
    `receive_whatsapp_notification` BOOLEAN NOT NULL DEFAULT false,
    `tfa_code` TEXT NULL,
    `tfa_url` TEXT NULL,
    `tfa_enabled` BOOLEAN NOT NULL DEFAULT false,
    `tfa_required` BOOLEAN NOT NULL DEFAULT false,
    `public_api_token` VARCHAR(255) NULL,
    `agency_user_id` BIGINT UNSIGNED NULL,
    `remember_token` VARCHAR(100) NULL,
    `is_support_agent` BOOLEAN NOT NULL DEFAULT false,
    `creator_id` BIGINT UNSIGNED NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `notification_sound` VARCHAR(255) NOT NULL DEFAULT 'https://replyagent-staging.s3.amazonaws.com/assets/notification-sounds/notification.wav',

    INDEX `idx_users_on_email`(`email`),
    INDEX `idx_users_on_modelable_id`(`modelable_id`),
    INDEX `idx_users_on_modelable_type`(`modelable_type`),
    INDEX `users_email_index`(`email`),
    INDEX `users_modelable_id_index`(`modelable_id`),
    INDEX `users_modelable_type_index`(`modelable_type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `voice_wallet` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `agent_id` BIGINT UNSIGNED NULL,
    `description` ENUM('PURCHASE', 'SPENT') NOT NULL DEFAULT 'SPENT',
    `seconds` DECIMAL(10, 5) NOT NULL DEFAULT 0.00000,
    `balance` DECIMAL(10, 5) NOT NULL DEFAULT 0.00000,
    `transaction_type` ENUM('debit', 'credit') NOT NULL DEFAULT 'credit',
    `metadata` LONGTEXT NULL,
    `created_at` DATETIME(0) NOT NULL,

    INDEX `voice_wallet_agent_id_foreign`(`agent_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `voices` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `voice` VARCHAR(255) NOT NULL,
    `voice_id` VARCHAR(255) NOT NULL,
    `gender` ENUM('Male', 'Female') NOT NULL,
    `language_code` VARCHAR(255) NOT NULL,
    `locale_name` VARCHAR(255) NOT NULL,
    `local_name` VARCHAR(255) NOT NULL,
    `status` VARCHAR(255) NOT NULL,
    `voice_type` VARCHAR(255) NOT NULL DEFAULT 'standard',
    `words_per_minute` INTEGER UNSIGNED NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_voices_on_status`(`status`),
    INDEX `idx_voices_on_voice_id`(`voice_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `contact_opting` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `contact_id` BIGINT UNSIGNED NOT NULL,
    `channel` VARCHAR(40) NOT NULL,
    `opt_in` BOOLEAN NOT NULL DEFAULT true,
    `reason` VARCHAR(255) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_contact_opting_on_channel`(`channel`),
    UNIQUE INDEX `uk_contact_opting_contact_channel`(`contact_id`, `channel`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `make_hooks` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NULL,
    `name` VARCHAR(150) NOT NULL,
    `url` VARCHAR(500) NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `deleted_at` TIMESTAMP(0) NULL,

    INDEX `idx_make_hooks_on_workspace_id`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wa_accounts` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `waba_id` VARCHAR(255) NOT NULL,
    `wa_business_id` VARCHAR(100) NULL,
    `name` VARCHAR(255) NOT NULL,
    `currency` VARCHAR(60) NOT NULL,
    `timezone_id` VARCHAR(30) NOT NULL,
    `message_template_namespace` VARCHAR(255) NOT NULL,
    `account_review_status` VARCHAR(60) NULL,
    `business_verification_status` VARCHAR(60) NULL,
    `is_enabled_for_insights` SMALLINT NULL,
    `on_behalf_of_business_info` TEXT NULL,
    `ownership_type` VARCHAR(60) NULL,
    `error_code` VARCHAR(255) NULL,
    `access_token` TEXT NOT NULL,
    `status` VARCHAR(255) NOT NULL,
    `service_account_id` VARCHAR(255) NOT NULL,
    `auto_reply_automation_id` BIGINT UNSIGNED NULL,
    `deleted_at` TIMESTAMP(0) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `is_migrated` TINYINT NOT NULL DEFAULT 0,
    `onboard_platform` VARCHAR(255) NULL DEFAULT 'whatsapp_business',
    `meta_account_id` VARCHAR(64) NULL,

    INDEX `idx_wa_accounts_on_status`(`status`),
    INDEX `idx_wa_accounts_on_user_id`(`user_id`),
    INDEX `idx_wa_accounts_on_waba_id`(`waba_id`),
    INDEX `idx_wa_accounts_on_workspace_id`(`workspace_id`),
    INDEX `idx_wa_accounts_on_meta_account_id`(`meta_account_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wa_chats` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `wa_account_id` BIGINT UNSIGNED NOT NULL,
    `wa_number_id` BIGINT UNSIGNED NOT NULL,
    `user_id` BIGINT UNSIGNED NOT NULL,
    `contact_id` BIGINT UNSIGNED NOT NULL,
    `profile_name` VARCHAR(255) NULL,
    `wa_id` VARCHAR(255) NOT NULL,
    `is_primary` BOOLEAN NOT NULL DEFAULT true,
    `last_interacted_at` DATETIME(0) NULL,
    `last_auto_reply` TIMESTAMP(0) NULL,
    `last_business_interaction` TIMESTAMP(0) NULL,
    `last_client_interaction` TIMESTAMP(0) NULL,
    `profile_last_updated` TIMESTAMP(0) NULL,
    `ctwa_clid` TEXT NULL,
    `input_activity_id` BIGINT UNSIGNED NULL,
    `input_expected_till` TIMESTAMP(0) NULL,
    `input_attempts` BIGINT UNSIGNED NOT NULL DEFAULT 0,
    `question_activity_id` BIGINT NULL,
    `question_activity_slug` VARCHAR(255) NULL,
    `question_expected_till` TIMESTAMP(0) NULL,
    `dify_activity_id` BIGINT UNSIGNED NULL,
    `dify_expected_till` DATETIME(0) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_wa_chats_on_contact_id`(`contact_id`),
    INDEX `idx_wa_chats_on_user_id`(`user_id`),
    INDEX `idx_wa_chats_on_wa_account_id`(`wa_account_id`),
    INDEX `idx_wa_chats_on_wa_id`(`wa_id`),
    INDEX `idx_wa_chats_on_wa_number_id`(`wa_number_id`),
    UNIQUE INDEX `uk_wa_chats_account_number_waid`(`wa_account_id`, `wa_number_id`, `wa_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wa_logs` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `type` VARCHAR(255) NOT NULL,
    `modelable_type` VARCHAR(255) NOT NULL,
    `modelable_id` BIGINT UNSIGNED NOT NULL,
    `payload` TEXT NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `wa_logs_modelable_type_modelable_id_index`(`modelable_type`, `modelable_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wa_messages` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `wa_number_id` BIGINT UNSIGNED NOT NULL,
    `wa_chat_id` BIGINT UNSIGNED NOT NULL,
    `sender_id` BIGINT UNSIGNED NULL,
    `parent_id` BIGINT UNSIGNED NULL,
    `mobile_number` VARCHAR(255) NOT NULL,
    `type` VARCHAR(255) NOT NULL,
    `direction` ENUM('OUTGOING', 'INCOMING') NOT NULL DEFAULT 'INCOMING',
    `text` LONGTEXT NULL,
    `referral` TEXT NULL,
    `reply_to` BIGINT UNSIGNED NULL,
    `wa_template_id` BIGINT UNSIGNED NULL,
    `data` LONGTEXT NULL,
    `files` LONGTEXT NULL,
    `media` LONGTEXT NULL,
    `gallery_media_id` VARCHAR(255) NULL,
    `status` VARCHAR(255) NOT NULL DEFAULT 'sent',
    `remind_at` TIMESTAMP(0) NULL,
    `automation_queue_id` BIGINT UNSIGNED NULL,
    `communication_mode` ENUM('INBOX', 'AUTOMATION', 'BROADCAST') NOT NULL DEFAULT 'INBOX',
    `payload` TEXT NULL,
    `status_code` VARCHAR(255) NULL,
    `error_data` TEXT NULL,
    `wamid` VARCHAR(255) NULL,
    `timestamp` VARCHAR(255) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_wa_messages_chat_created`(`wa_chat_id`, `created_at`),
    INDEX `idx_wa_messages_on_parent_id`(`parent_id`),
    INDEX `idx_wa_messages_on_sender_id`(`sender_id`),
    INDEX `idx_wa_messages_on_wa_chat_id`(`wa_chat_id`),
    INDEX `idx_wa_messages_on_wa_number_id`(`wa_number_id`),
    INDEX `idx_wa_messages_on_wamid`(`wamid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wa_phone_numbers` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `wa_account_id` BIGINT UNSIGNED NOT NULL,
    `wa_number_id` VARCHAR(255) NOT NULL,
    `display_phone_number` VARCHAR(60) NOT NULL,
    `phone_number` VARCHAR(255) NOT NULL,
    `pin_code` VARCHAR(10) NOT NULL,
    `verified_name` VARCHAR(255) NOT NULL,
    `name_status` VARCHAR(60) NULL DEFAULT 'PENDING',
    `code_verification_status` VARCHAR(255) NOT NULL,
    `status` VARCHAR(255) NOT NULL,
    `error_code` VARCHAR(255) NULL,
    `quality_rating` VARCHAR(255) NOT NULL,
    `current_limit` VARCHAR(60) NULL,
    `auto_reply_automation_id` BIGINT NULL,
    `auto_reply_interval` VARCHAR(255) NOT NULL DEFAULT '247',
    `platform_type` VARCHAR(255) NOT NULL,
    `throughput` TEXT NULL,
    `last_onboarded_time` TIMESTAMP(0) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `allow_in_feeder` SMALLINT NULL DEFAULT 0,
    `smb_app_data` TINYINT NULL DEFAULT 1,

    INDEX `idx_wa_phone_numbers_on_status`(`status`),
    INDEX `idx_wa_phone_numbers_on_wa_account_id`(`wa_account_id`),
    INDEX `idx_wa_phone_numbers_on_wa_number_id`(`wa_number_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wa_statistics` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `wa_account_id` BIGINT UNSIGNED NULL,
    `phone_name` VARCHAR(255) NULL,
    `direction` ENUM('INCOMING', 'OUTGOING') NULL,
    `message_type` VARCHAR(255) NULL,
    `created_at` DATETIME(0) NOT NULL,

    INDEX `idx_wa_statistics_on_direction`(`direction`),
    INDEX `idx_wa_statistics_on_wa_account_id`(`wa_account_id`),
    INDEX `idx_wa_statistics_on_workspace_id`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wa_templates` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `wa_account_id` VARCHAR(255) NOT NULL,
    `template_id` VARCHAR(255) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `category` VARCHAR(60) NOT NULL,
    `type` VARCHAR(15) NULL DEFAULT 'template',
    `status` VARCHAR(30) NOT NULL,
    `reason` TEXT NULL,
    `language` VARCHAR(30) NOT NULL,
    `structure` TEXT NULL,
    `components` TEXT NULL,
    `template` TEXT NULL,
    `example` TEXT NULL,
    `error_code` TEXT NULL,
    `last_updated` DATETIME(0) NULL,
    `monthly_count` TINYINT NULL,
    `daily_count` TINYINT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `template_type` TEXT NULL,

    INDEX `idx_wa_templates_on_status`(`status`),
    INDEX `idx_wa_templates_on_template_id`(`template_id`),
    INDEX `idx_wa_templates_on_wa_account_id`(`wa_account_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wc_chats` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `wc_instance_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(255) NULL,
    `email` VARCHAR(255) NULL,
    `phone_number` VARCHAR(255) NULL,
    `whatsapp` VARCHAR(255) NULL,
    `assigned_to` VARCHAR(255) NULL,
    `reply_by` VARCHAR(255) NULL,
    `user_id` BIGINT UNSIGNED NULL,
    `contact_id` BIGINT UNSIGNED NULL,
    `is_primary` BOOLEAN NOT NULL DEFAULT true,
    `last_auto_reply` TIMESTAMP(0) NULL,
    `last_business_interaction` TIMESTAMP(0) NULL,
    `last_client_interaction` TIMESTAMP(0) NULL,
    `input_activity_id` BIGINT UNSIGNED NULL,
    `input_expected_till` TIMESTAMP(0) NULL,
    `input_attempts` BIGINT UNSIGNED NOT NULL DEFAULT 0,
    `question_activity_id` BIGINT UNSIGNED NULL,
    `question_activity_slug` VARCHAR(255) NULL,
    `question_expected_till` DATETIME(0) NULL,
    `profile_attempts` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `mongo_instance_id` VARCHAR(255) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wc_instances` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(255) NULL,
    `token` VARCHAR(255) NULL,
    `mongo_instance_id` VARCHAR(255) NULL,
    `due` DATETIME(0) NULL,
    `creator_id` BIGINT UNSIGNED NOT NULL,
    `publish` BOOLEAN NOT NULL DEFAULT false,
    `updater_id` BIGINT UNSIGNED NOT NULL,
    `gallery_id` BIGINT UNSIGNED NULL,
    `folder_name` VARCHAR(255) NULL,
    `upload_dir` VARCHAR(255) NULL,
    `thumb_dir` VARCHAR(255) NULL,
    `allow_in_feeder` BOOLEAN NOT NULL DEFAULT false,
    `auto_reply_automation_id` BIGINT UNSIGNED NULL,
    `auto_reply_interval` INTEGER NOT NULL DEFAULT 0,
    `status` TINYINT NOT NULL DEFAULT 1,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `deleted_at` TIMESTAMP(0) NULL,
    `bubbleType` VARCHAR(255) NULL DEFAULT 'expanded',
    `bubbleText` VARCHAR(255) NULL DEFAULT 'Chat with us',
    `bubbleIcon` TINYINT NOT NULL DEFAULT 1,
    `bubblePosition` VARCHAR(255) NOT NULL DEFAULT 'right',
    `bubbleColor` VARCHAR(255) NULL DEFAULT '#0aa32e',
    `color` VARCHAR(255) NULL DEFAULT '#ffffff',
    `widget_style` VARCHAR(255) NULL DEFAULT 'modern',
    `footer_text` VARCHAR(255) NULL DEFAULT 'Made with ReplyAgent.com',
    `welcome_message` VARCHAR(255) NULL DEFAULT 'Welcome',
    `welcome_tagline` VARCHAR(255) NULL DEFAULT 'We are here to help you',
    `welcome_launcher_title` VARCHAR(255) NULL DEFAULT 'We are online',
    `launcher_reply_time` VARCHAR(255) NULL DEFAULT 'Typically replies immediately',
    `launcher_link_text` VARCHAR(255) NULL DEFAULT 'Start Conversation',
    `prechat_option` VARCHAR(255) NULL DEFAULT 'default',
    `prechat_name` TINYINT NOT NULL DEFAULT 1,
    `prechat_name_label` VARCHAR(255) NULL DEFAULT 'Please enter name',
    `prechat_name_placeholder` VARCHAR(255) NULL DEFAULT 'Please enter name',
    `prechat_email` TINYINT NOT NULL DEFAULT 0,
    `prechat_email_label` VARCHAR(255) NULL DEFAULT 'Please enter email',
    `prechat_email_placeholder` VARCHAR(255) NULL DEFAULT 'Please enter email',
    `prechat_message` TEXT NULL,
    `prechat_whatsapp` TINYINT NOT NULL DEFAULT 0,
    `prechat_whatsapp_label` VARCHAR(255) NULL DEFAULT 'Please enter whatsapp',
    `prechat_whatsapp_placeholder` VARCHAR(255) NULL DEFAULT 'Please enter whatsapp',
    `prechat_phone` TINYINT NOT NULL DEFAULT 0,
    `prechat_phone_label` VARCHAR(255) NULL DEFAULT 'Please enter phone number',
    `prechat_phone_placeholder` VARCHAR(255) NULL DEFAULT 'Please enter phone number',
    `post_fields_message` TEXT NULL,
    `domain_one` VARCHAR(255) NULL DEFAULT '',
    `domain_two` VARCHAR(255) NULL DEFAULT '',
    `domain_three` VARCHAR(255) NULL DEFAULT '',
    `lanucher_avatar` VARCHAR(255) NULL DEFAULT '',
    `logo_avatar` VARCHAR(255) NULL DEFAULT '',
    `ask_question` VARCHAR(255) NULL DEFAULT 'Ask a question',

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wc_messages` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `wc_chat_id` BIGINT UNSIGNED NOT NULL,
    `direction` ENUM('OUTGOING', 'INCOMING') NOT NULL DEFAULT 'INCOMING',
    `type` VARCHAR(255) NOT NULL,
    `mongodb_message_id` VARCHAR(255) NULL,
    `media_name` VARCHAR(255) NULL,
    `media_type` VARCHAR(255) NULL,
    `media_size` VARCHAR(255) NULL,
    `media_path` VARCHAR(255) NULL,
    `thumbnail` VARCHAR(255) NULL,
    `thumb_size` VARCHAR(255) NULL,
    `duration` VARCHAR(255) NULL,
    `text` LONGTEXT NULL,
    `sender_id` BIGINT UNSIGNED NULL,
    `parent_id` BIGINT UNSIGNED NULL,
    `message_id` VARCHAR(255) NULL,
    `mobile_number` VARCHAR(255) NULL,
    `reply_to` BIGINT UNSIGNED NULL,
    `data` LONGTEXT NULL,
    `gallery_media_id` VARCHAR(255) NULL,
    `status` VARCHAR(255) NOT NULL DEFAULT 'pending',
    `communication_mode` ENUM('INBOX', 'AUTOMATION', 'BROADCAST') NOT NULL DEFAULT 'INBOX',
    `payload` TEXT NULL,
    `media` LONGTEXT NULL,
    `automation_queue_id` TEXT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_wc_messages_chat_created`(`wc_chat_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `wc_statistics` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `instance_id` BIGINT UNSIGNED NULL,
    `instance_name` VARCHAR(255) NULL,
    `direction` ENUM('INCOMING', 'OUTGOING') NULL,
    `message_type` VARCHAR(255) NULL,
    `created_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `webhooks` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `url` VARCHAR(2000) NOT NULL,
    `events` LONGTEXT NULL,
    `pending_retries` LONGTEXT NULL,
    `creator_id` BIGINT UNSIGNED NOT NULL,
    `updater_id` BIGINT UNSIGNED NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_webhooks_on_creator_id`(`creator_id`),
    INDEX `idx_webhooks_on_events`(`events`(768)),
    INDEX `idx_webhooks_on_workspace_id`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `widget_actions` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `widget_id` BIGINT UNSIGNED NOT NULL,
    `channel` VARCHAR(30) NOT NULL,
    `model_type` VARCHAR(30) NOT NULL,
    `model` TEXT NOT NULL,
    `modelable_id` BIGINT UNSIGNED NULL,
    `modelable_type` VARCHAR(255) NULL,
    `activity_slug` VARCHAR(255) NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_widget_actions_on_channel`(`channel`),
    INDEX `idx_widget_actions_on_widget_id`(`widget_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `widgets` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(255) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `subtitle` TEXT NULL,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `slug` VARCHAR(60) NOT NULL,
    `header_bg` VARCHAR(10) NOT NULL,
    `body_bg` VARCHAR(10) NOT NULL,
    `font_family` VARCHAR(20) NOT NULL,
    `position` VARCHAR(20) NOT NULL,
    `icon` TEXT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_widgets_on_slug`(`slug`),
    INDEX `idx_widgets_on_workspace_id`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `woovi_accounts` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `api_key` VARCHAR(255) NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `workspace_usage` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `billing_month` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `billing_year` INTEGER UNSIGNED NOT NULL,
    `start_date` DATETIME(0) NOT NULL,
    `end_date` DATETIME(0) NOT NULL,
    `agents` LONGTEXT NULL,
    `contacts` LONGTEXT NULL,
    `channels` LONGTEXT NULL,
    `domain` LONGTEXT NULL,
    `messages` LONGTEXT NULL,
    `voice_credits` LONGTEXT NULL,
    `currency` CHAR(3) NOT NULL DEFAULT 'USD',
    `total` DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
    `total_in_cents` BIGINT UNSIGNED NOT NULL DEFAULT 0,
    `media_id` BIGINT UNSIGNED NULL,
    `media_url` BIGINT UNSIGNED NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,

    INDEX `idx_workspace_usage_on_workspace_id`(`workspace_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `workspaces` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(100) NOT NULL,
    `slug` VARCHAR(150) NOT NULL,
    `agency_id` BIGINT UNSIGNED NOT NULL,
    `contacts_counter` INTEGER UNSIGNED NOT NULL,
    `timezone` VARCHAR(255) NULL,
    `first_day_week` ENUM('MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY') NOT NULL DEFAULT 'MONDAY',
    `creator_id` BIGINT UNSIGNED NULL,
    `agency_agent_id` BIGINT UNSIGNED NULL,
    `allow_branding` BOOLEAN NOT NULL DEFAULT false,
    `allow_agents` BOOLEAN NOT NULL DEFAULT false,
    `allow_support` BOOLEAN NOT NULL DEFAULT false,
    `buy_cal_accounts` BOOLEAN NOT NULL DEFAULT false,
    `agents_limit` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    `chatgpt_assistant_limit` INTEGER UNSIGNED NOT NULL DEFAULT 10,
    `limited_contacts` BOOLEAN NOT NULL DEFAULT false,
    `maximum_contacts` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `maximum_contacts_notified` BOOLEAN NOT NULL DEFAULT false,
    `whatsapp_channels_limit` INTEGER UNSIGNED NOT NULL DEFAULT 1,
    `instagram_channels_limit` INTEGER UNSIGNED NOT NULL DEFAULT 1,
    `facebook_channels_limit` INTEGER UNSIGNED NOT NULL DEFAULT 1,
    `telegram_channels_limit` INTEGER UNSIGNED NOT NULL DEFAULT 1,
    `twilio_channels_limit` INTEGER UNSIGNED NOT NULL DEFAULT 1,
    `evolution_channels_limit` INTEGER UNSIGNED NOT NULL DEFAULT 1,
    `zapi_channels_limit` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `webchat_channels_limit` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    `status` ENUM('ACTIVE', 'SUSPENDED', 'CLOSED') NOT NULL DEFAULT 'ACTIVE',
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `deleted_at` TIMESTAMP(0) NULL,
    `is_data_imported` BOOLEAN NOT NULL DEFAULT false,

    UNIQUE INDEX `workspaces_slug_unique`(`slug`),
    INDEX `idx_workspaces_on_agency_id`(`agency_id`),
    INDEX `idx_workspaces_on_creator_id`(`creator_id`),
    INDEX `idx_workspaces_on_status`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `zapi_chats` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `zapi_instance_id` BIGINT UNSIGNED NOT NULL,
    `chatLid` VARCHAR(255) NULL,
    `user_id` BIGINT UNSIGNED NULL,
    `contact_id` BIGINT UNSIGNED NOT NULL,
    `mobile_number` VARCHAR(255) NOT NULL,
    `profile_name` VARCHAR(255) NULL,
    `is_primary` BOOLEAN NOT NULL DEFAULT true,
    `last_auto_reply` TIMESTAMP(0) NULL,
    `last_business_interaction` TIMESTAMP(0) NULL,
    `last_client_interaction` TIMESTAMP(0) NULL,
    `input_activity_id` BIGINT UNSIGNED NULL,
    `input_expected_till` TIMESTAMP(0) NULL,
    `input_attempts` BIGINT UNSIGNED NOT NULL DEFAULT 0,
    `question_activity_id` BIGINT UNSIGNED NULL,
    `question_activity_slug` VARCHAR(255) NULL,
    `question_expected_till` DATETIME(0) NULL,
    `created_through` VARCHAR(255) NOT NULL DEFAULT '0',
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `support_number` VARCHAR(255) NULL,

    UNIQUE INDEX `zapi_chats_chatlid_unique`(`chatLid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `zapi_events` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `instanceId` VARCHAR(255) NOT NULL,
    `messageId` VARCHAR(255) NOT NULL,
    `event_data` TEXT NOT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `status` VARCHAR(255) NOT NULL DEFAULT 'PENDING',

    UNIQUE INDEX `zapi_events_messageid_unique`(`messageId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `zapi_instances` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `code` VARCHAR(30) NULL,
    `token` VARCHAR(255) NULL,
    `instance_id` VARCHAR(255) NULL,
    `due` TIMESTAMP(0) NULL,
    `phone_number` VARCHAR(255) NULL,
    `profile_name` VARCHAR(255) NULL,
    `profile_picture` VARCHAR(1000) NULL,
    `status` ENUM('PENDING', 'CONNECTED', 'DISCONNECTED', 'FAILED', 'DELETING', 'DELETED') NOT NULL DEFAULT 'PENDING',
    `fail_reason` VARCHAR(255) NULL,
    `creator_id` BIGINT UNSIGNED NOT NULL,
    `allow_in_feeder` BOOLEAN NOT NULL DEFAULT false,
    `auto_reply_automation_id` BIGINT UNSIGNED NULL,
    `auto_reply_interval` VARCHAR(255) NOT NULL DEFAULT '247',
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `deleted_at` TIMESTAMP(0) NULL,

    UNIQUE INDEX `zapi_instances_code_unique`(`code`),
    INDEX `zapi_instances_code_index`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `zapi_messages` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `zapi_chat_id` BIGINT UNSIGNED NOT NULL,
    `sender_id` BIGINT UNSIGNED NULL,
    `parent_id` BIGINT UNSIGNED NULL,
    `message_id` VARCHAR(255) NULL,
    `mobile_number` VARCHAR(255) NOT NULL,
    `type` VARCHAR(255) NOT NULL,
    `direction` ENUM('OUTGOING', 'INCOMING') NOT NULL DEFAULT 'INCOMING',
    `fromMe` TINYINT NOT NULL DEFAULT 0,
    `text` LONGTEXT NULL,
    `referral` TEXT NULL,
    `reply_to` BIGINT UNSIGNED NULL,
    `data` LONGTEXT NULL,
    `files` LONGTEXT NULL,
    `media` LONGTEXT NULL,
    `gallery_media_id` VARCHAR(255) NULL,
    `status` VARCHAR(255) NOT NULL DEFAULT 'pending',
    `remind_at` TIMESTAMP(0) NULL,
    `event_payload` TEXT NULL,
    `automation_queue_id` BIGINT UNSIGNED NULL,
    `communication_mode` ENUM('INBOX', 'AUTOMATION', 'BROADCAST') NOT NULL DEFAULT 'INBOX',
    `payload` TEXT NULL,
    `created_at` TIMESTAMP(0) NULL,
    `updated_at` TIMESTAMP(0) NULL,
    `error_data` TEXT NULL,

    INDEX `idx_zapi_messages_chat_created`(`zapi_chat_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `zapi_statistics` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `zapi_instance_id` BIGINT UNSIGNED NULL,
    `instance_name` VARCHAR(255) NULL,
    `direction` ENUM('INCOMING', 'OUTGOING') NULL,
    `message_type` VARCHAR(255) NULL,
    `created_at` DATETIME(0) NOT NULL,

    INDEX `idx_zapi_stats_instance_direction_created`(`zapi_instance_id`, `direction`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ai_voice_agents` ADD CONSTRAINT `ai_voice_agents_twilio_number_id_foreign` FOREIGN KEY (`twilio_number_id`) REFERENCES `twilio_numbers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `bundle_downloads` ADD CONSTRAINT `bundle_downloads_bundle_id_foreign` FOREIGN KEY (`bundle_id`) REFERENCES `bundles`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `pipeline_opportunity_step_logs` ADD CONSTRAINT `pipeline_opportunity_step_logs_from_step_id_foreign` FOREIGN KEY (`from_step_id`) REFERENCES `pipeline_steps`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `pipeline_opportunity_step_logs` ADD CONSTRAINT `pipeline_opportunity_step_logs_opportunity_id_foreign` FOREIGN KEY (`opportunity_id`) REFERENCES `pipeline_opportunities`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `pipeline_opportunity_step_logs` ADD CONSTRAINT `pipeline_opportunity_step_logs_pl_id_foreign` FOREIGN KEY (`pl_id`) REFERENCES `pipelines`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `pipeline_opportunity_step_logs` ADD CONSTRAINT `pipeline_opportunity_step_logs_to_step_id_foreign` FOREIGN KEY (`to_step_id`) REFERENCES `pipeline_steps`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `pipeline_opportunity_step_logs` ADD CONSTRAINT `pipeline_opportunity_step_logs_user_id_foreign` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `pipeline_steps` ADD CONSTRAINT `pipeline_steps_pl_id_fkey` FOREIGN KEY (`pl_id`) REFERENCES `pipelines`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `team_members` ADD CONSTRAINT `team_members_team_id_foreign` FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `team_members` ADD CONSTRAINT `team_members_user_id_foreign` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE `voice_wallet` ADD CONSTRAINT `voice_wallet_agent_id_foreign` FOREIGN KEY (`agent_id`) REFERENCES `ai_voice_agents`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

