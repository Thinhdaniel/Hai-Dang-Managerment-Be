import { CronJob } from 'cron';
import mongoose from 'mongoose';
import { USER_ROLE } from '@/constant/allowedRoles';
import { MATERIAL_CUSTODY_CAMPAIGN_STATUS } from '@/constant/materialCustody';
import MaterialCustodyAssignment from '@/models/MaterialCustodyAssignment';
import MaterialUsageCampaign from '@/models/MaterialUsageCampaign';
import Notification from '@/models/Notification';
import User from '@/models/User';
import { notifyUserUpserted } from '@/services/notification.helper';
import {
    buildMaterialCustodyReminderCopy,
    getMaterialCustodyReminderDateKey,
} from '@/services/material-custody-reminder.helpers';

const EPSILON = 0.000001;
const TIME_ZONE = 'Asia/Ho_Chi_Minh';
const UPCOMING_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;
let scheduleStarted = false;
let evaluationRunning = false;

const outstandingExpression = {
    $max: [
        0,
        {
            $subtract: [
                { $ifNull: ['$quantityIssued', 0] },
                {
                    $add: [
                        { $ifNull: ['$quantityReturnedUsable', 0] },
                        { $ifNull: ['$quantityReturnedRepair', 0] },
                        { $ifNull: ['$quantityReturnedDamaged', 0] },
                        { $ifNull: ['$quantityLost', 0] },
                        { $ifNull: ['$quantityTransferred', 0] },
                    ],
                },
            ],
        },
    ],
};

const getRecipients = async (plantId: mongoose.Types.ObjectId | string) => {
    const rows = await User.find({
        isDeleted: { $ne: true },
        isActive: true,
        status: { $ne: false },
        $or: [{ role: { $in: [USER_ROLE.ADMIN, USER_ROLE.DIRECTOR] } }, { role: USER_ROLE.MANAGER, plantId }],
    }).select('_id');
    return rows.map((row) => String(row._id));
};

export const evaluateMaterialCustodyReminders = async (
    trigger: 'schedule' | 'startup' | 'internal' = 'schedule',
    now = new Date()
) => {
    if (evaluationRunning) return { skipped: true, reason: 'already_running', trigger, campaigns: 0, notifications: 0 };
    evaluationRunning = true;
    try {
        const campaigns: any[] = await MaterialUsageCampaign.find({
            status: MATERIAL_CUSTODY_CAMPAIGN_STATUS.RECALLING,
            dueAt: { $ne: null, $lte: new Date(now.getTime() + UPCOMING_WINDOW_MS) },
            isDeleted: { $ne: true },
        }).lean();
        if (!campaigns.length) return { skipped: false, trigger, campaigns: 0, notifications: 0 };

        const campaignIds = campaigns.map((campaign) => campaign._id);
        const stats = await MaterialCustodyAssignment.aggregate([
            { $match: { campaignId: { $in: campaignIds }, isDeleted: { $ne: true } } },
            { $addFields: { outstanding: outstandingExpression } },
            { $match: { outstanding: { $gt: EPSILON } } },
            {
                $group: {
                    _id: '$campaignId',
                    outstandingQuantity: { $sum: '$outstanding' },
                    holders: { $addToSet: { $ifNull: ['$recipientId', '$holderName'] } },
                },
            },
            { $project: { outstandingQuantity: 1, holderCount: { $size: '$holders' } } },
        ]);
        const statsByCampaign = new Map(stats.map((row: any) => [String(row._id), row]));
        const dateKey = getMaterialCustodyReminderDateKey(now);
        let notifications = 0;
        let relevantCampaigns = 0;

        for (const campaign of campaigns) {
            const campaignStats = statsByCampaign.get(String(campaign._id));
            if (!campaignStats || Number(campaignStats.outstandingQuantity || 0) <= EPSILON) continue;
            relevantCampaigns += 1;
            const recipients = await getRecipients(campaign.plantId);
            const copy = buildMaterialCustodyReminderCopy({
                campaignCode: campaign.campaignCode,
                itemCode: campaign.itemCode,
                dueAt: new Date(campaign.dueAt),
                outstandingQuantity: Number(campaignStats.outstandingQuantity || 0),
                holderCount: Number(campaignStats.holderCount || 0),
                now,
            });
            for (const userId of recipients) {
                const dedupeKey = `material-custody-recall:${campaign._id}:${dateKey}`;
                const alreadySent = await Notification.exists({
                    userId: new mongoose.Types.ObjectId(userId),
                    dedupeKey,
                });
                if (alreadySent) continue;
                await notifyUserUpserted(
                    userId,
                    {
                        ...copy,
                        actionType: 'material_custody',
                        actionId: String(campaign._id),
                        actionData: { campaignId: String(campaign._id), plantId: String(campaign.plantId) },
                    },
                    {
                        dedupeKey,
                        deliveryTag: `material-custody-recall:${campaign._id}`,
                        webPush: { ttlSeconds: 12 * 60 * 60, urgency: 'high' },
                        telegramMode: 'fallback',
                    }
                );
                notifications += 1;
            }
        }
        return { skipped: false, trigger, campaigns: relevantCampaigns, notifications };
    } finally {
        evaluationRunning = false;
    }
};

export const startMaterialCustodyReminderSchedule = () => {
    if (scheduleStarted) return;
    scheduleStarted = true;
    const job = new CronJob(
        '0 15 7 * * *',
        () => {
            void evaluateMaterialCustodyReminders('schedule').catch((error) =>
                console.error('[MaterialCustodyReminder] Scheduled evaluation failed:', error)
            );
        },
        null,
        false,
        TIME_ZONE
    );
    job.start();
    void evaluateMaterialCustodyReminders('startup').catch((error) =>
        console.error('[MaterialCustodyReminder] Startup evaluation failed:', error)
    );
};
