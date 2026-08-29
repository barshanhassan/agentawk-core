-- AlterTable
ALTER TABLE `invoices` ADD COLUMN `coupon_codes` VARCHAR(255) NULL,
    ADD COLUMN `discount` DECIMAL(12, 2) NULL,
    ADD COLUMN `subtotal` DECIMAL(12, 2) NULL;

-- CreateTable
CREATE TABLE `csat_responses` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `workspace_id` BIGINT UNSIGNED NOT NULL,
    `inbox_id` BIGINT UNSIGNED NOT NULL,
    `contact_id` BIGINT UNSIGNED NOT NULL,
    `agent_id` BIGINT UNSIGNED NULL,
    `rating` TINYINT NULL,
    `requested_at` DATETIME(0) NOT NULL DEFAULT CURRENT_TIMESTAMP(0),
    `responded_at` DATETIME(0) NULL,

    INDEX `idx_csat_responses_on_workspace_id`(`workspace_id`),
    INDEX `idx_csat_responses_on_inbox_id`(`inbox_id`),
    INDEX `idx_csat_responses_on_contact_id`(`contact_id`),
    INDEX `idx_csat_responses_on_agent_id`(`agent_id`),
    INDEX `idx_csat_responses_workspace_rating`(`workspace_id`, `rating`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

