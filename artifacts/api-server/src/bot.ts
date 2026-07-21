
/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║                         Dragon Shop Bot                             ║
 * ║                                                                      ║
 * ║  بوت متجر الرومات — Discord.js v14                                   ║
 * ║                                                                      ║
 * ║  المميزات:                                                            ║
 * ║  • بانل متجر كامل بفئات (المتاجر / الطلبيات / المزاد / الرتب / الإضافات) ║
 * ║  • نظام تذاكر شراء تلقائي مع تحقق ProBot                            ║
 * ║  • نظام رصيد منشنات (@everyone / @here / @offers)                   ║
 * ║  • AutoMod: حجب الكلام الممنوع + التحكم في المنشنات                 ║
 * ║  • نظام تحذيرات وحظر تلقائي (3 تحذيرات = حظر 4 أيام)               ║
 * ║  • أسعار إضافات (21 إضافة) مخزنة في DB وقابلة للتعديل              ║
 * ║  • تحويل ملكية الرومات مع رسوم 50%                                  ║
 * ║                                                                      ║
 * ║  Dev By: mostafa9321 & ahmed_.p                                      ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

import { findBadWord } from "./badwords.js";
import { joinVoiceChannel, VoiceConnectionStatus, entersState } from "@discordjs/voice";

import {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
  AttachmentBuilder,
  Events,
  AutoModerationRuleEventType,
  AutoModerationRuleTriggerType,
  AutoModerationActionType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  WebhookClient,
  type TextChannel,
  type Message,
  type Interaction,
  type Guild,
  REST,
  Routes,
  SlashCommandBuilder,
  MessageFlags,
} from "discord.js";
import {
  db,
  roomsTable,
  purchasesTable,
  botUsersTable,
  warningsTable,
  addonPricesTable,
  auctionSchedulesTable,
  promoCodesTable,
  promoRedemptionsTable,
  userPointsTable,
  productRequestsTable,
} from "@workspace/db";
import { eq, and, ne, lt, isNull, sql, inArray } from "drizzle-orm";
import { logger } from "./lib/logger";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

// ══════════════════════════════════════════════════════════════════════════════
//  ENV — متغيرات البيئة
//  NOTE: كل المتغيرات دي لازم تكون موجودة في Replit Secrets.
//        لو أي واحد منهم مش موجود، البوت مش هيشتغل صح.
// ══════════════════════════════════════════════════════════════════════════════
const TOKEN    = process.env.DISCORD_TOKEN ?? "";
const OWNER_ID = process.env.OWNER_ID ?? "";
const GUILD_ID = process.env.GUILD_ID ?? "";
const AFK_VOICE_CHANNEL_ID = "1492986948409888869";

// تحقق من وجود المتغيرات المطلوبة قبل تشغيل البوت
if (!TOKEN)    throw new Error("DISCORD_TOKEN is required but not set");
if (!OWNER_ID) throw new Error("OWNER_ID is required but not set");
if (!GUILD_ID) throw new Error("GUILD_ID is required but not set");

// ══════════════════════════════════════════════════════════════════════════════
//  ProBot — إعدادات التحويل
//  NOTE: PROBOT_USER_ID ده الـ ID الرسمي لبوت ProBot.
//        البوت بيرفض أي رسالة من بوت تاني حتى لو جاي من نفس الشانل،
//        ده بيمنع أي حد يعمل spoofing على رسائل الدفع.
// ══════════════════════════════════════════════════════════════════════════════
const PROBOT_USER_ID = "282859044593598464";

/** نسبة عمولة ProBot (5%) — بتتخصم من المبلغ عند التحويل */
const PROBOT_FEE = 0.05;

/**
 * يحسب المبلغ الكلي اللي المشتري يحوله عشان الأونر يستلم `netPrice` صافي.
 * المعادلة: gross = ceil(net / (1 - fee))
 * مثال: سعر صافي 1000 → المشتري يحول 1053
 */
function calcTransferAmount(netPrice: number): number {
  return Math.ceil(netPrice / (1 - PROBOT_FEE));
}

/** شانل إرسال أوامر التحويل للتفعيل (ID ثابت) */
const REACTIVATION_CHANNEL_ID = "1523817510435164291";

/** سعر إزالة التحذير من المتجر — net قبل عمولة ProBot */
const WARNING_REMOVAL_PRICE = 1_000_000;

// ══════════════════════════════════════════════════════════════════════════════
//  AutoMod — الكلمات المحظورة
//  NOTE: القائمة دي بتتبعت لـ Discord AutoMod عند بدء تشغيل البوت.
//        أي تعديل هنا هياخد أفكت بعد restart البوت.
//        Discord بيبلوك الرسالة تلقائياً قبل ما تظهر لأي حد.
// ══════════════════════════════════════════════════════════════════════════════
const BANNED_WORDS = [
  // عربي
  "سب", "شتيمة", "عنصري", "كس", "زب", "طيز", "منيك", "عرص",
  // إنجليزي
  "fuck", "shit", "bitch", "nigger", "faggot", "asshole",
];

/**
 * ID رول "mention-bypass" اللي البوت بيعمله تلقائياً.
 * الناس اللي عندهم رصيد منشنات > 0 بياخدوا الرول ده
 * وبالتالي بيعدوا على قاعدة AutoMod اللي بتبلوك @everyone و @here.
 * NOTE: بيتحط بعد ما AutoMod يتعمل في ClientReady.
 */
// NOTE: رول mention-bypass اتشال — المنشنات بتتفلتر يدوياً في الرومات

// ══════════════════════════════════════════════════════════════════════════════
//  الإضافات — Addons
// ══════════════════════════════════════════════════════════════════════════════

/**
 * إيموجي Peepo_Helicopter المتحرك — بيظهر على كل زرار إضافة.
 * NOTE: لو الإيموجي اتحذف من السيرفر، الأزرار هتظهر بدون إيموجي بس مش هتتعطل.
 *       عشان تغير الإيموجي: غير الـ id والـ name بس، animated ابقى حطها true لو animated.
 */
const PEEPO_EMOJI = {
  id:       "1524223468197908651",
  name:     "DVN_Money",
  animated: true,
};

/** إيموجي الشراء الموحّد — بيستخدم بدل 🛒 في كل حتة في قائمة الشراء المباشر (/buy) */
const BUY_EMOJI = {
  id:       "1524536738360328347",
  name:     "rfn",
  animated: true,
};

/**
 * قائمة الـ 21 إضافة — كل إضافة ليها:
 *   key:   مفتاح فريد بالإنجليزية (بيتخزن في DB وبيستخدم في customId للأزرار)
 *   label: النص العربي اللي بيظهر على الزرار
 *
 * ⚠️ RTL RENDERING NOTE — مهم جداً:
 *   Discord بيعرض الأزرار من اليمين لليسار (RTL) على كتير من الكليانتات.
 *   يعني: أول عنصر في الكود (index 0) يظهر على **يمين** الصف،
 *           وآخر عنصر (index 4 مثلاً) يظهر على **يسار** الصف.
 *
 *   عشان كده الترتيب في الكود معكوس تماماً عن الترتيب اللي عايزه على الشاشة:
 *   لو عايز الشاشة تبان هكذا:  [A] [B] [C] [D] [E]
 *   الكود لازم يكون بالترتيب:  [E] [D] [C] [B] [A]
 *   (أول عنصر في الـ array يظهر على اليمين في Discord)
 *
 *   الترتيب الحالي (شاشة من اليسار لليمين):
 *   Row 1 (4): منشن إيفري | منشن هير | منشن عروض | تفعيل المتجر
 *   Row 2 (4): إضافة شريك | إزالة شريك | تغيير مالك | تغيير نوع
 *   Row 3 (3): منشن إيفري طلبات | منشن هير طلبات | منشن طلبات
 *   Row 4 (3): منشن إيفري مزاد | منشن هير مزاد | منشن مزادات
 *   Row 5 (3): نشر تلقائي | خطوط تلقائيه | إزالة تحذير
 *
 *   ADDON_ROW_SIZES يحدد عدد الأزرار في كل صف.
 */
const ADDON_ROW_SIZES = [4, 4, 3, 3, 3] as const;

const ADDONS = [
  // ── Row 1 (شاشة L→R: منشن إيفري | منشن هير | منشن عروض | تفعيل المتجر) ──
  { key: "activate_store",            label: "سعر تفعيل المتجر" },        // يسار
  { key: "mention_shop",              label: "سعر منشن عروض" },
  { key: "mention_here",              label: "سعر منشن هير" },
  { key: "mention_everyone",          label: "سعر منشن إيفري" },          // يمين
  // ── Row 2 (شاشة L→R: إضافة شريك | إزالة شريك | تغيير مالك | تغيير نوع) ──
  { key: "change_store_type",         label: "سعر تغيير نوع المتجر" },    // يسار
  { key: "change_store_owner",        label: "سعر تغيير مالك المتجر" },
  { key: "remove_partner",            label: "سعر إزالة شريك" },
  { key: "add_partner",               label: "سعر إضافة شريك" },          // يمين
  // ── Row 3 (شاشة L→R: منشن إيفري طلبات | منشن هير طلبات | منشن طلبات) ───
  { key: "mention_requests",          label: "سعر منشن طلبات" },          // يسار
  { key: "mention_here_requests",     label: "سعر منشن هير طلبات" },
  { key: "mention_everyone_requests", label: "سعر منشن إيفري طلبات" },    // يمين
  // ── Row 4 (شاشة L→R: منشن طلبيات | منشن مزاد) ─────────────────────────
  // NOTE: دول رصيد دائم زي منشن @offers بالظبط (مش زي مودال منشن طلبات
  //       اللي فوق، اللي بيفتح تذكرة يدوية) — يستخدموا مودال الكمية زي
  //       mention_shop/mention_here/mention_everyone.
  { key: "mention_orders",            label: "سعر منشن طلبيات" },
  { key: "mention_auction",           label: "سعر منشن مزاد" },
  // ── Row 5 (شاشة L→R: نشر تلقائي | خطوط تلقائيه | إزالة تحذير) ─────────
  { key: "remove_store_warning",      label: "سعر إزالة تحذير" },         // يسار
  { key: "auto_lines",                label: "سعر خطوط تلقائيه" },
  { key: "auto_publish",              label: "سعر نشر تلقائي" },          // يمين
] as const;

/** نوع TypeScript المشتق تلقائياً من مفاتيح الإضافات — بيستخدم في /setaddonprice */
type AddonKey = (typeof ADDONS)[number]["key"];

// ══════════════════════════════════════════════════════════════════════════════
//  Discord Client
//  NOTE: الـ intents دي الصلاحيات اللي البوت محتاجها من Discord.
//        لو حذفت intent هيبطل جزء من الوظايف:
//        - GuildMembers: محتاجة عشان تعمل fetch للمعضاء وتديهم الرولات
//        - GuildModeration: محتاجة لـ AutoMod
//        - MessageContent: محتاجة عشان تقرأ محتوى الرسائل (Privileged Intent)
// ══════════════════════════════════════════════════════════════════════════════
export const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,   // Privileged — لازم تفعّله في Developer Portal
    GatewayIntentBits.GuildMembers,     // Privileged — لازم تفعّله في Developer Portal
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel, Partials.Message], // عشان يشتغل مع DMs
});

client.on("error", (err) => {
  logger.error({ err }, "Discord client error");
});

// ══════════════════════════════════════════════════════════════════════════════
//  AFK Voice — يخلي البوت واقف في روم صوتي معين طول ما هو شغال
// ══════════════════════════════════════════════════════════════════════════════
function joinAfkVoiceChannel(guild: import("discord.js").Guild) {
  try {
    const connection = joinVoiceChannel({
      channelId: AFK_VOICE_CHANNEL_ID,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: true,
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        // بيحاول يعمل reconnect لوحده
      } catch {
        logger.warn("AFK voice connection dropped — rejoining");
        connection.destroy();
        joinAfkVoiceChannel(guild);
      }
    });

    connection.on("error" as any, (err: unknown) => {
      logger.error({ err }, "AFK voice connection error");
    });

    logger.info({ channelId: AFK_VOICE_CHANNEL_ID }, "Joined AFK voice channel");
  } catch (err) {
    logger.error({ err }, "Failed to join AFK voice channel");
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  Pending Mention Purchases — تتبع عمليات شراء المنشنات المعلقة (In-Memory)
//
//  كل يوزر يضغط "شراء منشن" ويكمل المودال بيتسجل هنا بـ timeout دقيقتين.
//  لو مدفعش خلال الدقيقتين → البوت يمسح العملية ويبعتله DM.
//  لو مدفعش ومحاول يشتري تاني → البوت يبلوكه لحد ما العملية تخلص.
//  لو ProBot بعت رسالة تحويل تتطابق → البوت يكملها ويكنسل الـ timeout.
//
//  NOTE: الـ Map بتتمسح لو البوت restart — لكن ده معقول لأن الـ window دقيقتين بس.
// ══════════════════════════════════════════════════════════════════════════════

type MentionKey = "here" | "everyone" | "shop" | "orders" | "auction";

interface PendingMentionPurchase {
  userId:      string;
  username:    string;
  mentionKey:  MentionKey;
  label:       string;
  qty:         number;
  netPrice:    number;
  transferAmt: number;
  guildId:     string;
  channelId:   string;
  expiresAt:   number;
  timeoutId:   ReturnType<typeof setTimeout>;
}

const pendingMentionPurchases = new Map<string, PendingMentionPurchase>();

/**
 * يكنسل عملية شراء منشن معلقة ويمسحها من الـ Map.
 * @param userId  Discord user ID
 * @param notify  لو true يبعت embed في الشانل إن العملية انتهت
 */
async function cancelPendingMentionPurchase(userId: string, notify: boolean): Promise<void> {
  const pending = pendingMentionPurchases.get(userId);
  if (!pending) return;
  clearTimeout(pending.timeoutId);
  pendingMentionPurchases.delete(userId);
  if (!notify) return;
  try {
    const ch = await client.channels.fetch(pending.channelId).catch(() => null);
    if (!ch || !ch.isTextBased() || !("send" in ch)) return;
    const textCh      = ch as import("discord.js").TextChannel;
    const guild       = textCh.guild;
    const guildIconURL = guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;
    const DIV_X       = "ـﮩ════════════════ﮩـ";
    const timeoutFiles: import("discord.js").AttachmentBuilder[] = [];

    const timeoutEmbed = new EmbedBuilder()
      .setAuthor({ name: "Dragon $hop", iconURL: guildIconURL })
      .setTitle(`⏰ انتهت مهلة شراء المنشن`)
      .setDescription(`<@${userId}> ${MONEY_EMOJI}\n> ${DIV_X}`)
      .setColor(0xff4444)
      .addFields(
        {
          name:  `${STAR_EMOJI} العملية`,
          value: `> ${MONEY_EMOJI} **${pending.label} × ${pending.qty}** منشن\n> ${DIV_X}`,
          inline: false,
        },
        {
          name:  `${STAR_EMOJI} السبب`,
          value: `> مفيش تحويل اتعمل خلال دقيقتين\n> لو عايز تشتري تاني، ابدأ عملية الشراء من الأول 🔄\n> ${DIV_X}`,
          inline: false,
        },
      )
      .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: guildIconURL });

    if (fs.existsSync(DRAGON_BANNER_PATH)) {
      timeoutFiles.push(new AttachmentBuilder(DRAGON_BANNER_PATH, { name: "dragon_banner.webp" }));
      timeoutEmbed.setImage("attachment://dragon_banner.webp");
    }

    await ch.send({ content: `<@${userId}>`, embeds: [timeoutEmbed], files: timeoutFiles });
  } catch {
    // الشانل اتحذف أو البوت مالوش access — تجاهل
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  Store Rename — تغيير اسم المتجر (In-Memory)
//
//  نفس نمط الـ pendingMentionPurchases بس لعملية تغيير اسم المتجر.
//  الـ flow:
//    1. المستخدم يضغط "شراء تغيير الاسم" → يظهر له أمر التحويل + timeout دقيقتين
//    2. ProBot يأكد التحويل → البوت يبعت زرار "اكتب الاسم الجديد"
//    3. المستخدم يضغط الزرار → مودال يفتح
//    4. يكتب الاسم → البوت يغير اسم الشانل ويأكد
//
//  pendingStoreRenameReady: بعد تأكيد ProBot — ينتظر المستخدم يضغط الزرار
// ══════════════════════════════════════════════════════════════════════════════

/** سعر تغيير اسم المتجر بالكريدت */
const STORE_RENAME_PRICE = 1_000_000;

/**
 * يحوّل المسافات العادية (ASCII 0x20) لـ NO-BREAK SPACE (U+00A0)
 * عشان Discord ما يحوّلهاش لـ `-` في اسم الشانل.
 */
function formatChannelName(name: string): string {
  return name.replace(/ /g, "\u00A0");
}

interface PendingStoreRename {
  userId:        string;
  username:      string;
  purchaseId:    number;
  roomChannelId: string;
  currentName:   string;
  transferAmt:   number;
  netPrice:      number;
  guildId:       string;
  channelId:     string;
  expiresAt:     number;
  timeoutId:     ReturnType<typeof setTimeout>;
}

const pendingStoreRenames     = new Map<string, PendingStoreRename>();
const pendingStoreRenameReady = new Map<string, { purchaseId: number; roomChannelId: string }>();

// ══════════════════════════════════════════════════════════════════════════════
//  Warning Removal & Room Reactivation — In-Memory Pending Maps
// ══════════════════════════════════════════════════════════════════════════════

interface PendingWarningRemoval {
  userId:        string;
  username:      string;
  purchaseId:    number;
  roomChannelId: string;
  netPrice:      number;
  transferAmt:   number;
  guildId:       string;
  expiresAt:     number;
  timeoutId:     ReturnType<typeof setTimeout>;
}

interface PendingRoomReactivation {
  userId:        string;
  username:      string;
  purchaseId:    number;
  roomChannelId: string;
  netPrice:      number;
  transferAmt:   number;
  guildId:       string;
  expiresAt:     number;
  timeoutId:     ReturnType<typeof setTimeout>;
}

const pendingWarningRemovals   = new Map<string, PendingWarningRemoval>();
const pendingRoomReactivations = new Map<string, PendingRoomReactivation>();

// ══════════════════════════════════════════════════════════════════════════════
//  Partner — Add / Remove — In-Memory Pending Maps
// ══════════════════════════════════════════════════════════════════════════════

interface PendingAddPartner {
  userId:        string;
  username:      string;
  purchaseId:    number;
  roomChannelId: string;
  netPrice:      number;
  transferAmt:   number;
  guildId:       string;
  expiresAt:     number;
  timeoutId:     ReturnType<typeof setTimeout>;
}

interface PendingRemovePartner {
  userId:        string;
  username:      string;
  purchaseId:    number;
  roomChannelId: string;
  partnerId:     string;
  netPrice:      number;
  transferAmt:   number;
  guildId:       string;
  expiresAt:     number;
  timeoutId:     ReturnType<typeof setTimeout>;
}

const pendingAddPartners    = new Map<string, PendingAddPartner>();
const pendingRemovePartners = new Map<string, PendingRemovePartner>();

// ══════════════════════════════════════════════════════════════════════════════
//  Auto Publish — النشر التلقائي في روم العميل
//
//  Flow:
//    1. المستخدم يضغط "سعر النشر التلقائي" → البوت يفتح تذكرة ويبعت select menu للمدة
//    2. يختار المدة (1-7 أيام) → البوت يحسب السعر ويبعت أمر التحويل
//    3. ProBot يأكد الدفع → البوت يسأل عن رصيد المنشنات
//    4. YES → مودال بفيلد نوع المنشن + العدد + الرسالة + صورة اختيارية
//       NO  → مودال بفيلد الرسالة + صورة اختيارية
//    5. البوت يبدأ النشر كل 6 ساعات في روم العميل طول المدة
// ══════════════════════════════════════════════════════════════════════════════

/** سعر النشر التلقائي بالكريدت في اليوم الواحد */
const AUTO_PUBLISH_PRICE_PER_DAY = 2_000_000;

/** فترة النشر — كل 6 ساعات */
const AUTO_PUBLISH_INTERVAL_MS = 6 * 60 * 60 * 1000;

interface PendingAutoPublish {
  userId:          string;
  username:        string;
  storePurchaseId: number;
  roomChannelId:   string;
  ticketChannelId: string;
  days:            number;
  netPrice:        number;
  transferAmt:     number;
  guildId:         string;
  expiresAt:       number;
  timeoutId:       ReturnType<typeof setTimeout>;
}

interface ActiveAutoPublish {
  userId:          string;
  roomChannelId:   string;
  message:         string;
  imageUrl?:       string;
  mentionType?:    "here" | "everyone" | "offers" | "orders" | "auction";
  mentionsPerPost: number;
  intervalId:      ReturnType<typeof setInterval>;
  endTimeoutId:    ReturnType<typeof setTimeout>;
  /** الـ webhook المخصص لهذا النشر — null لو فشل الإنشاء */
  webhookClient:   WebhookClient | null;
  webhookId:       string | null;
}

const pendingAutoPublishes = new Map<string, PendingAutoPublish>();
const activeAutoPublishes  = new Map<string, ActiveAutoPublish>();

/**
 * تفويض دفعة واحدة (single-use) بين لحظة تأكيد الدفع وضغط زرار المنشنات/فتح المودال.
 * بيتحذف أول ما يُستخدم عشان لا يُعاد استخدام نفس الزرار/المودال القديم بعد كده من غير دفع جديد.
 */
const pendingAutoPublishReady = new Map<string, { storePurchaseId: number; days: number; roomChannelId: string }>();

// ══════════════════════════════════════════════════════════════════════════════
//  Auto Lines — تلقائي للخطوط
//
//  Flow:
//    1. المستخدم يضغط زرار "سعر تلقائي للخطوط"
//       • معندوش متجر → نفس الرسالة (إمبيد السعر بس)
//       • عنده متجر   → إمبيد السعر + أمر تحويل في روم الأوامر
//    2. ProBot يأكد الدفع → البوت يطلب الصورة في روم المتجر
//    3. المستخدم يبعت الصورة → البوت يحفظها
//    4. بعد كل رسالة من الأونر أو الشريك في الروم → البوت يبعت الصورة
// ══════════════════════════════════════════════════════════════════════════════

/** سعر خدمة تلقائي للخطوط */
const AUTO_LINES_PRICE = 10_000_000;

/** مهلة انتظار الصورة بعد تأكيد الدفع */
const AUTO_LINES_IMAGE_TIMEOUT_MS = 10 * 60 * 1000; // 10 دقايق

interface PendingAutoLinePurchase {
  userId:        string;
  username:      string;
  purchaseId:    number;
  roomChannelId: string;
  netPrice:      number;
  transferAmt:   number;
  guildId:       string;
  expiresAt:     number;
  timeoutId:     ReturnType<typeof setTimeout>;
}

interface PendingAutoLineImage {
  userId:        string;
  purchaseId:    number;
  roomChannelId: string;
  timeoutId:     ReturnType<typeof setTimeout>;
}

interface ActiveAutoLines {
  ownerId:       string;
  roomChannelId: string;
  imageName:     string;
  /** الصورة محفوظة كـ Buffer في الذاكرة — مش رابط CDN (روابط Discord بتنتهي صلاحيتها) */
  imageBuffer:   Buffer;
}

const pendingAutoLinePurchases = new Map<string, PendingAutoLinePurchase>();
const pendingAutoLineImages    = new Map<string, PendingAutoLineImage>();
const activeAutoLines          = new Map<string, ActiveAutoLines>();

// ══════════════════════════════════════════════════════════════════════════════
//  Auction Mention Purchase — شراء منشن إعلان مزاد (In-Memory)
//
//  Flow:
//    1. اليوزر يضغط زرار الإضافة (mention_*_auction)
//    2. يضغط "شراء" → البوت يبعت embed في روم الأوامر فيه زر "أمر التحويل"
//    3. يضغط الزر → يشوف أمر التحويل
//    4. ProBot يأكد → البوت يبعت زر "اختار تفاصيل المزاد"
//    5. يضغط الزر → مودال: رقم الروم + الساعة + العكلة (سعر البيع)
//    6. يسبمت → البوت يسجّل في DB ويأكد
// ══════════════════════════════════════════════════════════════════════════════

interface PendingAucMentionPurchase {
  userId:          string;
  username:        string;
  mentionType:     AuctionType;
  netPrice:        number;
  transferAmt:     number;
  guildId:         string;
  ticketChannelId: string;
  dbRecordId:      number;   // ID الـ row في DB — للتنظيف عند الإلغاء أو الـ timeout
  expiresAt:       number;
  timeoutId:       ReturnType<typeof setTimeout>;
}

const pendingAucMentionPurchases = new Map<string, PendingAucMentionPurchase>();

// بعد تأكيد ProBot — ينتظر المستخدم يضغط زر "اختار تفاصيل المزاد"
// NOTE: single-use token — بيتمسح بعد ما المودال يتسبمت أو بعد 10 دقايق
const pendingAucMentionReady = new Map<string, { mentionType: AuctionType; guildId: string; ticketChannelId: string; timeoutId: ReturnType<typeof setTimeout> }>();

/**
 * يبدأ النشر التلقائي في روم العميل كل 6 ساعات طول المدة المدفوعة.
 * بينشئ webhook مخصص للنشر ويمسحه لما تخلص المدة.
 * لو المستخدم اختار منشنات، البوت بيخصمها من رصيده كل نشرة.
 */
async function startAutoPublish(
  guild: Guild,
  params: {
    userId:          string;
    username:        string;
    roomChannelId:   string;
    message:         string;
    imageUrl?:       string;
    mentionType?:    "here" | "everyone" | "offers" | "orders" | "auction";
    mentionsPerPost: number;
    durationMs:      number;
  },
): Promise<void> {
  // ── لو فيه جوب شغّال لنفس اليوزر (احتياطي) — قفله الأول عشان ما يفضلش interval/webhook متسرّب ──
  const existing = activeAutoPublishes.get(params.userId);
  if (existing) {
    clearInterval(existing.intervalId);
    clearTimeout(existing.endTimeoutId);
    if (existing.webhookClient) {
      await existing.webhookClient.delete().catch(() => {});
      existing.webhookClient.destroy();
    }
    activeAutoPublishes.delete(params.userId);
    logger.warn({ userId: params.userId }, "Replaced an existing active auto-publish job before starting a new one");
  }

  // ── إنشاء webhook مخصص للنشر ──────────────────────────────────────────────
  const roomCh = guild.channels.cache.get(params.roomChannelId) as TextChannel | undefined;
  let webhookClient: WebhookClient | null = null;
  let webhookId:     string | null        = null;

  if (roomCh) {
    try {
      // ── اسم وأفتار صاحب المتجر — النشر يبان بشخصيته مش شخصية السيرفر ──────────
      const ownerMember =
        guild.members.cache.get(params.userId) ??
        (await guild.members.fetch(params.userId).catch(() => null));
      const ownerName   = ownerMember?.displayName ?? params.username;
      const ownerAvatar =
        ownerMember?.displayAvatarURL({ extension: "png", size: 256 }) ??
        guild.iconURL({ extension: "png", size: 256 }) ??
        undefined;

      const wh = await roomCh.createWebhook({
        name:   ownerName.slice(0, 80),
        avatar: ownerAvatar,
        reason: `Auto publish for <@${params.userId}>`,
      });
      webhookClient = new WebhookClient({ id: wh.id, token: wh.token! });
      webhookId     = wh.id;
      logger.info({ userId: params.userId, webhookId: wh.id }, "Auto publish webhook created");
    } catch (err) {
      logger.warn({ err, userId: params.userId }, "Failed to create auto publish webhook — falling back to channel send");
    }
  }

  // ── دالة النشر ─────────────────────────────────────────────────────────────
  const doPost = async () => {
    try {
      const ch = guild.channels.cache.get(params.roomChannelId) as TextChannel | undefined;
      if (!ch) return;

      let mentionText = "";
      if (params.mentionType && params.mentionsPerPost > 0) {
        const user   = await getOrCreateUser(params.userId, params.username);
        const balKey =
          params.mentionType === "here"     ? "hereBalance" :
          params.mentionType === "everyone" ? "everyoneBalance" :
          params.mentionType === "orders"   ? "ordersBalance" :
          params.mentionType === "auction"  ? "auctionBalance" : "offersBalance";
        if (user[balKey] >= params.mentionsPerPost) {
          await db.update(botUsersTable)
            .set({ [balKey]: user[balKey] - params.mentionsPerPost })
            .where(eq(botUsersTable.discordUserId, params.userId));
          mentionText =
            params.mentionType === "here"     ? "@here" :
            params.mentionType === "everyone" ? "@everyone" :
            params.mentionType === "orders"   ? `<@&${ORDERS_ROLE_ID}>` :
            params.mentionType === "auction"  ? `<@&${AUCTION_ROLE_ID}>` : `<@&${OFFERS_ROLE_ID}>`;
        }
      }

      const embed = params.imageUrl
        ? new EmbedBuilder().setDescription(params.message).setImage(params.imageUrl).setColor(0x00bfff)
        : null;

      if (webhookClient) {
        // النشر عبر الـ webhook (الاسم والأفاتار مخصصَيْن)
        await webhookClient.send({
          content: mentionText || undefined,
          embeds:  embed ? [embed] : undefined,
          ...(embed ? {} : { content: `${mentionText}\n${params.message}`.trim() }),
        }).catch(async () => {
          // الـ webhook اتحذف خارجياً — ارجع لإرسال عادي
          webhookClient?.destroy();
          webhookClient = null;
          webhookId     = null;
          await ch.send({ content: `${mentionText}\n${params.message}`.trim() }).catch(() => {});
        });
      } else {
        // fallback: إرسال عادي
        if (embed) {
          await ch.send({ content: mentionText || undefined, embeds: [embed] })
            .catch(() => ch.send({ content: `${mentionText}\n${params.message}`.trim() }).catch(() => {}));
        } else {
          await ch.send({ content: `${mentionText}\n${params.message}`.trim() }).catch(() => {});
        }
      }
    } catch { /* ignore */ }
  };

  // نشر فوري ثم كل 6 ساعات
  await doPost();
  const intervalId = setInterval(doPost, AUTO_PUBLISH_INTERVAL_MS);

  // وقف النشر بعد المدة + حذف الـ webhook
  const endTimeoutId = setTimeout(async () => {
    clearInterval(intervalId);
    activeAutoPublishes.delete(params.userId);
    // احذف الـ webhook
    if (webhookClient && webhookId) {
      await webhookClient.delete().catch(() => {});
      webhookClient.destroy();
      logger.info({ userId: params.userId, webhookId }, "Auto publish webhook deleted (period ended)");
    }
    try {
      const ch = guild.channels.cache.get(params.roomChannelId) as TextChannel | undefined;
      await ch?.send(`✅ <@${params.userId}> انتهت مدة النشر التلقائي لمتجرك.`);
    } catch { /* ignore */ }
  }, params.durationMs);

  activeAutoPublishes.set(params.userId, {
    userId:          params.userId,
    roomChannelId:   params.roomChannelId,
    message:         params.message,
    imageUrl:        params.imageUrl,
    mentionType:     params.mentionType,
    mentionsPerPost: params.mentionsPerPost,
    intervalId,
    endTimeoutId,
    webhookClient,
    webhookId,
  });
}

/**
 * يوقف جوب نشر تلقائي شغّال لمستخدم معيّن (لو موجود) — بيقفل الـ interval/timeout
 * وبيحذف الـ webhook المخصص. يرجع true لو كان فيه جوب شغّال واتقفل بنجاح.
 */
async function stopAutoPublish(guild: Guild, userId: string): Promise<boolean> {
  const job = activeAutoPublishes.get(userId);
  if (!job) return false;

  clearInterval(job.intervalId);
  clearTimeout(job.endTimeoutId);
  activeAutoPublishes.delete(userId);

  if (job.webhookClient) {
    await job.webhookClient.delete().catch(() => {});
    job.webhookClient.destroy();
  }

  try {
    const ch = guild.channels.cache.get(job.roomChannelId) as TextChannel | undefined;
    await ch?.send(`🛑 <@${userId}> تم إيقاف النشر التلقائي لمتجرك من الإدارة.`);
  } catch { /* ignore */ }

  return true;
}

/** بعد تأكيد الدفع: ننتظر الأونر يمنشن الشريك الجديد في الروم */
const awaitingPartnerMention = new Map<string, {
  purchaseId:    number;
  roomChannelId: string;
  guildId:       string;
  timeoutId:     ReturnType<typeof setTimeout>;
}>();

async function cancelPendingStoreRename(userId: string, notify: boolean): Promise<void> {
  const pending = pendingStoreRenames.get(userId);
  if (!pending) return;
  clearTimeout(pending.timeoutId);
  pendingStoreRenames.delete(userId);
  if (!notify) return;
  try {
    const ch = await client.channels.fetch(pending.channelId).catch(() => null);
    if (!ch || !ch.isTextBased() || !("send" in ch)) return;
    const textCh      = ch as import("discord.js").TextChannel;
    const guild       = textCh.guild;
    const guildIconURL = guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;
    const DIV_X       = "ـﮩ════════════════ﮩـ";
    const timeoutFiles: import("discord.js").AttachmentBuilder[] = [];

    const timeoutEmbed = new EmbedBuilder()
      .setAuthor({ name: "Dragon $hop", iconURL: guildIconURL })
      .setTitle(`⏰ انتهت مهلة تغيير اسم المتجر`)
      .setDescription(`<@${userId}> ${MONEY_EMOJI}\n> ${DIV_X}`)
      .setColor(0xff4444)
      .addFields(
        {
          name:  `${STAR_EMOJI} المتجر`,
          value: `> ${MONEY_EMOJI} **${pending.currentName}**\n> ${DIV_X}`,
          inline: false,
        },
        {
          name:  `${STAR_EMOJI} السبب`,
          value: `> مفيش تحويل اتعمل خلال دقيقتين\n> لو عايز تغير تاني، ابدأ عملية الشراء من الأول 🔄\n> ${DIV_X}`,
          inline: false,
        },
      )
      .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: guildIconURL });

    if (fs.existsSync(DRAGON_BANNER_PATH)) {
      timeoutFiles.push(new AttachmentBuilder(DRAGON_BANNER_PATH, { name: "dragon_banner.webp" }));
      timeoutEmbed.setImage("attachment://dragon_banner.webp");
    }

    await ch.send({ content: `<@${userId}>`, embeds: [timeoutEmbed], files: timeoutFiles });
  } catch {
    // الشانل اتحذف أو البوت مالوش access — تجاهل
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  DB Helpers — دوال قاعدة البيانات
// ══════════════════════════════════════════════════════════════════════════════

/**
 * بيجيب اليوزر من DB أو بيعمله create لو مش موجود.
 * NOTE: بيتنادى في أي عملية تحتاج اليوزر عشان نضمن وجوده في DB.
 */
async function getOrCreateUser(discordUserId: string, discordUsername: string) {
  const [existing] = await db
    .select()
    .from(botUsersTable)
    .where(eq(botUsersTable.discordUserId, discordUserId));
  if (existing) return existing;
  const [created] = await db
    .insert(botUsersTable)
    .values({ discordUserId, discordUsername })
    .returning();
  return created;
}

/**
 * بيتحقق لو اليوزر محظور.
 * NOTE: لو الحظر المؤقت خلص بيرفعه تلقائياً من DB.
 *       الحظر الدائم (bannedUntil = null & isBanned = true) يبقى ساري للأبد.
 */
async function isUserBanned(discordUserId: string): Promise<boolean> {
  const [user] = await db
    .select()
    .from(botUsersTable)
    .where(eq(botUsersTable.discordUserId, discordUserId));
  if (!user || !user.isBanned) return false;
  // حظر مؤقت — لو انتهى وقته ارفعه تلقائياً
  if (user.bannedUntil && new Date() > user.bannedUntil) {
    await db
      .update(botUsersTable)
      .set({ isBanned: false, bannedUntil: null })
      .where(eq(botUsersTable.discordUserId, discordUserId));
    return false;
  }
  return true;
}

/**
 * بيضيف تحذير لليوزر ويتحقق من العدد.
 * عند وصول 3 تحذيرات: يحظره 4 أيام تلقائياً.
 *
 * NOTE: التحذيرات بتتراكم — مش بتتمسح لو الحظر انتهى.
 *       لو عايز تمسح تحذيرات يوزر لازم تعمل DELETE يدوي من warnings table.
 *
 * @returns عدد التحذيرات الحالي وهل اتحظر ولا لأ
 */
async function addWarning(
  discordUserId: string,
  discordUsername: string,
  reason: string,
  messageContent?: string
): Promise<{ warningCount: number; banned: boolean }> {
  await getOrCreateUser(discordUserId, discordUsername);
  await db.insert(warningsTable).values({
    discordUserId,
    discordUsername,
    reason,
    messageContent,
  });

  const allWarnings = await db
    .select()
    .from(warningsTable)
    .where(eq(warningsTable.discordUserId, discordUserId));

  const warningCount = allWarnings.length;

  if (warningCount >= 3) {
    // حظر 4 أيام (96 ساعة)
    const bannedUntil = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000);
    await db
      .update(botUsersTable)
      .set({ isBanned: true, bannedUntil, warningCount })
      .where(eq(botUsersTable.discordUserId, discordUserId));
    return { warningCount, banned: true };
  }

  await db
    .update(botUsersTable)
    .set({ warningCount })
    .where(eq(botUsersTable.discordUserId, discordUserId));
  return { warningCount, banned: false };
}

/**
 * بيبني إمبيد تحذير موحّد الشكل (بدل رسائل الخاص القديمة).
 * @param userId    اليوزر المقصود بالتحذير (بيتم منشنه في الوصف).
 * @param title     عنوان الإمبيد (مثلاً "تحذير 1/3" أو "تم الحظر").
 * @param description نص التحذير نفسه.
 * @param guild     السيرفر (لو موجود بيتحط أيقونته في الـ author/footer).
 */
function buildWarningEmbed(
  userId: string,
  title: string,
  description: string,
  guild?: import("discord.js").Guild | null,
): EmbedBuilder {
  const guildIconURL = guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;
  const DIV_WARN = "ـﮩ════════════════ﮩـ";
  return new EmbedBuilder()
    .setAuthor({ name: "Dragon $hop", iconURL: guildIconURL })
    .setTitle(`⚠️ ${title}`)
    .setDescription(`<@${userId}>\n> ${DIV_WARN}\n\n${description}\n\n> ${DIV_WARN}`)
    .setColor(0xff4444)
    .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: guildIconURL });
}

/** بيبعت إمبيد التحذير في نفس الروم (بدل الخاص) — فشل الإرسال بيتجاهل بهدوء. */
async function sendWarningEmbed(
  channel: import("discord.js").TextBasedChannel,
  userId: string,
  title: string,
  description: string,
  guild?: import("discord.js").Guild | null,
): Promise<void> {
  try {
    if ("send" in channel) {
      await (channel as import("discord.js").TextChannel).send({
        embeds: [buildWarningEmbed(userId, title, description, guild)],
      });
    }
  } catch {}
}

// ══════════════════════════════════════════════════════════════════════════════
//  Points Helpers — نظام النقاط (راجع notes/promo-codes.md)
// ══════════════════════════════════════════════════════════════════════════════

/** بيجيب رصيد نقاط اليوزر، وبيعمله صف في الجدول لو مش موجود (رصيد 0). */
async function getUserPoints(discordUserId: string): Promise<number> {
  const [row] = await db.select().from(userPointsTable).where(eq(userPointsTable.discordUserId, discordUserId));
  return row?.points ?? 0;
}

/**
 * بيضيف (أو يخصم لو delta سالب) نقاط لليوزر بشكل atomic (upsert + increment
 * على مستوى الـ DB) عشان يتجنب race conditions لو حصل تحديثين في نفس اللحظة.
 * الرصيد مبيسمحش ينزل تحت الصفر.
 */
async function addUserPoints(discordUserId: string, delta: number): Promise<number> {
  const [row] = await db
    .insert(userPointsTable)
    .values({ discordUserId, points: Math.max(0, delta) })
    .onConflictDoUpdate({
      target: userPointsTable.discordUserId,
      set: {
        points:    sql`greatest(0, ${userPointsTable.points} + ${delta})`,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row?.points ?? 0;
}

// ══════════════════════════════════════════════════════════════════════════════
//  AutoMod Setup
//  NOTE: البوت بيعمل قاعدتين في Discord AutoMod:
//  1. "Bot - Blocked Words"  — بيبلوك الكلام الممنوع في كل السيرفر
//  2. "Bot - Mention Block"  — بيبلوك @everyone/@here/@offers في كل السيرفر
//                              رول "منشن مفعّل" معفي من القاعدة — البوت بيديه
//                              لأصحاب الرومات اللي عندهم رصيد.
// ══════════════════════════════════════════════════════════════════════════════
async function setupAutoMod(guild: Guild): Promise<void> {
  try {
    const existingRules = await guild.autoModerationRules.fetch();

    // ── إنشاء / جلب رول "منشن مفعّل" ────────────────────────────────────
    await guild.roles.fetch();
    let mentionRole = guild.roles.cache.find((r) => r.name === MENTION_ACTIVE_ROLE_NAME) ?? null;
    if (!mentionRole) {
      mentionRole = await guild.roles.create({
        name:        MENTION_ACTIVE_ROLE_NAME,
        mentionable: false,
        reason:      "Dragon Bot — mention bypass role (exempted from AutoMod mention block)",
      });
      logger.info({ roleId: mentionRole.id }, "Created mention active role");
    }
    mentionActiveRoleId = mentionRole.id;

    // ── حذف قاعدة المنشنات القديمة لو موجودة ────────────────────────────
    const oldMentionRule = existingRules.find((r) => r.name === "Bot - Mention Balance Block");
    if (oldMentionRule) {
      await oldMentionRule.delete("Replaced by AutoMod mention block with role exemption");
      logger.info("Deleted old mention AutoMod rule");
    }

    // ── قاعدة الكلام الممنوع (سيرفر-wide) ──────────────────────────────
    const bannedWordRuleName = "Bot - Blocked Words";
    const existingBannedRule = existingRules.find((r) => r.name === bannedWordRuleName);
    if (existingBannedRule) {
      await existingBannedRule.edit({
        triggerMetadata: { keywordFilter: BANNED_WORDS, regexPatterns: [], allowList: [] },
        enabled: true,
      });
    } else {
      await guild.autoModerationRules.create({
        name: bannedWordRuleName,
        eventType: AutoModerationRuleEventType.MessageSend,
        triggerType: AutoModerationRuleTriggerType.Keyword,
        triggerMetadata: { keywordFilter: BANNED_WORDS, regexPatterns: [], allowList: [] },
        actions: [{
          type: AutoModerationActionType.BlockMessage,
          metadata: { customMessage: "⛔ رسالتك اتبلوكت: كلام ممنوع." },
        }],
        enabled: true,
      });
    }

    // ── قاعدة حجب المنشنات (سيرفر-wide + role exemption) ────────────────
    // NOTE: رول "منشن مفعّل" معفي — البوت بيديه لأصحاب الرومات اللي عندهم رصيد.
    //       لما الكولداون يبدأ أو الرصيد يخلص، البوت يسحب الرول →
    //       أي محاولة منشن تانية بتطلع "Failed to send" مباشرةً.
    const mentionBlockRuleName = "Bot - Mention Block";
    const existingMentionBlock = existingRules.find((r) => r.name === mentionBlockRuleName);
    const mentionKeywords = [
      "@everyone", "@here",
      `<@&${OFFERS_ROLE_ID}>`, `<@&${ORDERS_ROLE_ID}>`, `<@&${AUCTION_ROLE_ID}>`,
    ];

    if (existingMentionBlock) {
      await existingMentionBlock.edit({
        triggerMetadata: { keywordFilter: mentionKeywords, regexPatterns: [], allowList: [] },
        exemptRoles:     [mentionRole.id],
        enabled:         true,
      });
    } else {
      await guild.autoModerationRules.create({
        name:        mentionBlockRuleName,
        eventType:   AutoModerationRuleEventType.MessageSend,
        triggerType: AutoModerationRuleTriggerType.Keyword,
        triggerMetadata: { keywordFilter: mentionKeywords, regexPatterns: [], allowList: [] },
        actions: [{
          type:     AutoModerationActionType.BlockMessage,
          metadata: { customMessage: "⛔ مش مسموح بالمنشن — رصيدك خلص أو الكولداون لسه شغال أو ده مش روم بتاعتك." },
        }],
        exemptRoles: [mentionRole.id],
        enabled:     true,
      });
    }

    logger.info({ mentionActiveRoleId }, "AutoMod rules configured");
  } catch (err) {
    logger.error({ err }, "Failed to setup AutoMod rules");
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  Mention Role Helpers
//  NOTE: البوت يدير رول "منشن مفعّل" بدل الكولداون اليدوي —
//        سحب الرول = "Failed to send" فوراً من Discord بدون ما الرسالة تتبعت.
// ══════════════════════════════════════════════════════════════════════════════

/** بيدي رول "منشن مفعّل" ليوزر لو مش عنده بالفعل */
async function grantMentionRole(guild: Guild, userId: string): Promise<void> {
  if (!mentionActiveRoleId) return;
  try {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member || member.roles.cache.has(mentionActiveRoleId)) return;
    await member.roles.add(mentionActiveRoleId, "Eligible: room owner with balance");
  } catch (err) {
    logger.error({ err, userId }, "Failed to grant mention role");
  }
}

/** بيسحب رول "منشن مفعّل" نهائياً (رصيد خلص) */
async function revokeMentionRole(guild: Guild, userId: string): Promise<void> {
  if (!mentionActiveRoleId) return;
  try {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member || !member.roles.cache.has(mentionActiveRoleId)) return;
    await member.roles.remove(mentionActiveRoleId, "Balance depleted");
  } catch (err) {
    logger.error({ err, userId }, "Failed to revoke mention role");
  }
}

/**
 * بيسحب رول "منشن مفعّل" مؤقتاً (كولداون) ثم بيرجّعه بعد cooldownMs
 * لو اليوزر لسه عنده رصيد.
 */
async function revokeMentionRoleWithCooldown(
  guild: Guild,
  userId: string,
  cooldownMs: number,
): Promise<void> {
  if (!mentionActiveRoleId) return;
  try {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) return;
    if (member.roles.cache.has(mentionActiveRoleId)) {
      await member.roles.remove(mentionActiveRoleId, "Mention sent — cooldown active");
    }
    setTimeout(async () => {
      try {
        const u = await getOrCreateUser(userId, "");
        const hasBalance =
          u.everyoneBalance > 0 || u.hereBalance > 0 || u.offersBalance > 0 ||
          u.ordersBalance   > 0 || u.auctionBalance > 0;
        if (!hasBalance) return; // الرصيد خلص — ما يرجعش الرول
        const freshMember = await guild.members.fetch(userId).catch(() => null);
        if (!freshMember || freshMember.roles.cache.has(mentionActiveRoleId!)) return;
        await freshMember.roles.add(mentionActiveRoleId!, "Cooldown expired — balance still available");
      } catch (err) {
        logger.error({ err, userId }, "Failed to re-grant mention role after cooldown");
      }
    }, cooldownMs);
  } catch (err) {
    logger.error({ err, userId }, "Failed to revoke mention role for cooldown");
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  Product Requests — تكتات "طلب المنتج"
// ══════════════════════════════════════════════════════════════════════════════

/** بيرجع رقم مبطن بأصفار لـ 3 خانات — مثال: 1 → "001" */
function padTicketNumber(n: number): string {
  return String(n).padStart(3, "0");
}

/** كاش بسيط للـ webhook بتاع كل شانل — عشان منعملش fetch/create في كل رسالة */
const storeWebhookCache = new Map<string, import("discord.js").Webhook>();

/**
 * بيجيب (أو يعمل) الـ webhook المخصص لتشفير رسائل صاحب المتجر في شانل معين.
 * NOTE: بيتخزن في كاش في الميموري — لو الـ webhook اتمسح من ديسكورد يدوياً
 *       البوت هيفشل في الإرسال (catch بيرجع null) ويرجع لأسلوب الرد العادي.
 */
async function getOrCreateStoreWebhook(channel: TextChannel): Promise<import("discord.js").Webhook | null> {
  const cached = storeWebhookCache.get(channel.id);
  if (cached) return cached;

  try {
    const webhooks = await channel.fetchWebhooks();
    let webhook = webhooks.find((w) => w.owner?.id === client.user?.id);
    if (!webhook) {
      webhook = await channel.createWebhook({ name: "Dragon Relay" });
    }
    storeWebhookCache.set(channel.id, webhook);
    return webhook;
  } catch (err) {
    logger.error({ err, channelId: channel.id }, "Failed to get/create store webhook");
    return null;
  }
}

/** رتبة "مراجعين طلبات المنتج" — بتتضاف تلقائياً لثريد أي طلب منتج جديد */
const PRODUCT_REQUEST_REVIEWER_ROLE_ID = "1500495148700668136";

/** بيجيب كل الأعضاء اللي عندهم رتبة معينة في السيرفر */
async function getRoleMemberIds(guild: Guild, roleId: string): Promise<string[]> {
  try {
    const role = await guild.roles.fetch(roleId).catch(() => null);
    if (!role) {
      logger.warn({ roleId }, "getRoleMemberIds: role not found in guild");
      return [];
    }
    // لازم كل الأعضاء يكونوا متكاشين عشان role.members يرجع كله صح
    await guild.members.fetch().catch((err) => {
      logger.error({ err }, "getRoleMemberIds: failed to fetch guild members");
    });
    const ids = [...role.members.keys()];
    logger.info({ roleId, roleName: role.name, count: ids.length }, "getRoleMemberIds: resolved role members");
    return ids;
  } catch (err) {
    logger.error({ err, roleId }, "Failed to fetch role members");
    return [];
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  Message Checks — فحوصات الرسائل
// ══════════════════════════════════════════════════════════════════════════════

/** بيتحقق لو الرسالة فيها لينك خارجي أو دعوة Discord */
function containsLink(text: string): boolean {
  return /https?:\/\/|discord\.gg\/|www\./i.test(text);
}

/**
 * بيتحقق لو في أكتر من منشن واحد (@everyone / @here / رول معين) في الرسالة.
 * NOTE: منشن واحد كده بيعدي عادي — الأكتر من واحد في رسالة واحدة ده اسبام.
 */
function containsSpamMention(text: string): boolean {
  const matches = text.match(/@(everyone|here|&\d+)/g);
  return matches !== null && matches.length > 1;
}

/**
 * بيشوف لو حد بيحاول يشفر كلامه يدوياً عشان يعدي على AutoMod.
 * NOTE: البوت نفسه بيعمل تشفير بسيط (encodeArabicFranco) على الكلام الممنوع
 *       ويبعته في الشانل بدل الكلام الأصلي — ده عشان الأدمن يعرف إيه اللي قاله.
 *       أي شخص يحاول يشفر بنفسه بياخد تحذير.
 */
function isSelfEncoded(text: string): boolean {
  const stripped = text.replace(/\s/g, "");
  return (
    /^[A-Za-z0-9+/=]{20,}$/.test(stripped) ||               // base64-like
    /[\u0600-\u06FF][19][\u0600-\u06FF]/.test(text) ||       // أرقام وسط عربي
    /[\u0600-\u06FF]ـ،[\u0600-\u06FF]/.test(text) ||         // فواصل إجبارية
    /[\u0600-\u06FF](\/\/\/|III)[\u0600-\u06FF]/.test(text)  // فواصل شكلية
  );
}

/**
 * بيشفر الكلام العربي بطريقة بسيطة عشان يتبعت في الشانل بدل الكلام المباشر.
 * بيحوّل بعض الأحرف لأرقام ويكسر الكلمات الطويلة بفاصل.
 * NOTE: الغرض هو الـ logging فقط — مش سكيورتي.
 */
function encodeArabicFranco(text: string): string {
  const map: Record<string, string> = {
    "ا": "1", "أ": "1", "إ": "1", "آ": "1", "ى": "1", "و": "9",
  };
  let r = "";
  for (const ch of text) r += map[ch] ?? ch;
  return r.replace(/[\u0600-\u06FF\d]{5,}/gu, (w) => {
    const m = Math.floor(w.length / 2);
    return w.slice(0, m) + "ـ،" + w.slice(m);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
//  Helpers — أدوات مساعدة
// ══════════════════════════════════════════════════════════════════════════════

/** إيموجيات الـ embed الرئيسية */
const STAR_EMOJI  = "<a:yellowstar:1496143576759930901>";
const MONEY_EMOJI = "<a:1122112:1524694428386852929>";

/**
 * بيحول نص عادي لنص Bold بيستخدم Unicode Mathematical Bold letters.
 * NOTE: بيشتغل فقط مع A-Z و a-z — الأحرف العربية والأرقام بتتحط كما هي.
 */
function toBold(text: string): string {
  return [...text].map((ch) => {
    const c = ch.charCodeAt(0);
    if (c >= 65 && c <= 90)  return String.fromCodePoint(c - 65 + 0x1d400); // A-Z
    if (c >= 97 && c <= 122) return String.fromCodePoint(c - 97 + 0x1d41a); // a-z
    return ch;
  }).join("");
}

/**
 * بيعمل label للروم بالشكل الخاص بالمتجر.
 * مثال: "gold" → "엔𝐆𝐨𝐥𝐝."
 */
function roomLabel(name: string): string {
  return `엔${toBold(name.charAt(0).toUpperCase() + name.slice(1))}.`;
}

// ══════════════════════════════════════════════════════════════════════════════
//  Asset Paths — مسارات الصور
//  NOTE: الصور اتوضع في artifacts/api-server/assets/
//        لو الصورة مش موجودة، البوت يبعت الـ embed بدون صورة بشكل graceful.
//        الصور المطلوبة:
//          dragon.webp           — صورة التنين (thumbnail في صفحة معلومات الروم)
//          dragon_banner.webp    — بانر المتجر الرئيسي + رسالة تأكيد إنشاء الروم
//          dragon_text_banner.webp — بانر الخط العام (يستخدم في كل الإمبيدات
//                                    العامة اللي مالهاش بانر خاص بفئتها)
//          dragon_text_banner_stores_types.webp  — بانر "أنواع المتاجر" (buycat_المتاجر)
//          dragon_text_banner_stores_rules.webp  — بانر "قوانين المتاجر" (رسالة ترحيب الروم)
//          dragon_text_banner_stores_prices.webp — بانر "أسعار المتاجر" (shopcat_المتاجر)
//          dragon_text_banner_orders.webp        — بانر "أسعار الطلبيات" (shopcat_الطلبيات)
//          dragon_text_banner_auction.webp       — بانر "أسعار المزاد" (shopcat_المزاد)
//          dragon_text_banner_addons.webp        — بانر "أسعار الإضافات" (shopcat_الإضافات)
// ══════════════════════════════════════════════════════════════════════════════
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.resolve(__dirname, "../assets");

const DRAGON_IMAGE_PATH       = path.join(ASSETS_DIR, "dragon.webp");
const DRAGON_BANNER_PATH      = path.join(ASSETS_DIR, "dragon_banner.webp");
const DRAGON_TEXT_BANNER_PATH = path.join(ASSETS_DIR, "dragon_text_banner.webp");

const STORES_TYPES_BANNER_PATH  = path.join(ASSETS_DIR, "dragon_text_banner_stores_types.webp");
const STORES_RULES_BANNER_PATH  = path.join(ASSETS_DIR, "dragon_text_banner_stores_rules.webp");
const STORES_PRICES_BANNER_PATH = path.join(ASSETS_DIR, "dragon_text_banner_stores_prices.webp");
const STORES_RULES_LINE_PATH    = path.join(ASSETS_DIR, "dragon_line_stores_rules.webp");
const ORDERS_BANNER_PATH        = path.join(ASSETS_DIR, "dragon_text_banner_orders.webp");
const AUCTION_BANNER_PATH       = path.join(ASSETS_DIR, "dragon_text_banner_auction.webp");
const ADDONS_BANNER_PATH        = path.join(ASSETS_DIR, "dragon_text_banner_addons.webp");

// بانر بانل الأسعار الخاص بكل فئة (shopcat_*) — لو الفئة معملها بانر مخصص
// بنستخدمه، وإلا بيرجع للبانر العام (DRAGON_TEXT_BANNER_PATH).
const SHOPCAT_BANNER_PATH: Record<string, string> = {
  "المتاجر":   STORES_PRICES_BANNER_PATH,
  "الطلبيات":  ORDERS_BANNER_PATH,
};

// بانر بانل الشراء الخاص بكل فئة (buycat_*)
const BUYCAT_BANNER_PATH: Record<string, string> = {
  "المتاجر": STORES_TYPES_BANNER_PATH,
};

// ══════════════════════════════════════════════════════════════════════════════
//  فئات المتجر
//  NOTE: الترتيب هنا هو نفس ترتيب الأزرار في بانل المتجر الرئيسي.
//        لو عايز تضيف فئة جديدة، ضيفها هنا وعمل handler لها في InteractionCreate.
// ══════════════════════════════════════════════════════════════════════════════
const SHOP_CATEGORIES = ["المتاجر", "الطلبيات", "المزاد", "الرتب", "الإضافات"] as const;

// ══════════════════════════════════════════════════════════════════════════════
//  رتب Discord لكل نوع روم
//  NOTE: الـ Role IDs دي بتتظهر في embed معلومات الروم كـ @mention للرتبة.
//        لو أضفت نوع روم جديد، ضيف ID رتبته هنا.
// ══════════════════════════════════════════════════════════════════════════════
const ROOM_ROLE_IDS: Record<string, string> = {
  "nightmare": "1526178354665885756",
  "emerald":   "1526178355840286810",
  "diamond":   "1526178356838797382",
  "platinum":  "1526196304735244349",
  "gold":      "1526178357421674558",
  "sliver":    "1526178359392862278",
  "bronze":    "1526178360416276570",
};

// ══════════════════════════════════════════════════════════════════════════════
//  الرومات الثابتة
//  NOTE: دي الرومات الأساسية اللي بتتحط في المتجر دايماً.
//        بتتـ sync للـ DB كل ما البوت يشتغل (syncStaticRooms).
//        أي تعديل في البيانات هنا هياخد أفكت بعد restart البوت.
//
//        الأسعار اللي قيمتها 0: محتاجة تتعدل إما عن طريق:
//          1. تغييرها هنا مباشرة ثم restart
//          2. أمر /addroom (بيضيف روم جديد) — مش بيعدل الـ static
//          3. UPDATE يدوي في DB
//
//        discordCategoryId: الـ ID بتاع الكاتيجوري في Discord اللي الرومات بتتعمل تحتها.
//          null = مش ربط لكاتيجوري محددة (الروم هيتعمل بدون parent category)
// ══════════════════════════════════════════════════════════════════════════════
interface StaticRoom {
  name:              string;
  price:             number;   // السعر الصافي بالكريدت (بدون عمولة ProBot)
  decorations:       string;   // إيموجي الزخرفة اللي بيظهر في اسم الروم
  offersCount:       number;   // عدد منشنات @offers المرفقة مع الروم
  hereCount:         number;   // عدد منشنات @here المرفقة مع الروم
  everyoneCount:     number;   // عدد منشنات @everyone المرفقة مع الروم
  discordCategoryId: string | null; // Discord Category ID
}

const STATIC_ROOMS: Record<string, StaticRoom[]> = {
  "المتاجر": [
    {
      name: "bronze",    price: 2000000,  decorations: "💠",
      offersCount: 10, hereCount: 7,  everyoneCount: 5,
      discordCategoryId: "1521225661145026560",
    },
    {
      name: "sliver",    price: 5000000,  decorations: "🪽",
      offersCount: 13, hereCount: 10, everyoneCount: 7,
      discordCategoryId: "1521225659362312232",
    },
    {
      name: "gold",      price: 10000000, decorations: "👑",
      offersCount: 15, hereCount: 13, everyoneCount: 10,
      discordCategoryId: "1521225658410336427",
    },
    {
      name: "platinum",  price: 25000000, decorations: "☄️",
      offersCount: 19, hereCount: 15, everyoneCount: 13,
      discordCategoryId: "1521225657546182867",
    },
    {
      name: "diamond",   price: 30000000, decorations: "💎",
      offersCount: 23, hereCount: 19, everyoneCount: 15,
      discordCategoryId: "1521225656099143851",
    },
    {
      name: "emerald",   price: 40000000, decorations: "🐉",
      offersCount: 29, hereCount: 25, everyoneCount: 20,
      discordCategoryId: "1521225655562272869",
    },
    {
      name: "nightmare", price: 50000000, decorations: "🐦‍🔥",
      offersCount: 35, hereCount: 30, everyoneCount: 30,
      discordCategoryId: "1521225654807433277",
    },
  ],
  "الطلبيات": [], // TODO: أضف رومات هنا لو احتجت
  "المزاد":   [], // TODO: أضف رومات هنا لو احتجت
  "الرتب":    [], // TODO: أضف رومات هنا لو احتجت
  "الإضافات": [], // الإضافات مش رومات — أسعارها في addon_prices table
};

/** الترتيب المرئي للرومات في /synccategories (من الأعلى للأقل) */
const ROOM_CATEGORY_ORDER = ["nightmare", "emerald", "diamond", "platinum", "gold", "sliver", "bronze"];

/**
 * ID الكاتيجوري في Discord اللي التذاكر (tickets) بتتعمل تحتها.
 * NOTE: لو الكاتيجوري دي اتحذفت من السيرفر، إنشاء التذاكر هيفشل.
 *       في الحالة دي عمل كاتيجوري جديدة وعدّل الـ ID هنا.
 */
const TICKETS_CATEGORY_ID = "1493289978225098752";

/**
 * ID رول @offers — بيتمنشن في رومات العملاء وبينزل من رصيدهم.
 * NOTE: لو الرول اتحذف أو تغير ID-ه، عدّل هنا.
 */
const OFFERS_ROLE_ID = "1525477889464602734";

/**
 * ID رول منشن الطلبيات — نفس منطق OFFERS_ROLE_ID بالظبط لكن لفئة "الطلبيات".
 */
const ORDERS_ROLE_ID = "1525478170491617382";

/**
 * ID رول منشن المزاد — نفس منطق OFFERS_ROLE_ID بالظبط لكن لفئة "المزاد".
 * NOTE: ده مختلف عن AUCTION_TYPES (نظام إعلانات المزاد المنفصل) — ده رصيد
 *       منشن دائم بيتنزل من رصيد صاحب الروم زي offers/here/everyone بالظبط.
 */
const AUCTION_ROLE_ID = "1525478115181334548";

/**
 * ID روم الطلبيات الثابت — أي حد في السيرفر يقدر يبعت فيه (مش زي رومات
 * العملاء المقفولة على الأونر/الشريك). فيه سلوموود ساعة (بيتحط تلقائياً
 * عند تشغيل البوت)، والمنشنات المسموحة فيه: @everyone / @here / طلبيات بس —
 * @offers والمزاد ممنوعين هنا حتى لو صاحبهم معفي من AutoMod.
 */
const ORDERS_STATIC_CHANNEL_ID = "1523801357017153658";

/** سلوموود روم الطلبيات: ساعة كاملة */
const ORDERS_ROOM_SLOWMODE_SEC = 60 * 60;

/** ID روم أخبار الشوب */
const SHOP_NEWS_CHANNEL_ID = "1525277759008407762";

// ══════════════════════════════════════════════════════════════════════════════
//  المزاد — الإعدادات والحالة والأدوات
//  NOTE: الرومات ثابتة في Discord (مش البوت اللي بيعملها).
//        البوت بس بيقفلها ويفتحها حسب الجدول.
// ══════════════════════════════════════════════════════════════════════════════

/** IDs الشانلات المخصصة للمزادات (3 رومات جاهزة في Discord) */
const AUCTION_ROOM_CHANNEL_IDS: readonly string[] = [
  "1523801341292712051",
  "1523801346195853396",
  "1526567411199905802",
];

/** رتبة "مسؤول المزاد" — الأدمن اللي بيدير المزايدة يدوياً وبيتمنشن عند بداية كل مزاد */
const AUCTION_MANAGER_ROLE_ID = "1526566223498838096";

/** ساعة إقفال المزادات القسري لو الأدمن ما اعلنش فايز (نهاية يوم الحجز) */
const AUCTION_DAY_END_HOUR = 23;

/** أقصى عدد أيام نبحث فيها عن ميعاد فاضي عند التحديد التلقائي */
const AUCTION_SLOT_SEARCH_DAYS = 7;

/** ID كاتيجوري المزادات والطلبيات */
const AUCTION_CATEGORY_ID = "1523801337933074688";

/** ID الشانل اللي بيتبعت فيه إمبيد الأسعار والجدول */
const AUCTION_INFO_CHANNEL_ID = "1523801349655888076";

/** أنواع المزاد وأسعارها (سعر صافي بدون عمولة ProBot) */
const AUCTION_TYPES = {
  everyone: { label: "@everyone", emoji: "📢", price: 10_000_000 },
  here:     { label: "@here",     emoji: "📣", price: 5_000_000  },
  offers:   { label: "@مزاد",     emoji: "🔔", price: 3_000_000  },
} as const;
type AuctionType = keyof typeof AUCTION_TYPES;

/**
 * IDs رسائل شانل المزاد الثابتة (تتعبى من الشانل عند كل restart).
 * - auctionInfoMsgId    → رسالة الشرح (ما تتبعتش تاني أبداً)
 * - auctionScheduleMsgId → رسالة المواعيد المحجوزة (تتعدّل تلقائياً)
 */
let auctionInfoMsgId:     string | null = null;
let auctionScheduleMsgId: string | null = null;

// ── Mention Active Role ──────────────────────────────────────────────────────
// NOTE: رول بيديه البوت لأصحاب الرومات اللي عندهم رصيد.
//       بيكون exempted من قاعدة AutoMod "Bot - Mention Block".
//       لو الرصيد خلص أو الكولداون شغال → البوت يسحب الرول → "Failed to send".
const MENTION_ACTIVE_ROLE_NAME = "منشن مفعّل";
const MENTION_COOLDOWN_MS      = 30 * 60 * 1000; // 30 دقيقة كولداون بعد كل منشن
const ADD_PARTNER_PRICE        = 4_000_000;        // سعر إضافة شريك
const REMOVE_PARTNER_PRICE     = 6_000_000;        // سعر إزالة شريك
let   mentionActiveRoleId: string | null = null;

/**
 * حالة المزادات الجارية حالياً (في الذاكرة — تُصفَّر عند restart البوت).
 * NOTE: المزايدة بقت يدوية بالكامل تحت إدارة الأدمن — البوت بس بيعرف إن الروم
 *       مشغول (عشان يمنع تشغيل مزاد جديد فيه ويأجّل المواعيد التالية عليه).
 */
const activeAuctions = new Map<string, {
  scheduleId:  number;
  auctionType: AuctionType;
  startedAt:   number;
}>();

/** تذكرة مزاد بانتظار الإقفال التلقائي بعد تحديد/تغيير الميعاد (scheduleId → timeout) */
const pendingAuctionTicketAutoClose = new Map<number, ReturnType<typeof setTimeout>>();

/** بيرجع التاريخ والساعة والدقيقة الحالية بتوقيت القاهرة */
function getCairoTime(): { date: string; hour: number; minute: number } {
  const now  = new Date();
  const date = now.toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Cairo",
    hour:     "numeric",
    minute:   "numeric",
    hour12:   false,
  }).formatToParts(now);
  const hourStr   = parts.find((p) => p.type === "hour")?.value   ?? "0";
  const minuteStr = parts.find((p) => p.type === "minute")?.value ?? "0";
  let h = parseInt(hourStr, 10);
  if (h === 24) h = 0;
  const m = parseInt(minuteStr, 10);
  return { date, hour: h, minute: m };
}

/** بيرجع تاريخ (YYYY-MM-DD) بعد إضافة عدد أيام لتاريخ معين */
function addDaysToDateStr(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * بيدوّر على أقرب ميعاد فاضي (يوم + ساعة + روم) بدايةً من اليوم الحالي.
 * بيفحص لحد AUCTION_SLOT_SEARCH_DAYS يوم قدام، وبيختار عشوائي من بين كل
 * الميعاد المتاحة في أول يوم فيه فراغ (ده اللي يحقق "البوت يختار بمزاجه").
 */
async function findNextAvailableAuctionSlot(): Promise<{ date: string; hour: number; roomChannelId: string } | null> {
  const { date: today, hour: currentHour } = getCairoTime();

  for (let dayOffset = 0; dayOffset < AUCTION_SLOT_SEARCH_DAYS; dayOffset++) {
    const targetDate = dayOffset === 0 ? today : addDaysToDateStr(today, dayOffset);

    const booked = await db
      .select({ scheduledHour: auctionSchedulesTable.scheduledHour, roomChannelId: auctionSchedulesTable.roomChannelId })
      .from(auctionSchedulesTable)
      .where(
        and(
          eq(auctionSchedulesTable.scheduledDate, targetDate),
          inArray(auctionSchedulesTable.status, ["scheduled", "active", "completed"]),
        ),
      );

    const usedRoomsByHour = new Map<number, Set<string>>();
    for (const b of booked) {
      if (b.scheduledHour == null || !b.roomChannelId) continue;
      if (!usedRoomsByHour.has(b.scheduledHour)) usedRoomsByHour.set(b.scheduledHour, new Set());
      usedRoomsByHour.get(b.scheduledHour)!.add(b.roomChannelId);
    }

    const candidateHours = Array.from({ length: 13 }, (_, i) => i + 10) // 10 → 22
      .filter((h) => dayOffset > 0 || h > currentHour);

    const candidates: { hour: number; roomChannelId: string }[] = [];
    for (const h of candidateHours) {
      const usedRooms = usedRoomsByHour.get(h) ?? new Set<string>();
      const freeRoom   = AUCTION_ROOM_CHANNEL_IDS.find((r) => !usedRooms.has(r));
      if (freeRoom) candidates.push({ hour: h, roomChannelId: freeRoom });
    }

    if (candidates.length > 0) {
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      return { date: targetDate, hour: pick.hour, roomChannelId: pick.roomChannelId };
    }
  }
  return null;
}

/**
 * بيدوّر على ميعاد فاضي (ساعة + روم) في يوم معين فقط.
 * بيختار عشوائي من بين الساعات المتاحة في اليوم ده.
 */
async function findSlotOnDay(targetDate: string): Promise<{ hour: number; roomChannelId: string } | null> {
  const { date: today, hour: currentHour } = getCairoTime();

  const booked = await db
    .select({ scheduledHour: auctionSchedulesTable.scheduledHour, roomChannelId: auctionSchedulesTable.roomChannelId })
    .from(auctionSchedulesTable)
    .where(
      and(
        eq(auctionSchedulesTable.scheduledDate, targetDate),
        inArray(auctionSchedulesTable.status, ["scheduled", "active", "completed"]),
      ),
    );

  const usedRoomsByHour = new Map<number, Set<string>>();
  for (const b of booked) {
    if (b.scheduledHour == null || !b.roomChannelId) continue;
    if (!usedRoomsByHour.has(b.scheduledHour)) usedRoomsByHour.set(b.scheduledHour, new Set());
    usedRoomsByHour.get(b.scheduledHour)!.add(b.roomChannelId);
  }

  // لو اليوم نفسه: بس الساعات اللي لسه ما جاتش | لو يوم تاني: كل الساعات المتاحة
  const candidateHours = Array.from({ length: 13 }, (_, i) => i + 10)
    .filter((h) => targetDate > today || h > currentHour);

  const candidates: { hour: number; roomChannelId: string }[] = [];
  for (const h of candidateHours) {
    const usedRooms = usedRoomsByHour.get(h) ?? new Set<string>();
    const freeRoom  = AUCTION_ROOM_CHANNEL_IDS.find((r) => !usedRooms.has(r));
    if (freeRoom) candidates.push({ hour: h, roomChannelId: freeRoom });
  }

  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)]!;
}

/**
 * بيرجع قائمة بالأيام المتاحة للحجز من النهارده لحد 7 أيام قدام.
 * بيجيب كل الحجوزات بكويري واحد ويفحص التوافر في الميموري.
 */
async function getAvailableBookingDays(): Promise<{ date: string; label: string }[]> {
  const { date: today, hour: currentHour } = getCairoTime();
  const arabicDayNames = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];

  // حساب آخر يوم (today + 7)
  const endDate = addDaysToDateStr(today, 7);

  // جلب كل الحجوزات الموجودة في الفترة دي
  const allBooked = await db
    .select({
      scheduledDate: auctionSchedulesTable.scheduledDate,
      scheduledHour: auctionSchedulesTable.scheduledHour,
      roomChannelId: auctionSchedulesTable.roomChannelId,
    })
    .from(auctionSchedulesTable)
    .where(inArray(auctionSchedulesTable.status, ["scheduled", "active", "completed"]));

  const bookedInRange = allBooked.filter(
    (b) => b.scheduledDate != null && b.scheduledDate >= today && b.scheduledDate <= endDate,
  );

  // بنبني Map: date → hour → Set<roomChannelId>
  const bookedMap = new Map<string, Map<number, Set<string>>>();
  for (const b of bookedInRange) {
    if (!b.scheduledDate || b.scheduledHour == null || !b.roomChannelId) continue;
    if (!bookedMap.has(b.scheduledDate)) bookedMap.set(b.scheduledDate, new Map());
    const byHour = bookedMap.get(b.scheduledDate)!;
    if (!byHour.has(b.scheduledHour)) byHour.set(b.scheduledHour, new Set());
    byHour.get(b.scheduledHour)!.add(b.roomChannelId);
  }

  const result: { date: string; label: string }[] = [];
  for (let offset = 0; offset <= 7; offset++) {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    const dateStr = d.toISOString().slice(0, 10);
    const byHour  = bookedMap.get(dateStr) ?? new Map<number, Set<string>>();

    const candidateHours = Array.from({ length: 13 }, (_, i) => i + 10)
      .filter((h) => offset > 0 || h > currentHour);

    const hasSlot = candidateHours.some((h) => {
      const used = byHour.get(h) ?? new Set<string>();
      return AUCTION_ROOM_CHANNEL_IDS.some((r) => !used.has(r));
    });

    if (hasSlot) {
      const dow   = d.getUTCDay();
      const label = offset === 0 ? `اليوم — ${arabicDayNames[dow]}` : arabicDayNames[dow];
      result.push({ date: dateStr, label });
    }
  }
  return result;
}

/** بيجدول (أو يعيد جدولة) إقفال تذكرة مزاد تلقائياً بعد ما الميعاد يتحدد/يتغيّر */
function scheduleAuctionTicketAutoClose(scheduleId: number, ticketCh: TextChannel | null | undefined, delayMs: number): void {
  const existing = pendingAuctionTicketAutoClose.get(scheduleId);
  if (existing) clearTimeout(existing);
  const timeoutId = setTimeout(() => {
    pendingAuctionTicketAutoClose.delete(scheduleId);
    if (ticketCh) ticketCh.delete("Auction ticket auto-closed after scheduling").catch(() => {});
  }, delayMs);
  pendingAuctionTicketAutoClose.set(scheduleId, timeoutId);
}

/** بيلغي أي إقفال تلقائي مجدول لتذكرة مزاد (مثلاً وقت ما اليوزر يضغط "تغيير الميعاد") */
function cancelAuctionTicketAutoClose(scheduleId: number): void {
  const existing = pendingAuctionTicketAutoClose.get(scheduleId);
  if (existing) {
    clearTimeout(existing);
    pendingAuctionTicketAutoClose.delete(scheduleId);
  }
}

/** بيبعت تذكير لصاحب المزاد قبل الميعاد بنص ساعة — DM، ولو مقفول يمنشنه في شانل الأوامر */
async function sendAuctionReminder(
  guild: Guild,
  sched: { discordUserId: string; auctionType: string; scheduledHour: number | null; roomChannelId: string | null; itemDescription: string | null },
): Promise<void> {
  const typeCfg = AUCTION_TYPES[sched.auctionType as AuctionType];
  const text =
    `⏰ **تذكير: مزادك بعد نص ساعة!**\n\n` +
    `${typeCfg?.emoji ?? ""} **${typeCfg?.label ?? sched.auctionType}**\n` +
    (sched.scheduledHour != null ? `⏰ الموعد: **${hourToLabel(sched.scheduledHour)}**\n` : "") +
    (sched.roomChannelId ? `📍 الروم: <#${sched.roomChannelId}>\n` : "") +
    (sched.itemDescription ? `📦 المزاد على: ${sched.itemDescription}\n` : "") +
    `\nاستعد! 🎉`;

  let dmSent = false;
  try {
    const user = await guild.client.users.fetch(sched.discordUserId);
    await user.send({ content: text });
    dmSent = true;
  } catch {
    dmSent = false;
  }

  if (!dmSent) {
    try {
      const fallbackCh = await guild.channels.fetch(REACTIVATION_CHANNEL_ID).catch(() => null) as TextChannel | null;
      await fallbackCh?.send({ content: `<@${sched.discordUserId}>\n${text}` });
    } catch { /* ignore */ }
  }
}

/** ساعة (0–23) → نص قصير مقروء مثل "12ص" / "3م" */
function hourToLabel(h: number): string {
  if (h === 0)  return "12ص";
  if (h === 12) return "12م";
  return h < 12 ? `${h}ص` : `${h - 12}م`;
}

/** قفل شانل المزاد — يمنع الإرسال ويبقي الرؤية */
async function lockAuctionRoom(guild: Guild, channelId: string): Promise<void> {
  const ch = guild.channels.cache.get(channelId);
  if (!ch || ch.type !== ChannelType.GuildText) return;
  await (ch as TextChannel).permissionOverwrites
    .edit(guild.roles.everyone, { SendMessages: false, AddReactions: false })
    .catch(() => {});
}

/** فتح شانل المزاد — يسمح للكل بالإرسال والتفاعل */
async function unlockAuctionRoom(guild: Guild, channelId: string): Promise<void> {
  const ch = guild.channels.cache.get(channelId);
  if (!ch || ch.type !== ChannelType.GuildText) return;
  await (ch as TextChannel).permissionOverwrites
    .edit(guild.roles.everyone, { SendMessages: true, AddReactions: true })
    .catch(() => {});
}

/** بيقفل الروم ويمسح الشات بعده بـ10 دقايق — مشترك بين الإنهاء الطبيعي والقسري */
async function lockAndScheduleAuctionCleanup(guild: Guild, ch: TextChannel): Promise<void> {
  await lockAuctionRoom(guild, ch.id);
  setTimeout(async () => {
    try {
      let msgs = await ch.messages.fetch({ limit: 100 });
      while (msgs.size > 0) {
        await ch.bulkDelete(msgs, true).catch(() => {});
        if (msgs.size < 100) break;
        msgs = await ch.messages.fetch({ limit: 100 });
      }
      logger.info({ channelId: ch.id }, "Auction channel cleared after 10 min");
    } catch (err) {
      logger.error({ err, channelId: ch.id }, "Failed to clear auction channel");
    }
  }, 10 * 60 * 1000);
}

/**
 * إنهاء المزاد لما الأدمن يكتب "مبروك @الفايز" في روم المزاد.
 * 1. يعلن الفائز.
 * 2. يقفل الروم.
 * 3. بعد 10 دقايق: يمسح الشات ويستعد للمزاد اللي بعده.
 */
async function endAuctionManual(guild: Guild, channelId: string, winnerUserId: string): Promise<void> {
  const auction = activeAuctions.get(channelId);
  if (!auction) return;
  activeAuctions.delete(channelId);

  const ch = guild.channels.cache.get(channelId) as TextChannel | undefined;
  if (!ch) return;

  const guildIconURL = guild.iconURL({ extension: "png", size: 256 }) ?? undefined;
  const DIV_END       = "ـﮩ════════════════ﮩـ";

  const endEmbed = new EmbedBuilder()
    .setAuthor({ name: "Dragon $hop", iconURL: guildIconURL })
    .setTitle("🎉 انتهى المزاد!")
    .setColor(0x00ff88)
    .addFields({
      name:  `${STAR_EMOJI} الفائز`,
      value: `> 👑 <@${winnerUserId}>\n> ${DIV_END}`,
      inline: false,
    })
    .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: guildIconURL });

  const endFiles: AttachmentBuilder[] = [];
  if (fs.existsSync(DRAGON_BANNER_PATH)) {
    endFiles.push(new AttachmentBuilder(DRAGON_BANNER_PATH, { name: "dragon_banner.webp" }));
    endEmbed.setImage("attachment://dragon_banner.webp");
  }

  await ch.send({ embeds: [endEmbed], files: endFiles }).catch(() => {});

  await db.update(auctionSchedulesTable).set({
    status:       "completed",
    winnerUserId,
  }).where(eq(auctionSchedulesTable.id, auction.scheduleId)).catch(() => {});

  await lockAndScheduleAuctionCleanup(guild, ch);
  logger.info({ channelId, winnerUserId, scheduleId: auction.scheduleId }, "Auction ended manually by admin");
}

/**
 * إقفال قسري لمزاد لسه شغال بعد ما مواعيد اليوم خلصت (AUCTION_DAY_END_HOUR)
 * من غير ما الأدمن يعلن فايز. مفيش تحديد فايز هنا — الأدمن هيحدده بنفسه بره البوت.
 */
async function forceCloseAuctionTimeUp(guild: Guild, channelId: string): Promise<void> {
  const auction = activeAuctions.get(channelId);
  if (!auction) return;
  activeAuctions.delete(channelId);

  const ch = guild.channels.cache.get(channelId) as TextChannel | undefined;
  if (!ch) return;

  await ch.send({
    content: "⏰ **انتهى وقت المزاد لهذا اليوم!** الأدمن سيحدد الفائز مباشرة.",
  }).catch(() => {});

  await db.update(auctionSchedulesTable).set({
    status: "completed",
  }).where(eq(auctionSchedulesTable.id, auction.scheduleId)).catch(() => {});

  await lockAndScheduleAuctionCleanup(guild, ch);
  logger.info({ channelId, scheduleId: auction.scheduleId }, "Auction force-closed — day ended without admin declaring a winner");
}

/**
 * تشغيل مزاد:
 * 1. يحدّث الستاتوس لـ active (عشان الـ scheduler ما يشغّله تاني).
 * 2. يفتح الروم.
 * 3. يبعت رسالة البداية.
 * 4. يبدأ عداد دقيقتين صمت.
 */
async function startAuction(
  guild: Guild,
  schedule: {
    id: number; auctionType: string; discordUserId: string; roomChannelId: string;
    sellingPrice?: string | null; itemDescription?: string | null; paymentMethod?: string | null;
  },
): Promise<void> {
  const channelId = schedule.roomChannelId;
  const aType     = schedule.auctionType as AuctionType;
  const typeCfg   = AUCTION_TYPES[aType];
  if (!typeCfg) return;

  // أولاً: حدّث ستاتوس لـ active لمنع التشغيل المزدوج
  await db.update(auctionSchedulesTable)
    .set({ status: "active" })
    .where(eq(auctionSchedulesTable.id, schedule.id))
    .catch(() => {});

  await unlockAuctionRoom(guild, channelId);

  const ch = guild.channels.cache.get(channelId) as TextChannel | undefined;
  if (!ch) return;

  const mentionText =
    aType === "everyone" ? "@everyone" :
    aType === "here"     ? "@here"     : `<@&${AUCTION_ROLE_ID}>`;

  // ── إعلان بيع (mention-only) — بيختلف عن مزاد المزايدة ────────────────
  if (schedule.sellingPrice) {
    const guildIconURL = guild.iconURL({ extension: "png", size: 256 }) ?? undefined;
    const DIV_ANN = "ـﮩ════════════════ﮩـ";
    const annEmbed = new EmbedBuilder()
      .setAuthor({ name: "Dragon $hop", iconURL: guildIconURL })
      .setTitle(`${typeCfg.emoji} إعلان مزاد!`)
      .setColor(0xffd700)
      .addFields(
        {
          name:  `${STAR_EMOJI} البائع`,
          value: `> 👤 <@${schedule.discordUserId}>\n> ${DIV_ANN}`,
          inline: false,
        },
        {
          name:  `${STAR_EMOJI} المنشن`,
          value: `> ${typeCfg.emoji} **${typeCfg.label}**\n> ${DIV_ANN}`,
          inline: false,
        },
        {
          name:  `${STAR_EMOJI} العكلة`,
          value: `> 💰 **${schedule.sellingPrice}**\n> ${DIV_ANN}`,
          inline: false,
        },
        {
          name:  `${STAR_EMOJI} للشراء`,
          value: `> 📩 تواصل مع <@${schedule.discordUserId}> مباشرة\n> ${DIV_ANN}`,
          inline: false,
        },
      )
      .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: guildIconURL });

    const annFiles: AttachmentBuilder[] = [];
    if (fs.existsSync(DRAGON_BANNER_PATH)) {
      annFiles.push(new AttachmentBuilder(DRAGON_BANNER_PATH, { name: "dragon_banner.webp" }));
      annEmbed.setImage("attachment://dragon_banner.webp");
    }

    await ch.send({ content: mentionText, embeds: [annEmbed], files: annFiles });

    // أكمل الحجز كـ completed
    await db.update(auctionSchedulesTable)
      .set({ status: "completed" })
      .where(eq(auctionSchedulesTable.id, schedule.id))
      .catch(() => {});

    // قفل الروم بعد 30 دقيقة وتنظيفه
    setTimeout(async () => {
      await lockAuctionRoom(guild, channelId);
      try {
        let msgs = await ch.messages.fetch({ limit: 100 });
        while (msgs.size > 0) {
          await ch.bulkDelete(msgs, true).catch(() => {});
          if (msgs.size < 100) break;
          msgs = await ch.messages.fetch({ limit: 100 });
        }
      } catch { /* ignore */ }
    }, 30 * 60 * 1000);

    logger.info({ scheduleId: schedule.id, channelId, aType, sellingPrice: schedule.sellingPrice }, "Auction announcement sent (mention-only)");
    return;
  }

  // ── مزاد بإدارة الأدمن يدوياً (بدون مزايدة تلقائية بالأرقام) ─────────────
  const guildIconURL2 = guild.iconURL({ extension: "png", size: 256 }) ?? undefined;
  const DIV_BID = "ـﮩ════════════════ﮩـ";
  const bidEmbed = new EmbedBuilder()
    .setAuthor({ name: "Dragon $hop", iconURL: guildIconURL2 })
    .setTitle(`${typeCfg.emoji} بدأ المزاد!`)
    .setColor(0xff4500)
    .addFields(
      ...(schedule.itemDescription ? [{
        name:  `${STAR_EMOJI} المزاد على`,
        value: `> 📦 ${schedule.itemDescription}\n> ${DIV_BID}`,
        inline: false,
      }] : []),
      ...(schedule.paymentMethod ? [{
        name:  `${STAR_EMOJI} طرق الدفع المطلوبة`,
        value: `> 💳 ${schedule.paymentMethod}\n> ${DIV_BID}`,
        inline: false,
      }] : []),
    )
    .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: guildIconURL2 });

  const bidFiles: AttachmentBuilder[] = [];
  if (fs.existsSync(DRAGON_BANNER_PATH)) {
    bidFiles.push(new AttachmentBuilder(DRAGON_BANNER_PATH, { name: "dragon_banner.webp" }));
    bidEmbed.setImage("attachment://dragon_banner.webp");
  }

  await ch.send({
    content: `${mentionText} <@&${AUCTION_MANAGER_ROLE_ID}> <@${schedule.discordUserId}>`,
    embeds:  [bidEmbed],
    files:   bidFiles,
  });

  activeAuctions.set(channelId, {
    scheduleId:  schedule.id,
    auctionType: aType,
    startedAt:   Date.now(),
  });

  logger.info({ scheduleId: schedule.id, channelId, aType }, "Auction started (manual — admin-managed)");
}

/**
 * Scheduler — بيتشغل كل 30 ثانية بدقة الدقيقة (لدعم التذكيرات والتأجيل).
 * - قبل الميعاد بنص ساعة: يبعت تذكير (مرة واحدة).
 * - لو الميعاد جه والروم مشغول بمزاد سابق: يأجّل 15 دقيقة (تراكمي، بيتكرر لحد ما الروم يفضى).
 * - لو الميعاد جه والروم فاضي: يشغّل المزاد.
 * - لو مزاد شغال ودخلنا وقت إقفال اليوم (AUCTION_DAY_END_HOUR) من غير ما الأدمن يعلن فايز: إقفال قسري.
 */
function startAuctionScheduler(guild: Guild): void {
  setInterval(async () => {
    try {
      const { date, hour, minute } = getCairoTime();
      const nowMin = hour * 60 + minute;

      const todaySchedules = await db.select().from(auctionSchedulesTable).where(
        and(
          eq(auctionSchedulesTable.scheduledDate, date),
          inArray(auctionSchedulesTable.status, ["scheduled", "active"]),
        ),
      );

      for (const sched of todaySchedules) {
        if (!sched.roomChannelId || sched.scheduledHour == null) continue;
        const effectiveStartMin = sched.scheduledHour * 60 + (sched.delayMinutes ?? 0);
        const roomBusy = activeAuctions.has(sched.roomChannelId);

        if (sched.status === "scheduled") {
          const minutesLeft = effectiveStartMin - nowMin;

          if (minutesLeft > 0) {
            if (!sched.reminded && minutesLeft <= 30) {
              await sendAuctionReminder(guild, sched).catch((e) => logger.error({ e }, "sendAuctionReminder error"));
              await db.update(auctionSchedulesTable)
                .set({ reminded: true })
                .where(eq(auctionSchedulesTable.id, sched.id))
                .catch(() => {});
            }
            continue;
          }

          // الميعاد جه أو فات
          if (roomBusy) {
            // الروم لسه مشغول بمزاد سابق → أجّل ربع ساعة وكرر الفحص تاني
            await db.update(auctionSchedulesTable)
              .set({ delayMinutes: (sched.delayMinutes ?? 0) + 15 })
              .where(eq(auctionSchedulesTable.id, sched.id))
              .catch(() => {});
            logger.info({ scheduleId: sched.id, roomChannelId: sched.roomChannelId }, "Auction delayed 15 min — room busy");
            continue;
          }

          await startAuction(guild, {
            id:               sched.id,
            auctionType:      sched.auctionType,
            discordUserId:    sched.discordUserId,
            roomChannelId:    sched.roomChannelId,
            sellingPrice:     sched.sellingPrice,
            itemDescription:  sched.itemDescription,
            paymentMethod:    sched.paymentMethod,
          });
          continue;
        }

        if (sched.status === "active" && roomBusy && hour >= AUCTION_DAY_END_HOUR) {
          await forceCloseAuctionTimeUp(guild, sched.roomChannelId).catch((e) => logger.error({ e }, "forceCloseAuctionTimeUp error"));
        }
      }
    } catch (err) {
      logger.error({ err }, "Auction scheduler error");
    }
  }, 30_000);
}

/** بيرجع اسم اليوم بالعربي من تاريخ (YYYY-MM-DD) */
function dateToArabicDay(dateStr: string): string {
  const arabicDayNames = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
  const d = new Date(`${dateStr}T00:00:00Z`);
  return arabicDayNames[d.getUTCDay()] ?? dateStr;
}

/**
 * بيبني إمبيد المواعيد المحجوزة — بيعرض كل الأيام من النهارده وما بعده
 * اللي عندها مواعيد (scheduled / active). الأيام بتتجمّع في سيكشنات.
 */
async function buildScheduleEmbed(): Promise<EmbedBuilder> {
  const { date: today } = getCairoTime();

  // جلب كل المواعيد النشطة أو المجدولة
  const allSchedules = await db
    .select()
    .from(auctionSchedulesTable)
    .where(inArray(auctionSchedulesTable.status, ["scheduled", "active"]));

  // الأيام من النهارده وما بعده، مرتبة
  const upcoming = allSchedules
    .filter((s) => s.scheduledDate != null && s.scheduledDate >= today && s.scheduledHour != null)
    .sort((a, b) => {
      const dc = (a.scheduledDate ?? "").localeCompare(b.scheduledDate ?? "");
      return dc !== 0 ? dc : (a.scheduledHour ?? 0) - (b.scheduledHour ?? 0);
    });

  const statusEmoji: Record<string, string> = { scheduled: "✅", active: "🔴" };
  const typeEmoji:   Record<string, string> = { everyone: "📢", here: "📣", offers: "🔔" };

  const embed = new EmbedBuilder()
    .setTitle("📅 جدول مزادات Dragon $hop")
    .setColor(0x5865f2)
    .setFooter({ text: `آخر تحديث: ${new Date().toLocaleTimeString("ar-EG", { timeZone: "Africa/Cairo" })}` });

  if (upcoming.length === 0) {
    embed.setDescription("📭 لا توجد مزادات مجدولة حالياً.");
    return embed;
  }

  // تجميع حسب اليوم
  const byDate = new Map<string, typeof upcoming>();
  for (const s of upcoming) {
    const key = s.scheduledDate!;
    if (!byDate.has(key)) byDate.set(key, []);
    byDate.get(key)!.push(s);
  }

  for (const [date, daySchedules] of byDate) {
    const dayLabel = `${dateToArabicDay(date)} — ${date}${date === today ? " (اليوم)" : ""}`;
    const lines = daySchedules.map((s) => {
      const st   = statusEmoji[s.status] ?? "❓";
      const te   = typeEmoji[s.auctionType] ?? "";
      const room = s.roomChannelId ? ` | <#${s.roomChannelId}>` : "";
      const item = s.itemDescription ? ` | 📦 ${s.itemDescription}` : "";
      return `${st} **${hourToLabel(s.scheduledHour ?? 0)}** ${te} <@${s.discordUserId}>${room}${item}`;
    });
    embed.addFields({ name: dayLabel, value: lines.join("\n"), inline: false });
  }

  return embed;
}

/**
 * يحدّث لوحة جدول المزادات في شانل معلومات المزاد.
 * - withMention=true → يحذف الرسالة القديمة وينزل جديدة مع منشن @مزاد
 *   (لما يتحجز مزاد جديد).
 * - withMention=false → يعدّل الرسالة الموجودة بهدوء (تحديثات روتينية).
 */
async function refreshAuctionScheduleMsg(guild: Guild, withMention = false): Promise<void> {
  try {
    const infoCh = await guild.channels.fetch(AUCTION_INFO_CHANNEL_ID).catch(() => null) as TextChannel | null;
    if (!infoCh) return;

    const embed = await buildScheduleEmbed();

    // لو طلبنا منشن: احذف القديمة وانزل جديدة
    if (withMention) {
      if (auctionScheduleMsgId) {
        await infoCh.messages.delete(auctionScheduleMsgId).catch(() => {});
        auctionScheduleMsgId = null;
      }
      const sent = await infoCh.send({
        content: `<@&${AUCTION_ROLE_ID}> 📅 تم تحديث جدول المزادات!`,
        embeds:  [embed],
      });
      auctionScheduleMsgId = sent.id;
      return;
    }

    // تحديث صامت — عدّل الموجودة أو انزل جديدة بدون منشن
    if (auctionScheduleMsgId) {
      const existing = await infoCh.messages.fetch(auctionScheduleMsgId).catch(() => null);
      if (existing) {
        await existing.edit({ embeds: [embed] });
        return;
      }
      auctionScheduleMsgId = null;
    }

    const sent = await infoCh.send({ embeds: [embed] });
    auctionScheduleMsgId = sent.id;
  } catch (err) {
    logger.error({ err }, "refreshAuctionScheduleMsg error");
  }
}

/**
 * بعد ما اليوزر يخلص الإجابة على الأسئلة (أو يتخطى السؤال الاختياري):
 * 1. يدوّر على أقرب ميعاد فاضي ويحدده تلقائياً.
 * 2. يبعت رسالة بالميعاد + زرار "تغيير الميعاد".
 * 3. يجدول إقفال التذكرة تلقائياً بعد دقيقة (يتلغي لو اليوزر ضغط تغيير الميعاد).
 */
async function finalizeAuctionSlot(
  guild: Guild,
  sched: { id: number; ticketChannelId: string | null },
): Promise<void> {
  const ticketCh = sched.ticketChannelId
    ? (guild.channels.cache.get(sched.ticketChannelId) as TextChannel | undefined)
    : undefined;

  const slot = await findNextAvailableAuctionSlot();
  if (!slot) {
    await ticketCh?.send("❌ مفيش مواعيد متاحة حالياً في الأيام الجاية. هيتواصل معاك الأدمن لتحديد ميعادك يدوياً.").catch(() => {});
    return;
  }

  await db.update(auctionSchedulesTable)
    .set({
      scheduledDate: slot.date,
      scheduledHour: slot.hour,
      roomChannelId: slot.roomChannelId,
      status:        "scheduled",
      delayMinutes:  0,
      reminded:      false,
    })
    .where(eq(auctionSchedulesTable.id, sched.id));

  const changeBtn = new ButtonBuilder()
    .setCustomId(`aucchangeslot_${sched.id}`)
    .setLabel("🔁 تغيير الميعاد")
    .setStyle(ButtonStyle.Primary);

  await ticketCh?.send({
    content:
      `✅ **تم تحديد ميعاد مزادك!**\n\n` +
      `⏰ الموعد: **${hourToLabel(slot.hour)}** — ${slot.date} (توقيت القاهرة)\n` +
      `📍 الروم: <#${slot.roomChannelId}>\n\n` +
      `مش عاجبك الميعاد؟ دوس على الزرار تحت ⬇️`,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(changeBtn)],
  }).catch(() => {});

  await refreshAuctionScheduleMsg(guild, true).catch(() => {});

  // اقفل التذكرة تلقائياً بعد دقيقة، إلا لو اليوزر ضغط "تغيير الميعاد"
  scheduleAuctionTicketAutoClose(sched.id, ticketCh, 60_000);
}

// ══════════════════════════════════════════════════════════════════════════════
//  syncStaticRooms — مزامنة الرومات مع DB
//  NOTE: بيتنادى كل ما البوت يشتغل (ClientReady).
//        لو الروم موجود في DB: بيعدّل البيانات (السعر / المنشنات / الـ CategoryID).
//        لو مش موجود: بيعمله insert جديد.
//        ده بيضمن إن أي تعديل في STATIC_ROOMS يتطبق تلقائياً على DB بعد restart.
// ══════════════════════════════════════════════════════════════════════════════
async function syncStaticRooms(): Promise<void> {
  for (const [category, rooms] of Object.entries(STATIC_ROOMS)) {
    for (const room of rooms) {
      const existing = await db
        .select()
        .from(roomsTable)
        .where(and(eq(roomsTable.name, room.name), eq(roomsTable.category, category)))
        .then((r) => r[0]);

      if (existing) {
        await db
          .update(roomsTable)
          .set({
            price:             String(room.price),
            decorations:       room.decorations,
            offersCount:       room.offersCount,
            hereCount:         room.hereCount,
            everyoneCount:     room.everyoneCount,
            discordCategoryId: room.discordCategoryId,
          })
          .where(eq(roomsTable.id, existing.id));
      } else {
        await db.insert(roomsTable).values({
          name:              room.name,
          category,
          price:             String(room.price),
          decorations:       room.decorations,
          offersCount:       room.offersCount,
          hereCount:         room.hereCount,
          everyoneCount:     room.everyoneCount,
          discordCategoryId: room.discordCategoryId,
        });
      }
    }
  }
  logger.info("Static rooms synced to DB");
}

// ══════════════════════════════════════════════════════════════════════════════
//  sendShopPanel — بانل المتجر الرئيسي
//  NOTE: بيتبعت في الشانل اللي فيه /shop.
//        مش ephemeral — كل الناس بيشوفوه.
//        بيعمل زرار لكل فئة في SHOP_CATEGORIES.
// ══════════════════════════════════════════════════════════════════════════════
async function sendShopPanel(channel: TextChannel) {
  const description =
    `جميع الأسعار لكل نوع يمكنك ضغط الأسفل ${MONEY_EMOJI}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `لرؤية الأسعار :\n\n` +
    SHOP_CATEGORIES.map((cat) => `${MONEY_EMOJI} **أسعار ${cat}**`).join("\n") +
    `\n\n━━━━━━━━━━━━━━━━━━━━`;

  const categoryButtons = SHOP_CATEGORIES.map((cat) =>
    new ButtonBuilder()
      .setCustomId(`shopcat_${cat}`)
      .setLabel(`أسعار ${cat}`)
      .setStyle(ButtonStyle.Secondary)
      .setEmoji({ id: "1496143576759930901", name: "yellowstar", animated: true })
  );

  // تقسيم الأزرار على ActionRows (max 5 أزرار لكل row)
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < categoryButtons.length; i += 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...categoryButtons.slice(i, i + 5)));
  }

  const files: AttachmentBuilder[] = [];
  const guildIconURL = channel.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;

  const embed = new EmbedBuilder()
    .setAuthor({ name: "Dragon $hop", iconURL: guildIconURL })
    .setDescription(description)
    .setColor(0x00bfff)
    .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p" });

  // أضف بانر لو موجود (dragon_banner.webp)
  if (fs.existsSync(DRAGON_BANNER_PATH)) {
    files.push(new AttachmentBuilder(DRAGON_BANNER_PATH, { name: "dragon_banner.webp" }));
    embed.setImage("attachment://dragon_banner.webp");
  }

  await channel.send({ embeds: [embed], files, components: rows });
}

// ══════════════════════════════════════════════════════════════════════════════
//  sendBuyPanel — بانل الشراء المباشر (/buy)
//  NOTE: نفس فئات SHOP_CATEGORIES وشكل البانل بتاع sendShopPanel بالظبط،
//        لكن الأزرار هنا customId = buycat_<category> بدل shopcat_<category>
//        عشان تودّي على طول لخطوة الدفع من غير عرض سعر قبلها.
// ══════════════════════════════════════════════════════════════════════════════
async function sendBuyPanel(channel: TextChannel) {
  const description =
    `اضغط على أي فئة تحت عشان تشتري على طول من غير عرض سعر ${MONEY_EMOJI}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `للشراء المباشر :\n\n` +
    SHOP_CATEGORIES.map((cat) => `${MONEY_EMOJI} **شراء ${cat}**`).join("\n") +
    `\n\n━━━━━━━━━━━━━━━━━━━━`;

  const categoryButtons = SHOP_CATEGORIES.map((cat) =>
    new ButtonBuilder()
      .setCustomId(`buycat_${cat}`)
      .setLabel(`شراء ${cat}`)
      .setStyle(ButtonStyle.Secondary)
      .setEmoji(BUY_EMOJI)
  );

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let i = 0; i < categoryButtons.length; i += 5) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...categoryButtons.slice(i, i + 5)));
  }

  const files: AttachmentBuilder[] = [];
  const guildIconURL = channel.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;

  const embed = new EmbedBuilder()
    .setAuthor({ name: "Dragon $hop", iconURL: guildIconURL })
    .setDescription(description)
    .setColor(0x2ecc71)
    .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p" });

  if (fs.existsSync(DRAGON_BANNER_PATH)) {
    files.push(new AttachmentBuilder(DRAGON_BANNER_PATH, { name: "dragon_banner.webp" }));
    embed.setImage("attachment://dragon_banner.webp");
  }

  await channel.send({ embeds: [embed], files, components: rows });
}

// ══════════════════════════════════════════════════════════════════════════════
//  createAutoPublishTicket — بيفتح تذكرة نشر تلقائي ويسيب اليوزر يختار المدة
//  NOTE: ده هو "الشراء الفعلي" لإضافة النشر التلقائي — بيتنادى من
//        quickbuy_addon_auto_publish (قائمة الشراء المنفصلة). الشروط
//        (عنده متجر / مفيش نشر شغال أو معلق) لازم تتحقق قبل ما تنادي الدالة دي.
// ══════════════════════════════════════════════════════════════════════════════
async function createAutoPublishTicket(
  interaction: import("discord.js").ButtonInteraction,
  guild: import("discord.js").Guild,
  userId: string,
  username: string,
) {
  const ticketChannel = await guild.channels.create({
    name:   `publish-${username}`,
    type:   ChannelType.GuildText,
    parent: TICKETS_CATEGORY_ID,
    permissionOverwrites: [
      { id: guild.id,             deny:  [PermissionFlagsBits.ViewChannel] },
      { id: userId,               allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      { id: guild.roles.everyone, deny:  [PermissionFlagsBits.ViewChannel] },
    ],
  });

  const DIV_AP  = "ـﮩ════════════════ﮩـ";
  const gIAP    = guild.iconURL({ extension: "png", size: 256 }) ?? undefined;

  const apEmbed = new EmbedBuilder()
    .setAuthor({ name: "Dragon $hop", iconURL: gIAP })
    .setTitle(`📢 النشر التلقائي في متجرك`)
    .setDescription(`<@${userId}> ${MONEY_EMOJI}\n> ${DIV_AP}`)
    .setColor(0x9b59b6)
    .addFields(
      {
        name:  `${STAR_EMOJI} السعر`,
        value: `> ${MONEY_EMOJI} **${AUTO_PUBLISH_PRICE_PER_DAY.toLocaleString()}** كريدت / يوم\n> ${DIV_AP}`,
        inline: false,
      },
      {
        name:  `${STAR_EMOJI} الخطوة التالية`,
        value: `> اختار المدة من القائمة تحت ⬇️\n> ${DIV_AP}`,
        inline: false,
      },
    )
    .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: gIAP });

  const apFiles: AttachmentBuilder[] = [];
  if (fs.existsSync(DRAGON_TEXT_BANNER_PATH)) {
    apFiles.push(new AttachmentBuilder(DRAGON_TEXT_BANNER_PATH, { name: "dragon_text_banner.webp" }));
    apEmbed.setImage("attachment://dragon_text_banner.webp");
  }

  const durationSelect = new StringSelectMenuBuilder()
    .setCustomId(`autopub_duration_${userId}`)
    .setPlaceholder("⏱ اختار المدة")
    .addOptions(
      new StringSelectMenuOptionBuilder().setLabel("يوم واحد").setValue("1").setDescription(`${calcTransferAmount(AUTO_PUBLISH_PRICE_PER_DAY * 1).toLocaleString()} كريدت`).setEmoji("1️⃣"),
      new StringSelectMenuOptionBuilder().setLabel("يومين").setValue("2").setDescription(`${calcTransferAmount(AUTO_PUBLISH_PRICE_PER_DAY * 2).toLocaleString()} كريدت`).setEmoji("2️⃣"),
      new StringSelectMenuOptionBuilder().setLabel("3 أيام").setValue("3").setDescription(`${calcTransferAmount(AUTO_PUBLISH_PRICE_PER_DAY * 3).toLocaleString()} كريدت`).setEmoji("3️⃣"),
      new StringSelectMenuOptionBuilder().setLabel("4 أيام").setValue("4").setDescription(`${calcTransferAmount(AUTO_PUBLISH_PRICE_PER_DAY * 4).toLocaleString()} كريدت`).setEmoji("4️⃣"),
      new StringSelectMenuOptionBuilder().setLabel("5 أيام").setValue("5").setDescription(`${calcTransferAmount(AUTO_PUBLISH_PRICE_PER_DAY * 5).toLocaleString()} كريدت`).setEmoji("5️⃣"),
      new StringSelectMenuOptionBuilder().setLabel("6 أيام").setValue("6").setDescription(`${calcTransferAmount(AUTO_PUBLISH_PRICE_PER_DAY * 6).toLocaleString()} كريدت`).setEmoji("6️⃣"),
      new StringSelectMenuOptionBuilder().setLabel("أسبوع كامل (7 أيام)").setValue("7").setDescription(`${calcTransferAmount(AUTO_PUBLISH_PRICE_PER_DAY * 7).toLocaleString()} كريدت`).setEmoji("7️⃣"),
    );

  await ticketChannel.send({
    content:    `<@${userId}>`,
    embeds:     [apEmbed],
    files:      apFiles,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(durationSelect)],
  });

  await interaction.editReply({ content: `✅ افتحت لك تذكرة في <#${ticketChannel.id}> — اختار المدة من هناك!` });
}

// ══════════════════════════════════════════════════════════════════════════════
//  ClientReady — عند تشغيل البوت
// ══════════════════════════════════════════════════════════════════════════════
client.once(Events.ClientReady, async () => {
  try {
  logger.info({ username: client.user?.tag }, "Discord bot is ready");

  // ── تسجيل Slash Commands ──────────────────────────────────────────────────
  // NOTE: الأوامر بتتسجل على مستوى السيرفر (Guild Commands) مش Global.
  //       ده بيخليها تظهر فوراً بدون الانتظار 1 ساعة اللي بياخدها Global Commands.
  //       لو عايز تنقلها لـ Global: غير Routes.applicationGuildCommands لـ Routes.applicationCommands
  const commands = [
    // ── أوامر عامة ──────────────────────────────────────────────────────────
    new SlashCommandBuilder()
      .setName("shop")
      .setDescription("افتح بانل أسعار المتجر (عرض بس، من غير شراء)"),

    new SlashCommandBuilder()
      .setName("buy")
      .setDescription("افتح بانل الشراء المباشر"),

    new SlashCommandBuilder()
      .setName("myroom")
      .setDescription("شوف الرومات اللي عندك"),

    new SlashCommandBuilder()
      .setName("transferroom")
      .setDescription("حول ملكية الروم لشخص تاني")
      .addUserOption((o) =>
        o.setName("user").setDescription("الشخص اللي هتحول له الروم").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("room").setDescription("اسم الروم").setRequired(true)
      ),

    // ── أوامر الأونر/Admin ────────────────────────────────────────────────
    new SlashCommandBuilder()
      .setName("addroom")
      .setDescription("👑 [أونر] أضف نوع روم جديد للمتجر")
      .addStringOption((o) => o.setName("name").setDescription("اسم نوع الروم").setRequired(true))
      .addStringOption((o) => o.setName("category").setDescription("الكاتيجوري").setRequired(true))
      .addNumberOption((o) => o.setName("price").setDescription("السعر الصافي (بدون عمولة ProBot)").setRequired(true))
      .addStringOption((o) => o.setName("decorations").setDescription("الزخارف (إيموجي)").setRequired(false))
      .addStringOption((o) => o.setName("category_id").setDescription("Discord Category ID").setRequired(false))
      .addIntegerOption((o) => o.setName("offers").setDescription("عدد منشنات @offers").setRequired(false))
      .addIntegerOption((o) => o.setName("here").setDescription("عدد منشنات @here").setRequired(false))
      .addIntegerOption((o) => o.setName("everyone").setDescription("عدد منشنات @everyone").setRequired(false)),

    new SlashCommandBuilder()
      .setName("listrooms")
      .setDescription("👑 [أونر] شوف كل الرومات في DB"),

    new SlashCommandBuilder()
      .setName("synccategories")
      .setDescription("👑 [أونر] اعرض ربط الرومات بالكاتيجوريهات"),

    new SlashCommandBuilder()
      .setName("setcategoryid")
      .setDescription("👑 [أونر] اربط روم بكاتيجوري موجودة")
      .addIntegerOption((o) =>
        o.setName("room_id").setDescription("ID الروم (من /listrooms)").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("category_id").setDescription("Discord Category ID").setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("deleteroom")
      .setDescription("👑 [أونر] احذف نوع روم من المتجر")
      .addIntegerOption((o) =>
        o.setName("id").setDescription("ID الروم (من /listrooms)").setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("setaddonprice")
      .setDescription("👑 [أونر] حدد سعر إضافة معينة")
      .addStringOption((o) =>
        o.setName("addon")
          .setDescription("الإضافة")
          .setRequired(true)
          // الـ choices بتتجنى تلقائياً من ADDONS array
          // NOTE: Discord بيسمح بحد أقصى 25 choice لكل option
          //       الإضافات دلوقتي 21 فما فيش مشكلة، لو زادت عن 25 ستحتاج نهج تاني
          .addChoices(...ADDONS.map((a) => ({ name: a.label, value: a.key })))
      )
      .addNumberOption((o) =>
        o.setName("price").setDescription("السعر (كريدت) — رقم موجب").setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("givebalance")
      .setDescription("👑 [أونر] أضف رصيد منشنات ليوزر")
      .addUserOption((o) => o.setName("user").setDescription("اليوزر").setRequired(true))
      .addStringOption((o) =>
        o.setName("type")
          .setDescription("نوع المنشن")
          .setRequired(true)
          .addChoices(
            { name: "@offers",   value: "offers" },
            { name: "@here",     value: "here" },
            { name: "@everyone", value: "everyone" },
            { name: "طلبيات",    value: "orders" },
            { name: "مزاد",      value: "auction" },
          )
      )
      .addIntegerOption((o) =>
        o.setName("amount").setDescription("الكمية المراد إضافتها").setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("warnstore")
      .setDescription("👑 [أونر] حذّر صاحب متجر")
      .addUserOption((o) =>
        o.setName("user").setDescription("صاحب المتجر").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("reason").setDescription("سبب التحذير").setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("stopautopublish")
      .setDescription("🛑 [أدمن] يوقف النشر التلقائي الشغّال لمتجر معيّن")
      .addUserOption((o) =>
        o.setName("user").setDescription("صاحب المتجر").setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName("storestatus")
      .setDescription("👑 [أونر/أدمن] فعّل أو ألغِ تفعيل متجر يدويًا بدون رسوم")
      .addUserOption((o) =>
        o.setName("user").setDescription("صاحب المتجر").setRequired(true)
      )
      .addStringOption((o) =>
        o.setName("action")
          .setDescription("الإجراء")
          .setRequired(true)
          .addChoices(
            { name: "✅ تفعيل",       value: "activate" },
            { name: "🚫 إلغاء تفعيل", value: "deactivate" },
          )
      ),

    new SlashCommandBuilder()
      .setName("storerules")
      .setDescription("👑 [أونر/أدمن] ابعت إمبيد الخط وقوانين المتاجر في هذا الروم"),

    // ── أوامر أكواد البروموشن (Promo Codes) ──────────────────────────────────
    new SlashCommandBuilder()
      .setName("addpromocode")
      .setDescription("👑 [أونر/أدمن] أنشئ كود خصم جديد")
      .addStringOption((o) => o.setName("code").setDescription("الكود (بالإنجليزي/أرقام)").setRequired(true))
      .addIntegerOption((o) => o.setName("value").setDescription("قيمة الكود بالكريدت (صافي، بدون عمولة)").setRequired(true))
      .addIntegerOption((o) => o.setName("uses").setDescription("عدد مرات الاستخدام المسموحة (افتراضي 1)").setRequired(false)),

    new SlashCommandBuilder()
      .setName("removepromocode")
      .setDescription("👑 [أونر/أدمن] احذف/عطّل كود خصم")
      .addStringOption((o) => o.setName("code").setDescription("الكود").setRequired(true)),

    new SlashCommandBuilder()
      .setName("listpromocodes")
      .setDescription("👑 [أونر/أدمن] اعرض كل أكواد الخصم"),

    new SlashCommandBuilder()
      .setName("points")
      .setDescription("👑 [أونر/أدمن] ضيف أو اخصم نقاط من رصيد يوزر")
      .addUserOption((o) => o.setName("user").setDescription("اليوزر").setRequired(true))
      .addStringOption((o) =>
        o.setName("action")
          .setDescription("الإجراء")
          .setRequired(true)
          .addChoices(
            { name: "➕ إضافة", value: "add" },
            { name: "➖ خصم",   value: "remove" },
          )
      )
      .addIntegerOption((o) => o.setName("amount").setDescription("الكمية").setRequired(true)),

    new SlashCommandBuilder()
      .setName("mypoints")
      .setDescription("شوف رصيد نقاطك"),
  ];

  const rest = new REST({ version: "10" }).setToken(TOKEN);
  try {
    await rest.put(
      Routes.applicationGuildCommands(client.user!.id, GUILD_ID),
      { body: commands.map((c) => c.toJSON()) }
    );
    logger.info("Slash commands registered");
  } catch (err) {
    logger.error({ err }, "Failed to register slash commands");
  }

  // ── مزامنة الرومات ────────────────────────────────────────────────────────
  await syncStaticRooms();

  // ── إعداد AutoMod (كلام ممنوع فقط) ──────────────────────────────────────
  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (guild) {
    await setupAutoMod(guild);
    joinAfkVoiceChannel(guild);

    // ── تهيئة رومات المزاد (قفلها عند بدء التشغيل) ───────────────────────
    for (const roomId of AUCTION_ROOM_CHANNEL_IDS) {
      await lockAuctionRoom(guild, roomId);
    }

    // ── تهيئة روم الطلبيات الثابت (سلوموود ساعة + فتح الإرسال للكل) ──────
    const ordersRoomCh = guild.channels.cache.get(ORDERS_STATIC_CHANNEL_ID) as TextChannel | undefined;
    if (ordersRoomCh && ordersRoomCh.type === ChannelType.GuildText) {
      await ordersRoomCh.setRateLimitPerUser(ORDERS_ROOM_SLOWMODE_SEC, "Dragon Bot — orders room slowmode").catch((err) => {
        logger.error({ err }, "Failed to set orders room slowmode");
      });
      await ordersRoomCh.permissionOverwrites
        .edit(guild.roles.everyone, { SendMessages: true })
        .catch((err) => {
          logger.error({ err }, "Failed to open orders room for sending");
        });
    }

    // ── استعادة IDs رسائل شانل المزاد بعد الـ restart ────────────────────
    try {
      const infoCh = await guild.channels.fetch(AUCTION_INFO_CHANNEL_ID).catch(() => null) as TextChannel | null;
      if (infoCh) {
        const recent = await infoCh.messages.fetch({ limit: 50 }).catch(() => null);
        if (recent) {
          for (const m of recent.values()) {
            if (m.author.id !== client.user!.id) continue;
            if (!auctionInfoMsgId && m.embeds.some((e) => e.title?.includes("كيف يعمل"))) {
              auctionInfoMsgId = m.id;
            }
            if (!auctionScheduleMsgId && m.embeds.some((e) => e.title?.includes("المواعيد المحجوزة"))) {
              auctionScheduleMsgId = m.id;
            }
            if (auctionInfoMsgId && auctionScheduleMsgId) break;
          }
        }
      }
    } catch (err) {
      logger.error({ err }, "Failed to restore auction info message IDs");
    }

    startAuctionScheduler(guild);

    // تحديث المواعيد فور التشغيل ثم كل 5 دقايق
    await refreshAuctionScheduleMsg(guild);
    setInterval(() => refreshAuctionScheduleMsg(guild).catch(() => {}), 5 * 60 * 1000);

    logger.info({ auctionInfoMsgId, auctionScheduleMsgId }, "Auction rooms locked and scheduler started");
  }
  } catch (err) {
    logger.error({ err }, "Fatal error during bot initialization — exiting");
    process.exit(1);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  MessageCreate — معالجة الرسائل
// ══════════════════════════════════════════════════════════════════════════════
client.on(Events.MessageCreate, async (message: Message) => {
  try {

  // ── رسائل البوتات (ProBot فقط) ──────────────────────────────────────────
  if (message.author.bot) {
    if (!message.guild) return;
    // تجاهل أي بوت تاني غير ProBot — بيمنع الـ spoofing
    if (message.author.id !== PROBOT_USER_ID) return;

    const channel    = message.channel as TextChannel;
    const searchText = [
      message.content,
      ...(message.embeds ?? []).map((e) =>
        [e.description ?? "", e.title ?? "", ...e.fields.map((f) => f.value)].join(" ")
      ),
    ].join(" ");

    logger.info({ channelId: channel.id, text: searchText.slice(0, 200) }, "ProBot message");

    // ── رد تلقائي على أمر /credit (c) في روم الأوامر ────────────────────────
    // NOTE: ProBot بيرد برسالة نصية زي:
    //       "🏦 | mostafa9321., your account balance is $23398015 ."
    //       بنقرا الرقم ونرد بتعليق مختلف على حسب قد ما معاه.
    const COMMANDS_ROOM_ID = "1523817510435164291";
    if (channel.id === COMMANDS_ROOM_ID) {
      const balanceMatch = searchText.match(/account balance is\s*[`$]*([\d,]+(?:\.\d+)?)/i);
      if (balanceMatch) {
        const amount = parseFloat(balanceMatch[1].replace(/,/g, ""));
        let reply: string;
        if (amount > 10_000_000) {
          reply = "<a:PepeRain:1499748947105939486> متجيب حته";
        } else if (amount > 1_000_000) {
          reply = "<:Call_yami_rm1:1524625461454438481> الو مباحث الاموال العامة";
        } else {
          reply = "<:DFC_Angry_jerry:1524625451270803598> يعملوا اي دول النهارده";
        }
        // نرد على رسالة صاحب الأمر (الـ "c") نفسها، مش على رد ProBot.
        // NOTE: أوامر البريفكس (زي "c") مفيهاش reference لرسالة المستخدم في
        //       رد ProBot، فبنلاقيها بإننا نجيب آخر رسالة مش من بوت قبل رد
        //       ProBot ده في نفس الشانل.
        let targetMessage: Message = message;
        try {
          const history = await channel.messages.fetch({ limit: 10, before: message.id });
          const triggerMsg = [...history.values()]
            .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
            .find((m) => !m.author.bot);
          if (triggerMsg) targetMessage = triggerMsg;
        } catch (err) {
          logger.error({ err }, "Failed to look up /credit trigger message");
        }

        await targetMessage.reply({ content: reply }).catch(() => {});
        logger.info({ channelId: channel.id, amount, targetMessageId: targetMessage.id }, "Replied to /credit balance check");
      }
      return;
    }

    // ابحث عن رسالة التحويل الناجح من ProBot
    // NOTE: نص ProBot بيكون: "X has transferred `1053` to Y" أو قريب منه.
    //       الـ regex بيقرأ المبلغ ويتحقق من وجود OWNER_ID في النص كمستلم.
    //       ده بيمنع إن أي تحويل لشخص تاني يعتبر دفع صالح.
    const match = searchText.match(/has transferred\s+`?\$?([\d,]+(?:\.\d+)?)`?/i);
    if (match) {
      const paid = parseFloat(match[1].replace(/,/g, ""));
      // ── تحقق من المستلم ──────────────────────────────────────────────────
      // ProBot بيكتب ID المستلم في الرسالة — نتأكد إن الأونر هو المستلم
      const recipientInMsg = searchText.includes(OWNER_ID);
      if (!recipientInMsg) {
        logger.warn({ channelId: channel.id, paid }, "ProBot transfer detected but recipient is not OWNER_ID — ignoring");
        return;
      }
      logger.info({ paid, channelId: channel.id }, "Detected ProBot transfer");

      // ابحث عن تذكرة pending في نفس الشانل
      const ticketPurchase = await db
        .select()
        .from(purchasesTable)
        .where(
          and(
            eq(purchasesTable.ticketChannelId, channel.id),
            eq(purchasesTable.status, "pending")
          )
        )
        .then((rows) => rows[0]);

      // لو مفيش تذكرة شراء عادية، ابحث في تذاكر المزادات
      if (!ticketPurchase) {
        // تذكرة مزاد مباشر (auctype_) — انتظار الدفع
        const auctionTicket = await db
          .select()
          .from(auctionSchedulesTable)
          .where(
            and(
              eq(auctionSchedulesTable.ticketChannelId, channel.id),
              eq(auctionSchedulesTable.status, "pending_payment"),
            ),
          )
          .then((r) => r[0]);

        // تذكرة شراء إعلان منشن مزاد (buy_auc_mention_*) — انتظار الدفع
        const mentionAdTicket = !auctionTicket
          ? await db
              .select()
              .from(auctionSchedulesTable)
              .where(
                and(
                  eq(auctionSchedulesTable.ticketChannelId, channel.id),
                  eq(auctionSchedulesTable.status, "pending_mention_payment"),
                ),
              )
              .then((r) => r[0])
          : undefined;

        if (!auctionTicket && !mentionAdTicket) {
          const mentionIds = [...searchText.matchAll(/<@!?(\d+)>/g)].map((m) => m[1]);

          // ── 1. تحقق من منشن معلق ──────────────────────────────────────────
          let matchedMention: PendingMentionPurchase | undefined;
          if (mentionIds.length > 0) {
            matchedMention = mentionIds
              .map((id) => pendingMentionPurchases.get(id))
              .find((p) => p && paid >= p.netPrice && p.guildId === message.guild!.id);
          }
          if (!matchedMention && mentionIds.length === 0) {
            logger.warn({ paid, channelId: channel.id }, "ProBot transfer with no user mentions — cannot attribute mention purchase, skipping");
          }

          if (matchedMention) {
            // ✅ تأكيد شراء المنشن
            await cancelPendingMentionPurchase(matchedMention.userId, false);
            const buyer      = await getOrCreateUser(matchedMention.userId, matchedMention.username);
            const balKey     =
              matchedMention.mentionKey === "here"     ? "hereBalance" :
              matchedMention.mentionKey === "everyone" ? "everyoneBalance" :
              matchedMention.mentionKey === "orders"   ? "ordersBalance" :
              matchedMention.mentionKey === "auction"  ? "auctionBalance" : "offersBalance";
            const newBalance = buyer[balKey] + matchedMention.qty;

            await db.update(botUsersTable)
              .set({ [balKey]: newBalance })
              .where(eq(botUsersTable.discordUserId, matchedMention.userId));
            if (newBalance > 0 && message.guild) await grantMentionRole(message.guild, matchedMention.userId);

            logger.info(
              { userId: matchedMention.userId, mentionKey: matchedMention.mentionKey, qty: matchedMention.qty, newBalance },
              "Mention purchase completed via ProBot transfer"
            );

            const DIV_C        = "ـﮩ════════════════ﮩـ";
            const guildIconURL = message.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;
            const confirmFiles: AttachmentBuilder[] = [];
            const confirmEmbed = new EmbedBuilder()
              .setAuthor({ name: "Dragon $hop", iconURL: guildIconURL })
              .setTitle(`${STAR_EMOJI} تم تأكيد شراء المنشن!`)
              .setDescription(`<@${matchedMention.userId}> ${MONEY_EMOJI}\n> ${DIV_C}`)
              .setColor(0x00ff88)
              .addFields(
                { name: `${STAR_EMOJI} النوع`,         value: `> ${MONEY_EMOJI} **${matchedMention.label}**\n> ${DIV_C}`,           inline: false },
                { name: `${STAR_EMOJI} الكمية`,         value: `> ${MONEY_EMOJI} **${matchedMention.qty}** منشن\n> ${DIV_C}`,        inline: false },
                { name: `${STAR_EMOJI} رصيدك الجديد`,  value: `> ${MONEY_EMOJI} **${newBalance}** منشن\n> ${DIV_C}`,                 inline: false },
              )
              .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: guildIconURL });
            if (fs.existsSync(DRAGON_BANNER_PATH)) {
              confirmFiles.push(new AttachmentBuilder(DRAGON_BANNER_PATH, { name: "dragon_banner.webp" }));
              confirmEmbed.setImage("attachment://dragon_banner.webp");
            }
            await channel.send({ embeds: [confirmEmbed], files: confirmFiles });
            return;
          }

          // ── 2. تحقق من تغيير اسم متجر معلق ──────────────────────────────
          let matchedRename: PendingStoreRename | undefined;
          if (mentionIds.length > 0) {
            matchedRename = mentionIds
              .map((id) => pendingStoreRenames.get(id))
              .find((p) => p && paid >= p.netPrice && p.guildId === message.guild!.id);
          }
          if (!matchedRename && mentionIds.length === 0) {
            logger.warn({ paid, channelId: channel.id }, "ProBot transfer with no user mentions — cannot attribute store rename, skipping");
          }

          if (matchedRename) {
            // ✅ ProBot أكد الدفع — كنسل الـ timeout وابعت زرار المودال
            await cancelPendingStoreRename(matchedRename.userId, false);
            pendingStoreRenameReady.set(matchedRename.userId, {
              purchaseId:    matchedRename.purchaseId,
              roomChannelId: matchedRename.roomChannelId,
            });

            const DIV_R        = "ـﮩ════════════════ﮩـ";
            const guildIconURLR = message.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;
            const renameReadyEmbed = new EmbedBuilder()
              .setAuthor({ name: "Dragon $hop", iconURL: guildIconURLR })
              .setTitle(`${STAR_EMOJI} تم تأكيد الدفع!`)
              .setDescription(`<@${matchedRename.userId}> ${MONEY_EMOJI}\n> ${DIV_R}`)
              .setColor(0x00ff88)
              .addFields({
                name:  `${STAR_EMOJI} الخطوة التالية`,
                value: `> ${MONEY_EMOJI} اضغط الزر عشان تكتب الاسم الجديد للمتجر\n> ${DIV_R}`,
                inline: false,
              })
              .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: guildIconURLR });

            const renameActionBtn = new ButtonBuilder()
              .setCustomId(`open_store_rename_${matchedRename.userId}`)
              .setLabel("✏️ اكتب الاسم الجديد")
              .setStyle(ButtonStyle.Primary);

            await channel.send({
              content:    `<@${matchedRename.userId}>`,
              embeds:     [renameReadyEmbed],
              components: [new ActionRowBuilder<ButtonBuilder>().addComponents(renameActionBtn)],
            });

            logger.info({ userId: matchedRename.userId, purchaseId: matchedRename.purchaseId }, "Store rename confirmed — waiting for modal");
            return;
          }

          // ── 3. تحقق من إزالة تحذير معلقة ──────────────────────────────
          let matchedWarningRemoval: PendingWarningRemoval | undefined;
          if (mentionIds.length > 0) {
            matchedWarningRemoval = mentionIds
              .map((id) => pendingWarningRemovals.get(id))
              .find((p) => p && paid >= p.netPrice && p.guildId === message.guild!.id);
          }
          if (!matchedWarningRemoval && mentionIds.length === 0) {
            logger.warn({ paid, channelId: channel.id }, "ProBot transfer with no user mentions — cannot attribute warning removal, skipping");
          }

          if (matchedWarningRemoval) {
            clearTimeout(matchedWarningRemoval.timeoutId);
            pendingWarningRemovals.delete(matchedWarningRemoval.userId);

            const pur = await db.select().from(purchasesTable)
              .where(eq(purchasesTable.id, matchedWarningRemoval.purchaseId))
              .then((r) => r[0]);

            if (pur) {
              const newCount       = Math.max(0, pur.roomWarningCount - 1);
              const shouldReactivate = pur.isRoomDeactivated && newCount < 3;
              await db.update(purchasesTable)
                .set({ roomWarningCount: newCount, isRoomDeactivated: shouldReactivate ? false : pur.isRoomDeactivated })
                .where(eq(purchasesTable.id, pur.id));

              if (shouldReactivate && pur.discordRoomId && message.guild) {
                const roomCh = message.guild.channels.cache.get(pur.discordRoomId) as TextChannel | undefined;
                if (roomCh) {
                  await roomCh.permissionOverwrites.edit(pur.discordUserId, {
                    ViewChannel:     true,
                    SendMessages:    true,
                    MentionEveryone: true,
                  }).catch(() => {});
                }
              }
            }

            const DIV_WR = "ـﮩ════════════════ﮩـ";
            const gIW    = message.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;
            const wrSuccessEmbed = new EmbedBuilder()
              .setAuthor({ name: "Dragon $hop", iconURL: gIW })
              .setTitle(`✅ تمت ازاله التحذير بنجاح`)
              .setDescription(
                `<@${matchedWarningRemoval.userId}>\n> ${DIV_WR}\n\n` +
                `متكررش غلطتك <:PES_BuffClown:1496150024680378399>\n\n` +
                `> ${DIV_WR}`
              )
              .setColor(0x00ff88)
              .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: gIW });

            const wrFiles: AttachmentBuilder[] = [];
            if (fs.existsSync(DRAGON_TEXT_BANNER_PATH)) {
              wrFiles.push(new AttachmentBuilder(DRAGON_TEXT_BANNER_PATH, { name: "dragon_text_banner.webp" }));
              wrSuccessEmbed.setImage("attachment://dragon_text_banner.webp");
            }

            if (matchedWarningRemoval.roomChannelId && message.guild) {
              const roomCh = message.guild.channels.cache.get(matchedWarningRemoval.roomChannelId) as TextChannel | undefined;
              if (roomCh) await roomCh.send({ embeds: [wrSuccessEmbed], files: wrFiles }).catch(() => {});
            }

            logger.info({ userId: matchedWarningRemoval.userId, purchaseId: matchedWarningRemoval.purchaseId }, "Warning removed via ProBot payment");
            return;
          }

          // ── 4. تحقق من إعادة تفعيل روم معلقة ──────────────────────────
          let matchedReactivation: PendingRoomReactivation | undefined;
          if (mentionIds.length > 0) {
            matchedReactivation = mentionIds
              .map((id) => pendingRoomReactivations.get(id))
              .find((p) => p && paid >= p.netPrice && p.guildId === message.guild!.id);
          }
          if (!matchedReactivation && mentionIds.length === 0) {
            logger.warn({ paid, channelId: channel.id }, "ProBot transfer with no user mentions — cannot attribute room reactivation, skipping");
          }

          if (matchedReactivation) {
            clearTimeout(matchedReactivation.timeoutId);
            pendingRoomReactivations.delete(matchedReactivation.userId);

            await db.update(purchasesTable)
              .set({ isRoomDeactivated: false })
              .where(eq(purchasesTable.id, matchedReactivation.purchaseId));

            if (matchedReactivation.roomChannelId && message.guild) {
              const roomCh = message.guild.channels.cache.get(matchedReactivation.roomChannelId) as TextChannel | undefined;
              if (roomCh) {
                await roomCh.permissionOverwrites.edit(matchedReactivation.userId, {
                  ViewChannel:     true,
                  SendMessages:    true,
                  MentionEveryone: true,
                }).catch(() => {});

                const DIV_RA = "ـﮩ════════════════ﮩـ";
                const gIR    = message.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;
                const reactSuccessEmbed = new EmbedBuilder()
                  .setAuthor({ name: "Dragon $hop", iconURL: gIR })
                  .setTitle(`✅ تم اعادة تفعيل متجرك!`)
                  .setDescription(`<@${matchedReactivation.userId}>\n> ${DIV_RA}`)
                  .setColor(0x00ff88)
                  .addFields({
                    name:  `${STAR_EMOJI} ملاحظة`,
                    value: `> متجرك شغّال تاني! حافظ عليه وامتثل للقوانين.\n> ${DIV_RA}`,
                    inline: false,
                  })
                  .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: gIR });

                const reactFiles: AttachmentBuilder[] = [];
                if (fs.existsSync(DRAGON_TEXT_BANNER_PATH)) {
                  reactFiles.push(new AttachmentBuilder(DRAGON_TEXT_BANNER_PATH, { name: "dragon_text_banner.webp" }));
                  reactSuccessEmbed.setImage("attachment://dragon_text_banner.webp");
                }

                await roomCh.send({ embeds: [reactSuccessEmbed], files: reactFiles }).catch(() => {});
              }
            }

            logger.info({ userId: matchedReactivation.userId, purchaseId: matchedReactivation.purchaseId }, "Room reactivated via ProBot payment");
            return;
          }

          // ── 5. تحقق من إضافة شريك معلقة ────────────────────────────────
          let matchedAddPartner: PendingAddPartner | undefined;
          if (mentionIds.length > 0) {
            matchedAddPartner = mentionIds
              .map((id) => pendingAddPartners.get(id))
              .find((p) => p && paid >= p.netPrice && p.guildId === message.guild!.id);
          }
          if (!matchedAddPartner && mentionIds.length === 0) {
            logger.warn({ paid, channelId: channel.id }, "ProBot transfer with no user mentions — cannot attribute add-partner, skipping");
          }

          if (matchedAddPartner) {
            clearTimeout(matchedAddPartner.timeoutId);
            pendingAddPartners.delete(matchedAddPartner.userId);

            // سجّل انتظار المنشن
            const apTimeoutId = setTimeout(() => {
              awaitingPartnerMention.delete(matchedAddPartner!.userId);
            }, 5 * 60 * 1000);
            awaitingPartnerMention.set(matchedAddPartner.userId, {
              purchaseId:    matchedAddPartner.purchaseId,
              roomChannelId: matchedAddPartner.roomChannelId,
              guildId:       matchedAddPartner.guildId,
              timeoutId:     apTimeoutId,
            });

            // أبلغ الأونر في الروم يمنشن الشريك
            if (matchedAddPartner.roomChannelId && message.guild) {
              const roomCh = message.guild.channels.cache.get(matchedAddPartner.roomChannelId) as TextChannel | undefined;
              if (roomCh) {
                await roomCh.send(
                  `✅ تم التأكيد! <@${matchedAddPartner.userId}> منشن الشريك الجديد هنا عشان أضيفه للروم 👇`
                ).catch(() => {});
              }
            }

            logger.info({ userId: matchedAddPartner.userId, purchaseId: matchedAddPartner.purchaseId }, "Add-partner payment confirmed — awaiting mention");
            return;
          }

          // ── 6. تحقق من إزالة شريك معلقة ────────────────────────────────
          let matchedRemovePartner: PendingRemovePartner | undefined;
          if (mentionIds.length > 0) {
            matchedRemovePartner = mentionIds
              .map((id) => pendingRemovePartners.get(id))
              .find((p) => p && paid >= p.netPrice && p.guildId === message.guild!.id);
          }
          if (!matchedRemovePartner && mentionIds.length === 0) {
            logger.warn({ paid, channelId: channel.id }, "ProBot transfer with no user mentions — cannot attribute remove-partner, skipping");
          }

          if (matchedRemovePartner) {
            clearTimeout(matchedRemovePartner.timeoutId);
            pendingRemovePartners.delete(matchedRemovePartner.userId);

            const partnerId = matchedRemovePartner.partnerId;

            // امسح الشريك من DB
            await db.update(purchasesTable)
              .set({ partnerDiscordUserId: null })
              .where(eq(purchasesTable.id, matchedRemovePartner.purchaseId));

            // اسحب صلاحياته من الروم
            if (matchedRemovePartner.roomChannelId && message.guild) {
              const roomCh = message.guild.channels.cache.get(matchedRemovePartner.roomChannelId) as TextChannel | undefined;
              if (roomCh) {
                await roomCh.permissionOverwrites.delete(partnerId, "Partner removed").catch(() => {});

                // اسحب رول المنشن من الشريك لو مش عنده متجر تاني (أونر أو شريك)
                const partnerStillActive = await db.select().from(purchasesTable)
                  .where(and(eq(purchasesTable.status, "completed")))
                  .then((rows) => rows.some(
                    (p) => p.discordRoomId && (
                      p.discordUserId        === partnerId ||
                      p.partnerDiscordUserId === partnerId
                    )
                  ));
                if (!partnerStillActive) await revokeMentionRole(message.guild, partnerId).catch(() => {});

                const DIV_RP2 = "ـﮩ════════════════ﮩـ";
                const gIRP2   = message.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;
                const rpSuccessEmbed = new EmbedBuilder()
                  .setAuthor({ name: "Dragon $hop", iconURL: gIRP2 })
                  .setTitle("✅ تمت إزالة الشريك بنجاح!")
                  .setDescription(
                    `<@${matchedRemovePartner.userId}>\n> ${DIV_RP2}\n\n` +
                    `الشريك <@${partnerId}> اتشال من متجرك.\n\n` +
                    `> ${DIV_RP2}`
                  )
                  .setColor(0x00ff88)
                  .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: gIRP2 });

                const rpFiles2: AttachmentBuilder[] = [];
                if (fs.existsSync(DRAGON_TEXT_BANNER_PATH)) {
                  rpFiles2.push(new AttachmentBuilder(DRAGON_TEXT_BANNER_PATH, { name: "dragon_text_banner.webp" }));
                  rpSuccessEmbed.setImage("attachment://dragon_text_banner.webp");
                }
                await roomCh.send({ embeds: [rpSuccessEmbed], files: rpFiles2 }).catch(() => {});
              }
            }

            logger.info({ userId: matchedRemovePartner.userId, partnerId, purchaseId: matchedRemovePartner.purchaseId }, "Partner removed via ProBot payment");
            return;
          }

          // ── 7. تحقق من نشر تلقائي معلق ─────────────────────────────────
          // NOTE: التذكرة (ticket) اللي المستخدم بيحول فيها خاصة بيه — نتحقق أولاً بالشانل
          //       (زي باقي عمليات الشراء) لأن رسالة ProBot مش دايماً بتمنشن الشاري نفسه
          //       (بتمنشن المستلم/الرول بس)، فالاعتماد على mentionIds لوحده ممكن يفوّت الدفعة.
          let matchedAutoPublish: PendingAutoPublish | undefined = [...pendingAutoPublishes.values()]
            .find((p) => p.ticketChannelId === channel.id && paid >= p.netPrice && p.guildId === message.guild!.id);

          if (!matchedAutoPublish && mentionIds.length > 0) {
            matchedAutoPublish = mentionIds
              .map((id) => pendingAutoPublishes.get(id))
              .find((p) => p && paid >= p.netPrice && p.guildId === message.guild!.id);
          }
          if (!matchedAutoPublish) {
            logger.warn({ paid, channelId: channel.id }, "ProBot transfer detected but no matching pending auto publish found — skipping");
          }

          if (matchedAutoPublish) {
            clearTimeout(matchedAutoPublish.timeoutId);
            pendingAutoPublishes.delete(matchedAutoPublish.userId);

            // أغلق التذكرة بعد 3 ثواني
            setTimeout(() => channel.delete("Auto publish payment confirmed").catch(() => {}), 3000);

            // اسأل عن رصيد المنشنات
            const DIV_APP = "ـﮩ════════════════ﮩـ";
            const gIAPP   = message.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;
            const apConfirmEmbed = new EmbedBuilder()
              .setAuthor({ name: "Dragon $hop", iconURL: gIAPP })
              .setTitle("✅ تم تأكيد الدفع!")
              .setDescription(`<@${matchedAutoPublish.userId}> ${MONEY_EMOJI}\n> ${DIV_APP}`)
              .setColor(0x00ff88)
              .addFields({
                name:  `${STAR_EMOJI} السؤال`,
                value: `> عايزني استخدم من رصيد منشناتك مع كل نشرة ولا لا؟\n> ${DIV_APP}`,
                inline: false,
              })
              .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: gIAPP });

            pendingAutoPublishReady.set(matchedAutoPublish.userId, {
              storePurchaseId: matchedAutoPublish.storePurchaseId,
              days:            matchedAutoPublish.days,
              roomChannelId:   matchedAutoPublish.roomChannelId,
            });

            const yesBtn = new ButtonBuilder()
              .setCustomId(`autopub_mention_yes_${matchedAutoPublish.userId}_${matchedAutoPublish.storePurchaseId}_${matchedAutoPublish.days}_${matchedAutoPublish.roomChannelId}`)
              .setLabel("✅ أيوه استخدم منشناتي")
              .setStyle(ButtonStyle.Success);
            const noBtn = new ButtonBuilder()
              .setCustomId(`autopub_mention_no_${matchedAutoPublish.userId}_${matchedAutoPublish.storePurchaseId}_${matchedAutoPublish.days}_${matchedAutoPublish.roomChannelId}`)
              .setLabel("❌ لأ بدون منشنات")
              .setStyle(ButtonStyle.Secondary);

            // ابعت في روم العميل مش التذكرة (اللي هتتحذف)
            if (matchedAutoPublish.roomChannelId && message.guild) {
              const roomCh = message.guild.channels.cache.get(matchedAutoPublish.roomChannelId) as TextChannel | undefined;
              await roomCh?.send({
                content:    `<@${matchedAutoPublish.userId}>`,
                embeds:     [apConfirmEmbed],
                components: [new ActionRowBuilder<ButtonBuilder>().addComponents(yesBtn, noBtn)],
              }).catch(() => {});
            }

            logger.info({ userId: matchedAutoPublish.userId, days: matchedAutoPublish.days }, "Auto publish payment confirmed — awaiting mention choice");
            return;
          }

          // ── 8. تحقق من دفع تلقائي للخطوط معلق ─────────────────────────
          let matchedAutoLines: PendingAutoLinePurchase | undefined;
          if (mentionIds.length > 0) {
            matchedAutoLines = mentionIds
              .map((id) => pendingAutoLinePurchases.get(id))
              .find((p) => p && paid >= p.netPrice && p.guildId === message.guild!.id);
          }

          if (matchedAutoLines) {
            clearTimeout(matchedAutoLines.timeoutId);
            pendingAutoLinePurchases.delete(matchedAutoLines.userId);

            // طلب الصورة في روم المتجر
            if (matchedAutoLines.roomChannelId && message.guild) {
              const roomCh = message.guild.channels.cache.get(matchedAutoLines.roomChannelId) as TextChannel | undefined;
              if (roomCh) {
                const alTimeout = setTimeout(() => {
                  pendingAutoLineImages.delete(matchedAutoLines!.userId);
                  roomCh.send(`⏰ <@${matchedAutoLines!.userId}> انتهت المهلة — ابعت الصورة تاني لو عايز تفعّل الخدمة.`).catch(() => {});
                }, AUTO_LINES_IMAGE_TIMEOUT_MS);

                pendingAutoLineImages.set(matchedAutoLines.userId, {
                  userId:        matchedAutoLines.userId,
                  purchaseId:    matchedAutoLines.purchaseId,
                  roomChannelId: matchedAutoLines.roomChannelId,
                  timeoutId:     alTimeout,
                });

                await roomCh.send(
                  `✅ <@${matchedAutoLines.userId}> تم تأكيد الدفع! 🎉\n` +
                  `ابعتلي الصورة اللي عايزها تتبعت بعد كل رسالة في متجرك 👇\n` +
                  `*(عندك 10 دقايق)*`
                ).catch(() => {});
              }
            }

            logger.info({ userId: matchedAutoLines.userId }, "Auto lines payment confirmed — awaiting image");
            return;
          }

          // ── 9. تحقق من منشن إعلان مزاد معلق ────────────────────────────
          let matchedAucMention: PendingAucMentionPurchase | undefined;
          if (mentionIds.length > 0) {
            matchedAucMention = mentionIds
              .map((id) => pendingAucMentionPurchases.get(id))
              .find((p) => p && paid >= p.netPrice && p.guildId === message.guild!.id);
          }

          if (matchedAucMention) {
            clearTimeout(matchedAucMention.timeoutId);
            pendingAucMentionPurchases.delete(matchedAucMention.userId);
            // ready token ينتهي بعد 10 دقايق لو اليوزر ما ضغطش الزرار
            const readyTimeoutId = setTimeout(() => {
              pendingAucMentionReady.delete(matchedAucMention!.userId);
              logger.info({ userId: matchedAucMention!.userId }, "Auc mention ready token expired");
            }, 10 * 60 * 1000);
            pendingAucMentionReady.set(matchedAucMention.userId, {
              mentionType:     matchedAucMention.mentionType,
              guildId:         matchedAucMention.guildId,
              ticketChannelId: matchedAucMention.ticketChannelId,
              timeoutId:       readyTimeoutId,
            });

            const amTypeCfg  = AUCTION_TYPES[matchedAucMention.mentionType];
            const DIV_AM3    = "ـﮩ════════════════ﮩـ";
            const gIAM3      = message.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;

            const amConfEmbed = new EmbedBuilder()
              .setAuthor({ name: "Dragon $hop", iconURL: gIAM3 })
              .setTitle(`✅ تم تأكيد الدفع!`)
              .setDescription(`<@${matchedAucMention.userId}> ${MONEY_EMOJI}\n> ${DIV_AM3}`)
              .setColor(0x00ff88)
              .addFields({
                name:  `${STAR_EMOJI} الخطوة التالية`,
                value: `> ${MONEY_EMOJI} اضغط الزر عشان تختار تفاصيل إعلانك (الروم + الساعة + العكلة)\n> ${DIV_AM3}`,
                inline: false,
              })
              .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: gIAM3 });

            const amFilesConf: AttachmentBuilder[] = [];
            if (fs.existsSync(DRAGON_TEXT_BANNER_PATH)) {
              amFilesConf.push(new AttachmentBuilder(DRAGON_TEXT_BANNER_PATH, { name: "dragon_text_banner.webp" }));
              amConfEmbed.setImage("attachment://dragon_text_banner.webp");
            }

            const detailsBtn = new ButtonBuilder()
              .setCustomId(`auc_mention_details_btn_${matchedAucMention.userId}_${matchedAucMention.mentionType}`)
              .setLabel(`${amTypeCfg.emoji} اختار تفاصيل الإعلان`)
              .setStyle(ButtonStyle.Primary);

            // ابعت جوّه تذكرة الطلب نفسها (مش في روم الأوامر)
            try {
              const ticketCh3 = message.guild
                ? (message.guild.channels.cache.get(matchedAucMention.ticketChannelId) as TextChannel | undefined)
                : undefined;
              await ticketCh3?.send({
                content:    `<@${matchedAucMention.userId}>`,
                embeds:     [amConfEmbed],
                files:      amFilesConf,
                components: [new ActionRowBuilder<ButtonBuilder>().addComponents(detailsBtn)],
              }).catch(() => {});
            } catch { /* ignore */ }

            logger.info({ userId: matchedAucMention.userId, mType: matchedAucMention.mentionType }, "Auc mention payment confirmed — awaiting details modal (legacy map path)");
            return;
          }
          // لو وصلنا هنا: مفيش أي match لأي فلو — نتجاهل ببساطة
          return;
        } else if (mentionAdTicket) {
          // ── تأكيد دفع تذكرة منشن إعلان مزاد ──────────────────────────────
          const amTypeCfg   = AUCTION_TYPES[mentionAdTicket.auctionType as AuctionType];
          const requiredAmtAM    = Number(mentionAdTicket.totalPrice);
          const netRequiredAmtAM = Math.floor(requiredAmtAM * (1 - PROBOT_FEE));

          if (paid < netRequiredAmtAM) {
            await channel.send(
              `⚠️ المبلغ المحوّل (${paid}) أقل من المطلوب (${netRequiredAmtAM}). يرجى إعادة التحويل.`,
            );
            return;
          }

          // امسح من الـ pending Map (عشان نوقف الـ timeout ونمنع تكرار)
          const pendingAmEntry = pendingAucMentionPurchases.get(mentionAdTicket.discordUserId);
          if (pendingAmEntry) {
            clearTimeout(pendingAmEntry.timeoutId);
            pendingAucMentionPurchases.delete(mentionAdTicket.discordUserId);
          }

          // ready token ينتهي بعد 10 دقايق لو اليوزر ما ضغطش الزرار
          const amReadyTimeoutId = setTimeout(() => {
            pendingAucMentionReady.delete(mentionAdTicket.discordUserId);
            logger.info({ userId: mentionAdTicket.discordUserId }, "Auc mention ready token expired");
          }, 10 * 60 * 1000);

          pendingAucMentionReady.set(mentionAdTicket.discordUserId, {
            mentionType:     mentionAdTicket.auctionType as AuctionType,
            guildId:         message.guild!.id,
            ticketChannelId: mentionAdTicket.ticketChannelId!,
            timeoutId:       amReadyTimeoutId,
          });

          // حدّث الـ status في DB
          await db.update(auctionSchedulesTable)
            .set({ status: "awaiting_mention_details" })
            .where(eq(auctionSchedulesTable.id, mentionAdTicket.id));

          // ابعت رسالة تأكيد وزرار التفاصيل في التذكرة
          const DIV_AMDB   = "ـﮩ════════════════ﮩـ";
          const gIAMDB     = message.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;
          const amDbConfEmbed = new EmbedBuilder()
            .setAuthor({ name: "Dragon $hop", iconURL: gIAMDB })
            .setTitle(`✅ تم تأكيد الدفع!`)
            .setDescription(`<@${mentionAdTicket.discordUserId}> ${MONEY_EMOJI}\n> ${DIV_AMDB}`)
            .setColor(0x00ff88)
            .addFields({
              name:  `${STAR_EMOJI} الخطوة التالية`,
              value: `> ${MONEY_EMOJI} اضغط الزر عشان تختار تفاصيل إعلانك (الروم + الساعة + العكلة)\n> ${DIV_AMDB}`,
              inline: false,
            })
            .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: gIAMDB });

          const amDbFiles: AttachmentBuilder[] = [];
          if (fs.existsSync(DRAGON_TEXT_BANNER_PATH)) {
            amDbFiles.push(new AttachmentBuilder(DRAGON_TEXT_BANNER_PATH, { name: "dragon_text_banner.webp" }));
            amDbConfEmbed.setImage("attachment://dragon_text_banner.webp");
          }

          const detailsBtnAm = new ButtonBuilder()
            .setCustomId(`auc_mention_details_btn_${mentionAdTicket.discordUserId}_${mentionAdTicket.auctionType}`)
            .setLabel(`${amTypeCfg?.emoji ?? "🔔"} اختار تفاصيل الإعلان`)
            .setStyle(ButtonStyle.Primary);

          await channel.send({
            content:    `<@${mentionAdTicket.discordUserId}>`,
            embeds:     [amDbConfEmbed],
            files:      amDbFiles,
            components: [new ActionRowBuilder<ButtonBuilder>().addComponents(detailsBtnAm)],
          }).catch(() => {});

          logger.info({ userId: mentionAdTicket.discordUserId, mType: mentionAdTicket.auctionType }, "Auc mention-ad payment confirmed via DB ticket — awaiting details modal");
          return;
        } else {
          // ── تأكيد دفع تذكرة مزاد مباشر (auctype_) ────────────────────────
          // totalPrice في الـ DB هو مبلغ التحويل الكامل (gross).
          // ProBot بيبلغ عن المبلغ الـ net اللي وصل للمستلم.
          const requiredAmt    = Number(auctionTicket!.totalPrice);
          const netRequiredAmt = Math.floor(requiredAmt * (1 - PROBOT_FEE));
          if (paid >= netRequiredAmt) {
            // بعد تأكيد الدفع: بنبعت زرار يفتح مودال التفاصيل —
            // اليوزر بيكتب "المزاد على ايه" و"الدفع ازاي" في خانات المودال.
            await db.update(auctionSchedulesTable)
              .set({ status: "awaiting_item" })
              .where(eq(auctionSchedulesTable.id, auctionTicket!.id));

            const itemDetailsBtn = new ButtonBuilder()
              .setCustomId(`auc_item_modal_btn_${auctionTicket!.id}`)
              .setLabel("📝 أدخل تفاصيل المزاد")
              .setStyle(ButtonStyle.Primary);

            await channel.send({
              content:
                `✅ **تم تأكيد الدفع!**\n\n` +
                `<@${auctionTicket!.discordUserId}>\n\n` +
                `📦 **اضغط الزر عشان تدخل تفاصيل المزاد — البوت هيحجزلك ميعاد تلقائياً بعدها.**`,
              components: [new ActionRowBuilder<ButtonBuilder>().addComponents(itemDetailsBtn)],
            });
          } else {
            await channel.send(
              `⚠️ المبلغ المحوّل (${paid}) أقل من المطلوب (${netRequiredAmt}). يرجى إعادة التحويل.`,
            );
          }
          return;
        }
      }

      // totalPrice في الـ DB هو gross transfer amount.
      // ProBot بيبلغ عن الـ net المستلم — نحوّله قبل المقارنة.
      const requiredAmount    = Number(ticketPurchase.totalPrice);
      const netRequiredAmount = Math.floor(requiredAmount * (1 - PROBOT_FEE));

      if (paid >= netRequiredAmount) {
        // ✅ الدفع صح — انتظر اسم الروم
        await db
          .update(purchasesTable)
          .set({ status: "awaiting_room_name" })
          .where(eq(purchasesTable.id, ticketPurchase.id));

        await channel.send(
          `✅ تم التحقق من التحويل!\n\n` +
          `<@${ticketPurchase.discordUserId}> اكتب اسم الروم اللي عايزه هنا ⬇️\n` +
          `*(بالعربي أو الانجليزي، بدون زخارف أو إيموجيات)*`
        );
      } else {
        // ❌ المبلغ ناقص
        await channel.send(
          `⚠️ المبلغ المحوّل (${paid}) أقل من المطلوب (${requiredAmount} مع عمولة ProBot 5%). يرجى إعادة التحويل بالمبلغ الصحيح.`
        );
      }
    }
    return;
  }

  // من هنا: رسائل البشر فقط
  if (!message.guild) return;

  const userId   = message.author.id;
  const username = message.author.username;
  const content  = message.content;
  const channel  = message.channel as TextChannel;

  // ── !منشن — عرض رصيد المنشنات ────────────────────────────────────────────
  // الصيغة: !منشن          → رصيد المرسل نفسه
  //         !منشن @يوزر   → رصيد يوزر تاني
  if (content.trim() === "!منشن" || content.trim().startsWith("!منشن ")) {
    const mentionedUser = message.mentions.users.first() ?? null;
    const targetUser    = mentionedUser ?? message.author;
    const targetId      = targetUser.id;

    // ── البوتات مالهاش رصيد منشنات — منعاً لإنشاء يوزر وهمي ليها ─────────
    if (targetUser.bot) {
      await message.reply({ content: "❌ البوتات مالهاش رصيد منشنات." }).catch(() => {});
      return;
    }

    const u            = await getOrCreateUser(targetId, targetUser.username);
    const guildIconURL = message.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;
    const avatarURL    = targetUser.displayAvatarURL({ extension: "png", size: 256 });

    const DIV = "ـﮩ════════════════ﮩـ";

    // فحص صلاحية الأدمنستراتور للتارجت — cache أولاً ثم fetch كـ fallback
    const targetMember =
      message.guild?.members.cache.get(targetId) ??
      (await message.guild?.members.fetch(targetId).catch(() => null)) ??
      null;
    const targetIsAdmin = targetMember?.permissions.has(PermissionFlagsBits.Administrator) ?? false;

    // الأدمن: رصيد لا نهائي → عرض ∞ وتلوين ملكي
    const everyoneDisplay = targetIsAdmin ? "∞" : String(u.everyoneBalance);
    const hereDisplay     = targetIsAdmin ? "∞" : String(u.hereBalance);
    const offersDisplay   = targetIsAdmin ? "∞" : String(u.offersBalance);
    const ordersDisplay   = targetIsAdmin ? "∞" : String(u.ordersBalance);
    const auctionDisplay  = targetIsAdmin ? "∞" : String(u.auctionBalance);

    const hasAny     = targetIsAdmin || u.everyoneBalance > 0 || u.hereBalance > 0 || u.offersBalance > 0 || u.ordersBalance > 0 || u.auctionBalance > 0;
    const embedColor = targetIsAdmin ? 0x9b59b6 : hasAny ? 0xffd700 : 0x2b2d31;
    // بنفسجي للأدمن، ذهبي لو في رصيد، رمادي لو فاضي

    const targetLabel = mentionedUser
      ? `رصيد **${targetUser.globalName ?? targetUser.username}** من المنشنات`
      : `رصيدك يا <@${userId}> من المنشنات`;

    const balanceEmbed = new EmbedBuilder()
      .setAuthor({ name: "Dragon $hop", iconURL: guildIconURL })
      .setTitle("📊 رصيد المنشنات")
      .setDescription(`> ${targetLabel}\n> ${DIV}`)
      .setColor(embedColor)
      .addFields(
        {
          name:   `${STAR_EMOJI} @everyone`,
          value:  `> ${MONEY_EMOJI} الرصيد : **${everyoneDisplay}** منشن\n> ${DIV}`,
          inline: false,
        },
        {
          name:   `${STAR_EMOJI} @here`,
          value:  `> ${MONEY_EMOJI} الرصيد : **${hereDisplay}** منشن\n> ${DIV}`,
          inline: false,
        },
        {
          name:   `${STAR_EMOJI} @offers`,
          value:  `> <@&${OFFERS_ROLE_ID}>\n> ${MONEY_EMOJI} الرصيد : **${offersDisplay}** منشن\n> ${DIV}`,
          inline: false,
        },
        {
          name:   `${STAR_EMOJI} طلبيات`,
          value:  `> <@&${ORDERS_ROLE_ID}>\n> ${MONEY_EMOJI} الرصيد : **${ordersDisplay}** منشن\n> ${DIV}`,
          inline: false,
        },
        {
          name:   `${STAR_EMOJI} مزاد`,
          value:  `> <@&${AUCTION_ROLE_ID}>\n> ${MONEY_EMOJI} الرصيد : **${auctionDisplay}** منشن\n> ${DIV}`,
          inline: false,
        },
      )
      .setThumbnail(avatarURL)
      .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: guildIconURL });

    const bannerFiles: AttachmentBuilder[] = [];
    if (fs.existsSync(DRAGON_TEXT_BANNER_PATH)) {
      bannerFiles.push(new AttachmentBuilder(DRAGON_TEXT_BANNER_PATH, { name: "dragon_text_banner.webp" }));
      balanceEmbed.setImage("attachment://dragon_text_banner.webp");
    }

    await message.reply({ embeds: [balanceEmbed], files: bannerFiles }).catch(() => {});
    return;
  }

  // ── فحص الحظر ────────────────────────────────────────────────────────────
  const banned = await isUserBanned(userId);
  if (banned) {
    await message.delete().catch(() => {});
    await sendWarningEmbed(channel, userId, "محظور حالياً", "❌ أنت محظور حالياً.", message.guild);
    return;
  }

  // ── إدارة المزاد اليدوية في رومات المزاد ─────────────────────────────────
  // NOTE: المزايدة بقت يدوية بالكامل تحت إدارة الأدمن — البوت ملوش دعوة
  //       بالأرقام أو العروض. الحاجة الوحيدة اللي البوت بيدور عليها هي رسالة
  //       الأدمن "مبروك @الفايز" عشان يعلن النتيجة ويقفل ويرتب الروم.
  //       لو الروم مقفول (مفيش مزاد جاري في activeAuctions) → تجاهل الرسالة.
  if (AUCTION_ROOM_CHANNEL_IDS.includes(channel.id)) {
    // ── فلتر الشتايم داخل رومات المزاد ──────────────────────────────────
    const foundBadWordAuction = findBadWord(content);
    if (foundBadWordAuction) {
      await message.delete().catch(() => {});
      const { warningCount, banned: nowBanned } = await addWarning(
        userId, username, `استخدام لفظ خارج: "${foundBadWordAuction}"`, content
      );
      await sendWarningEmbed(
        channel, userId,
        nowBanned ? "تم الحظر" : `تحذير ${warningCount}/3`,
        nowBanned
          ? `⛔ تم حظرك لمدة 4 أيام (وصلت 3 تحذيرات). آخر تحذير: استخدام ألفاظ خارجة.`
          : `رسالتك اتحذفت — ممنوع استخدام ألفاظ خارجة.`,
        message.guild
      );
      return;
    }

    const auction = activeAuctions.get(channel.id);
    if (!auction) return; // الروم مقفول أو مفيش مزاد جاري

    const isAdminMsg = (message.member?.permissions.has(PermissionFlagsBits.Administrator)) ?? false;
    if (isAdminMsg && /مبروك/.test(content)) {
      const winner = message.mentions.users.first();
      if (winner && message.guild) {
        await endAuctionManual(message.guild, channel.id, winner.id).catch((e) =>
          logger.error({ e }, "endAuctionManual error"),
        );
      }
    }
    return; // البوت ملوش تدخل تاني في رومات المزاد — إدارة المزايدة يدوية بالكامل
  }

  // ── روم الطلبيات الثابت — أي حد يبعت فيه، المسموح بس @everyone/@here/طلبيات ──
  // NOTE: مش زي رومات العملاء (isRoomChannel) — ده روم عام مفتوح للكل، مش
  //       مرتبط بشراء معين. سلوموود الساعة متحطوطة تلقائياً في ClientReady.
  if (channel.id === ORDERS_STATIC_CHANNEL_ID) {
    const usedEveryoneO = /@everyone/i.test(content);
    const usedHereO     = /@here/i.test(content);
    const usedOrdersO   = new RegExp(`<@&${ORDERS_ROLE_ID}>`).test(content);
    const usedOffersO   = new RegExp(`<@&${OFFERS_ROLE_ID}>`).test(content);
    const usedAuctionO  = new RegExp(`<@&${AUCTION_ROLE_ID}>`).test(content);

    // ── @offers والمزاد ممنوعين في روم الطلبيات — يتحذفوا حتى لو صاحبهم معفي من AutoMod ──
    if (usedOffersO || usedAuctionO) {
      await message.delete().catch(() => {});
      await sendWarningEmbed(
        channel, userId, "منشن ممنوع",
        "روم الطلبيات مسموح فيه منشن @everyone / @here / طلبيات بس — منشن @offers أو مزاد ممنوع هنا.",
        message.guild
      );
      return;
    }

    if (usedEveryoneO || usedHereO || usedOrdersO) {
      const isAdminO = (message.member ?? await message.guild.members.fetch(userId).catch(() => null))
        ?.permissions.has(PermissionFlagsBits.Administrator) ?? false;

      if (!isAdminO) {
        const u = await getOrCreateUser(userId, username);

        const updates: Partial<{ everyoneBalance: number; hereBalance: number; ordersBalance: number }> = {};
        if (usedEveryoneO) updates.everyoneBalance = Math.max(0, u.everyoneBalance - 1);
        if (usedHereO)     updates.hereBalance     = Math.max(0, u.hereBalance     - 1);
        if (usedOrdersO)   updates.ordersBalance   = Math.max(0, u.ordersBalance   - 1);

        await db
          .update(botUsersTable)
          .set(updates)
          .where(eq(botUsersTable.discordUserId, userId));

        const newEveryoneO = updates.everyoneBalance ?? u.everyoneBalance;
        const newHereO     = updates.hereBalance     ?? u.hereBalance;
        const newOrdersO   = updates.ordersBalance   ?? u.ordersBalance;
        const hasBalanceO  = newEveryoneO > 0 || newHereO > 0 || newOrdersO > 0 ||
                             u.offersBalance > 0 || u.auctionBalance > 0;

        if (!hasBalanceO) {
          await revokeMentionRole(message.guild, userId);
          await sendWarningEmbed(
            channel, userId, "رصيد المنشنات خلص",
            `رصيد المنشنات خلص — مش هتقدر تمنشن تاني لحد ما الأدمن يجدد.\n` +
            `📊 الرصيد الحالي:\n` +
            `  📢 @everyone: ${newEveryoneO}\n` +
            `  📣 @here: ${newHereO}\n` +
            `  📦 طلبيات: ${newOrdersO}`,
            message.guild
          );
        } else {
          await revokeMentionRoleWithCooldown(message.guild, userId, MENTION_COOLDOWN_MS);
          const linesO: string[] = [];
          if (usedEveryoneO) linesO.push(`📢 @everyone: تبقى ${newEveryoneO} منشن`);
          if (usedHereO)     linesO.push(`📣 @here: تبقى ${newHereO} منشن`);
          if (usedOrdersO)   linesO.push(`📦 طلبيات: تبقى ${newOrdersO} منشن`);
          linesO.push(`⏳ الكولداون: 30 دقيقة قبل ما تقدر تمنشن تاني.`);
          await sendWarningEmbed(channel, userId, "تم خصم منشن", linesO.join("\n"), message.guild);
        }
      }
    }
    return;
  }

  // ── فحص رومات العملاء (completed purchases) ──────────────────────────────
  // NOTE: البوت بيراقب رسائل الشانلات اللي اشتراها العملاء فقط.
  //       الشانلات التانية (زي التذاكر) بيراقبها بس لاسم الروم (تحت).
  const roomPurchase = await db
    .select({
      id:                   purchasesTable.id,
      ownerId:              purchasesTable.discordUserId,
      partnerDiscordUserId: purchasesTable.partnerDiscordUserId,
    })
    .from(purchasesTable)
    .where(
      and(
        eq(purchasesTable.discordRoomId, channel.id),
        eq(purchasesTable.status, "completed")
      )
    )
    .then((rows) => rows[0] ?? null);

  const isRoomChannel = roomPurchase !== null;

  // ── فلتر الشتايم (رومات البوت والتذاكر فقط) ─────────────────────────────
  // NOTE: المطابقة بتشتغل على مستوى الكلمة الكاملة فقط — مش جزء من كلمة.
  //       الشانلات اللي برا سيطرة البوت (رومات عادية، عامة، إلخ) بيتجاهلها.
  //       isTicketChannel: الشانل تحت كاتيجوري التذاكر (TICKETS_CATEGORY_ID).
  const isTicketChannel = (channel as import("discord.js").TextChannel).parentId === TICKETS_CATEGORY_ID;
  if (isRoomChannel || isTicketChannel) {
    const foundBadWord = findBadWord(content);
    if (foundBadWord) {
      await message.delete().catch(() => {});
      const { warningCount, banned: nowBanned } = await addWarning(
        userId, username, `استخدام لفظ خارج: "${foundBadWord}"`, content
      );
      await sendWarningEmbed(
        channel, userId,
        nowBanned ? "تم الحظر" : `تحذير ${warningCount}/3`,
        nowBanned
          ? `⛔ تم حظرك لمدة 4 أيام (وصلت 3 تحذيرات). آخر تحذير: استخدام ألفاظ خارجة.`
          : `رسالتك اتحذفت — ممنوع استخدام ألفاظ خارجة.`,
        message.guild
      );
      return;
    }
  }

  if (isRoomChannel) {

    // ── تلقائي للخطوط: استقبال الصورة لو في انتظار ────────────────────────
    const pendingImg = pendingAutoLineImages.get(userId);
    if (pendingImg && pendingImg.roomChannelId === channel.id) {
      const attachment = message.attachments.first();
      if (attachment) {
        clearTimeout(pendingImg.timeoutId);
        pendingAutoLineImages.delete(userId);

        // حمّل الصورة كـ Buffer — مش رابط CDN (بيتنهي صلاحيته)
        let imageBuffer: Buffer;
        try {
          const res = await fetch(attachment.url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          imageBuffer = Buffer.from(await res.arrayBuffer());
        } catch (err) {
          logger.warn({ err, userId }, "Failed to download auto_lines image");
          await channel.send(`❌ <@${userId}> فشل تحميل الصورة، ابعتها تاني.`).catch(() => {});
          // أعد تفعيل الانتظار
          const retryTimeout = setTimeout(() => { pendingAutoLineImages.delete(userId); }, AUTO_LINES_IMAGE_TIMEOUT_MS);
          pendingAutoLineImages.set(userId, { ...pendingImg, timeoutId: retryTimeout });
          return;
        }

        activeAutoLines.set(userId, {
          ownerId:       userId,
          roomChannelId: pendingImg.roomChannelId,
          imageName:     attachment.name,
          imageBuffer,
        });

        await channel.send(
          `✅ <@${userId}> تمام! البوت هيبعت الصورة دي بعد كل رسالة تنزل من انت أو شريكك في المتجر. 🖼️`
        ).catch(() => {});
        return;
      }
    }

    // ── انتظار منشن الشريك بعد تأكيد الدفع ──────────────────────────────
    const awaitingMention = awaitingPartnerMention.get(userId);
    if (awaitingMention && awaitingMention.roomChannelId === channel.id) {
      const mentionedUser = message.mentions.users.first();
      if (!mentionedUser || mentionedUser.bot || mentionedUser.id === userId) {
        await channel.send(`<@${userId}> منشن اليوزر اللي عايزه شريك! (يوزر واحد بس)`).catch(() => {});
        return;
      }
      clearTimeout(awaitingMention.timeoutId);
      awaitingPartnerMention.delete(userId);

      // أضف صلاحيات الشريك للشانل
      await channel.permissionOverwrites.edit(mentionedUser.id, {
        ViewChannel:     true,
        SendMessages:    true,
        MentionEveryone: true,
      }).catch(() => {});

      // ادّيه رول "منشن مفعّل"
      if (message.guild) await grantMentionRole(message.guild, mentionedUser.id).catch(() => {});

      // حدّث DB
      await db.update(purchasesTable)
        .set({ partnerDiscordUserId: mentionedUser.id })
        .where(eq(purchasesTable.id, awaitingMention.purchaseId));

      // إمبيد نجاح
      const DIV_AP = "ـﮩ════════════════ﮩـ";
      const gIAP   = message.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;
      const apSuccessEmbed = new EmbedBuilder()
        .setAuthor({ name: "Dragon $hop", iconURL: gIAP })
        .setTitle("✅ تمت إضافة الشريك بنجاح!")
        .setDescription(
          `<@${userId}>\n> ${DIV_AP}\n\n` +
          `الشريك: <@${mentionedUser.id}>\n` +
          `الشريك يقدر دلوقتي ينزل في روومك كأنه بتاعه 🤝\n\n` +
          `> ${DIV_AP}`
        )
        .setColor(0x00ff88)
        .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: gIAP });

      const apFiles: AttachmentBuilder[] = [];
      if (fs.existsSync(DRAGON_TEXT_BANNER_PATH)) {
        apFiles.push(new AttachmentBuilder(DRAGON_TEXT_BANNER_PATH, { name: "dragon_text_banner.webp" }));
        apSuccessEmbed.setImage("attachment://dragon_text_banner.webp");
      }
      await channel.send({ embeds: [apSuccessEmbed], files: apFiles }).catch(() => {});
      return;
    }

    // ── حذف اللينكات ────────────────────────────────────────────────────
    if (containsLink(content)) {
      await message.delete().catch(() => {});
      const { warningCount, banned: nowBanned } = await addWarning(
        userId, username, "نشر لينك", content
      );
      await sendWarningEmbed(
        channel, userId,
        nowBanned ? "تم الحظر" : `تحذير ${warningCount}/3`,
        nowBanned
          ? `⛔ تم حظرك لمدة 4 أيام (وصلت 3 تحذيرات). آخر تحذير: نشر لينك.`
          : `رسالتك اتحذفت — ممنوع نشر لينكات.`,
        message.guild
      );
      return;
    }

    // ── حذف الكلام المشفر يدوياً ─────────────────────────────────────────
    if (isSelfEncoded(content)) {
      await message.delete().catch(() => {});
      // أبعت النسخة المشفرة في الشانل للـ logging
      await channel.send(`🔒 رسالة مشفرة من ${message.author}:\n${encodeArabicFranco(content)}`);
      const { warningCount, banned: nowBanned } = await addWarning(
        userId, username, "محاولة تشفير الكلام يدوياً", content
      );
      await sendWarningEmbed(
        channel, userId,
        nowBanned ? "تم الحظر" : `تحذير ${warningCount}/3`,
        nowBanned
          ? `⛔ تم حظرك لمدة 4 أيام (وصلت 3 تحذيرات).`
          : `البوت بيشفر الكلام تلقائياً، ممنوع تشفره بنفسك.`,
        message.guild
      );
      return;
    }

    // ── حذف اسبام المنشنات ───────────────────────────────────────────────
    if (containsSpamMention(content)) {
      await message.delete().catch(() => {});
      const { warningCount, banned: nowBanned } = await addWarning(
        userId, username, "اسبام منشن", content
      );
      await sendWarningEmbed(
        channel, userId,
        nowBanned ? "تم الحظر" : `تحذير ${warningCount}/3`,
        nowBanned
          ? `⛔ تم حظرك لمدة 4 أيام (وصلت 3 تحذيرات). آخر تحذير: اسبام منشنات.`
          : `ممنوع اسبام المنشنات.`,
        message.guild
      );
      return;
    }

    // ── فلتر المنشنات (جوه الرومات فقط) ────────────────────────────────────
    // NOTE: AutoMod "Bot - Mention Block" بيحجب المنشنات لأي حد مالوش رول "منشن مفعّل".
    //       لو الرسالة وصلت هنا معناها:
    //         • صاحب الروم عنده الرول (مش محتاج نفحص الملكية يدوياً)
    //         • الكولداون خلص (الرول اتسحب أثناء الكولداون)
    //       البوت هنا بيخصم الرصيد ويدير الرول بعد المنشن.
    const usedEveryone = /@everyone/i.test(content);
    const usedHere     = /@here/i.test(content);
    const usedOffers   = new RegExp(`<@&${OFFERS_ROLE_ID}>`).test(content);
    const usedOrders   = new RegExp(`<@&${ORDERS_ROLE_ID}>`).test(content);
    const usedAuction  = new RegExp(`<@&${AUCTION_ROLE_ID}>`).test(content);

    if (usedEveryone || usedHere || usedOffers || usedOrders || usedAuction) {
      // ── الأدمنستراتور: رصيد لا نهائي — لا خصم ولا كولداون ──────────────
      const isAdmin = (message.member ?? await message.guild.members.fetch(userId).catch(() => null))
        ?.permissions.has(PermissionFlagsBits.Administrator) ?? false;

      if (!isAdmin) {
        // لو المُرسِل هو الشريك → اخصم من رصيد الأونر وطبّق الكولداون عليهم الاتنين
        const isPartner   = roomPurchase?.partnerDiscordUserId === userId;
        const effectiveId = isPartner ? (roomPurchase!.ownerId) : userId;
        const effectiveName = isPartner
          ? ((await message.guild.members.fetch(effectiveId).catch(() => null))?.user.username ?? effectiveId)
          : username;

        const u = await getOrCreateUser(effectiveId, effectiveName);

        const updates: Partial<{
          everyoneBalance: number;
          hereBalance:     number;
          offersBalance:   number;
          ordersBalance:   number;
          auctionBalance:  number;
        }> = {};
        if (usedEveryone) updates.everyoneBalance = Math.max(0, u.everyoneBalance - 1);
        if (usedHere)     updates.hereBalance     = Math.max(0, u.hereBalance     - 1);
        if (usedOffers)   updates.offersBalance   = Math.max(0, u.offersBalance   - 1);
        if (usedOrders)   updates.ordersBalance   = Math.max(0, u.ordersBalance   - 1);
        if (usedAuction)  updates.auctionBalance  = Math.max(0, u.auctionBalance  - 1);

        await db
          .update(botUsersTable)
          .set(updates)
          .where(eq(botUsersTable.discordUserId, effectiveId));

        const newEveryone = updates.everyoneBalance ?? u.everyoneBalance;
        const newHere     = updates.hereBalance     ?? u.hereBalance;
        const newOffers   = updates.offersBalance   ?? u.offersBalance;
        const newOrders   = updates.ordersBalance   ?? u.ordersBalance;
        const newAuction  = updates.auctionBalance  ?? u.auctionBalance;
        const hasBalance  = newEveryone > 0 || newHere > 0 || newOffers > 0 || newOrders > 0 || newAuction > 0;

        // الشريك الحالي (لتطبيق الكولداون عليه أيضاً)
        const partnerId = roomPurchase?.partnerDiscordUserId ?? null;

        if (!hasBalance) {
          await revokeMentionRole(message.guild, effectiveId);
          if (partnerId && partnerId !== effectiveId) await revokeMentionRole(message.guild, partnerId).catch(() => {});
          await sendWarningEmbed(
            channel, userId, "رصيد المنشنات خلص",
            `رصيد المنشنات ${isPartner ? "بتاع صاحب الروم" : "بتاعك"} خلص — مش هتقدر تمنشن تاني لحد ما الأدمن يجدد.\n` +
            `📊 الرصيد الحالي:\n` +
            `  📢 @everyone: ${newEveryone}\n` +
            `  📣 @here: ${newHere}\n` +
            `  🔔 @offers: ${newOffers}\n` +
            `  📦 طلبيات: ${newOrders}\n` +
            `  🏷️ مزاد: ${newAuction}`,
            message.guild
          );
        } else {
          // طبّق الكولداون على الأونر والشريك مع بعض
          await revokeMentionRoleWithCooldown(message.guild, effectiveId, MENTION_COOLDOWN_MS);
          if (partnerId && partnerId !== effectiveId) {
            await revokeMentionRoleWithCooldown(message.guild, partnerId, MENTION_COOLDOWN_MS).catch(() => {});
          }
          const lines: string[] = [];
          if (usedEveryone) lines.push(`📢 @everyone: تبقى ${newEveryone} منشن`);
          if (usedHere)     lines.push(`📣 @here: تبقى ${newHere} منشن`);
          if (usedOffers)   lines.push(`🔔 @offers: تبقى ${newOffers} منشن`);
          if (usedOrders)   lines.push(`📦 طلبيات: تبقى ${newOrders} منشن`);
          if (usedAuction)  lines.push(`🏷️ مزاد: تبقى ${newAuction} منشن`);
          lines.push(`⏳ الكولداون: 30 دقيقة قبل ما تقدر تمنشن تاني.`);
          await sendWarningEmbed(channel, userId, "تم خصم منشن", lines.join("\n"), message.guild);
        }
      }
      // الأدمن: مفيش خصم ولا إشعار
    }

    // ── تلقائي للخطوط: إرسال الصورة بعد كل رسالة من الأونر أو الشريك ─────
    // NOTE: الفحص بيتم في آخر الـ isRoomChannel block بعد كل مودريشن
    //       يعني الرسائل اللي اتحذفت مش هيتبعت بعدها صورة
    const ownerAutoLines = activeAutoLines.get(roomPurchase!.ownerId);
    const isRoomOwner   = userId === roomPurchase!.ownerId;
    const isRoomPartner = roomPurchase!.partnerDiscordUserId != null && userId === roomPurchase!.partnerDiscordUserId;
    if (ownerAutoLines) {
      if (isRoomOwner || isRoomPartner) {
        await channel.send({
          files: [new AttachmentBuilder(ownerAutoLines.imageBuffer, { name: ownerAutoLines.imageName })],
        }).catch(() => {});
      }
    }

    // ── تشفير رسائل صاحب المتجر + زرار "طلب المنتج" ──────────────────────
    // NOTE: أي رسالة من الأونر/الشريك في الروم (بعد ما تعدي كل المودريشن
    //       فوق) بتتمسح وتتبعت تاني عن طريق webhook بنفس الاسم والصورة،
    //       بس بمحتوى متشفر (encodeArabicFranco)، وتحتها زرار طلب المنتج.
    if (isRoomOwner || isRoomPartner) {
      const requestProductRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`request_product_${channel.id}`)
          .setEmoji({ id: "1524536738360328347", name: "rfn", animated: true })
          .setLabel("طلب المنتج")
          .setStyle(ButtonStyle.Success),
      );

      const encodedContent = message.content ? encodeArabicFranco(message.content) : "";
      const attachmentUrls = message.attachments.map((a) => a.url);
      const webhook = await getOrCreateStoreWebhook(channel);

      if (webhook && (encodedContent || attachmentUrls.length > 0)) {
        const relayed = await webhook.send({
          username:  message.member?.displayName ?? message.author.username,
          avatarURL: message.author.displayAvatarURL(),
          content:   encodedContent || undefined,
          files:     attachmentUrls.length ? attachmentUrls : undefined,
          components: [requestProductRow],
        }).catch((err) => {
          logger.error({ err, channelId: channel.id }, "Failed to relay store message via webhook");
          return null;
        });

        if (relayed) {
          await message.delete().catch(() => {});
        } else {
          // فشل الـ webhook — سيب الرسالة الأصلية وحط الزرار تحتها بدل ما تضيع
          await message.reply({ components: [requestProductRow] }).catch(() => {});
        }
      } else {
        // مفيش webhook أو رسالة فاضية (زي رسائل الستيكرز) — رد عادي بالزرار
        await message.reply({ components: [requestProductRow] }).catch(() => {});
      }
    }
  }

  // ── أونر يمنشن البوت في تكت شراء → تخطي الدفع ───────────────────────────
  // لو أونر (OWNER_ID أو Administrator) كتب @البوت في تكت شراء متجر أو مزاد pending،
  // البوت يرد "حاضر يعمنا" ويعتبر الدفع اتم ويكمل الخطوة اللي بعده مباشرة
  // (اسم المتجر للشراء العادي، أو سؤال "المزاد على ايه؟" للمزاد).
  if (
    client.user &&
    message.mentions.has(client.user.id) &&
    !isRoomChannel
  ) {
    const senderMember =
      message.guild.members.cache.get(userId) ??
      (await message.guild.members.fetch(userId).catch(() => null));
    const senderIsOwner =
      userId === OWNER_ID ||
      (senderMember?.permissions.has(PermissionFlagsBits.Administrator) ?? false);

    if (senderIsOwner) {
      // ابحث عن تذكرة شراء متجر pending في نفس الشانل
      const pendingTicket = await db
        .select()
        .from(purchasesTable)
        .where(
          and(
            eq(purchasesTable.ticketChannelId, channel.id),
            eq(purchasesTable.status, "pending")
          )
        )
        .then((rows) => rows[0]);

      if (pendingTicket) {
        // ✅ رد الأونر
        await message.reply("حاضر يعمنا <:cry:1504829193278460004>");

        // انقل الشراء لمرحلة انتظار اسم الروم
        await db
          .update(purchasesTable)
          .set({ status: "awaiting_room_name" })
          .where(eq(purchasesTable.id, pendingTicket.id));

        // اسأل الشاري عن اسم المتجر
        await channel.send(
          `✅ تم تأكيد الطلب!\n\n` +
          `<@${pendingTicket.discordUserId}> اكتب اسم الروم اللي عايزه هنا ⬇️\n` +
          `*(بالعربي أو الانجليزي، بدون زخارف أو إيموجيات)*`
        );
        return;
      }

      // ابحث عن تذكرة مزاد pending_payment في نفس الشانل
      const pendingAucTicket = await db
        .select()
        .from(auctionSchedulesTable)
        .where(
          and(
            eq(auctionSchedulesTable.ticketChannelId, channel.id),
            eq(auctionSchedulesTable.status, "pending_payment"),
          ),
        )
        .then((rows) => rows[0]);

      if (pendingAucTicket) {
        // ✅ رد الأونر
        await message.reply("حاضر يعمنا <:cry:1504829193278460004>");

        // اعتبر الدفع اتم — بعت زرار التفاصيل
        await db
          .update(auctionSchedulesTable)
          .set({ status: "awaiting_item" })
          .where(eq(auctionSchedulesTable.id, pendingAucTicket.id));

        const ownerSkipDetailsBtn = new ButtonBuilder()
          .setCustomId(`auc_item_modal_btn_${pendingAucTicket.id}`)
          .setLabel("📝 أدخل تفاصيل المزاد")
          .setStyle(ButtonStyle.Primary);

        await channel.send({
          content:
            `✅ **تم تأكيد الدفع!**\n\n` +
            `<@${pendingAucTicket.discordUserId}>\n\n` +
            `📦 **اضغط الزر عشان تدخل تفاصيل المزاد — البوت هيحجزلك ميعاد تلقائياً بعدها.**`,
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(ownerSkipDetailsBtn)],
        });
        return;
      }
    }
  }

  // ── awaiting_item / awaiting_payment_method ──────────────────────────────
  // الأسئلة دي بقت تتجاوب من خلال المودال (auc_item_modal_btn_*) مش نص.
  // مفيش هاندلر نص هنا — البوت بيتجاهل أي رسالة في التذكرة بعد تأكيد الدفع
  // لحد ما اليوزر يضغط الزرار ويسبمت المودال.

  // ── انتظار اسم الروم بعد تأكيد الدفع ────────────────────────────────────
  // NOTE: بعد ما ProBot يتحقق، الـ status بيبقى "awaiting_room_name".
  //       الرسالة الجاية من نفس اليوزر في نفس الشانل بتعتبر اسم الروم.
  //       الاسم بيتعمله format تلقائي: `私 ₊˚✧{زخرفة}| {الاسم}`
  const pendingPurchase = await db
    .select()
    .from(purchasesTable)
    .where(
      and(
        eq(purchasesTable.discordUserId, userId),
        eq(purchasesTable.status, "awaiting_room_name"),
        eq(purchasesTable.ticketChannelId, channel.id)
      )
    )
    .then((rows) => rows[0]);

  if (pendingPurchase) {
    const rawName = content.trim();
    if (!rawName || rawName.length > 32) {
      await channel.send(`⚠️ الاسم ده مش صالح. اكتب اسم بين 1 و 32 حرف.`);
      return;
    }

    const [room] = await db
      .select()
      .from(roomsTable)
      .where(eq(roomsTable.id, pendingPurchase.roomId));
    if (!room) return;

    const finalName  = `私 ₊˚✧${room.decorations || ""}| ${rawName}`;
    const totalPrice = calcTransferAmount(Number(room.price));

    await db
      .update(purchasesTable)
      .set({
        customRoomName: finalName,
        status:         "awaiting_room_creation",
        totalPrice:     String(totalPrice),
      })
      .where(eq(purchasesTable.id, pendingPurchase.id));

    try {
      // إنشاء شانل الروم في Discord
      const newChannel = await message.guild.channels.create({
        name:   finalName,
        type:   ChannelType.GuildText,
        parent: room.discordCategoryId ?? undefined,
        permissionOverwrites: [
          { id: message.guild.id, deny:  [PermissionFlagsBits.ViewChannel] },
          {
            id:    userId,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.MentionEveryone,
            ],
          },
        ],
      });

      // حدّث DB بـ Discord channel ID والـ status
      await db
        .update(purchasesTable)
        .set({ discordRoomId: newChannel.id, status: "completed" })
        .where(eq(purchasesTable.id, pendingPurchase.id));

      // أضف رصيد المنشنات للعميل
      const u = await getOrCreateUser(userId, username);
      if (room.offersCount > 0)
        await db
          .update(botUsersTable)
          .set({ offersBalance: u.offersBalance + room.offersCount })
          .where(eq(botUsersTable.discordUserId, userId));
      if (room.hereCount > 0)
        await db
          .update(botUsersTable)
          .set({ hereBalance: u.hereBalance + room.hereCount })
          .where(eq(botUsersTable.discordUserId, userId));
      if (room.everyoneCount > 0)
        await db
          .update(botUsersTable)
          .set({ everyoneBalance: u.everyoneBalance + room.everyoneCount })
          .where(eq(botUsersTable.discordUserId, userId));

      // دي رول "منشن مفعّل" — بيخلي صاحب الروم يمنشن ويعدي على AutoMod
      await grantMentionRole(message.guild, userId);

      // ── إمبيد ترحيبي داخل الروم الجديد ────────────────────────────────
      const guildIconURL    = message.guild.iconURL({ extension: "png", size: 256 }) ?? undefined;
      const welcomeFiles: AttachmentBuilder[] = [];
      const DIV_W = "ـﮩ════════════════ﮩـ";

      const rulesText =
        `> 1️⃣ ممنوع السب أو نشر أي نوع من المحتوى الغير لائق أو التلميح له\n` +
        `> ${DIV_W}\n` +
        `> 2️⃣ ممنوع نشر أي نوع من اللينكات\n` +
        `> ${DIV_W}\n` +
        `> 3️⃣ لا تحاول استخدام منشنات أكثر من رصيدك\n` +
        `> ${DIV_W}\n` +
        `> 4️⃣ ممنوع الترويج للسيرفرات\n` +
        `> ${DIV_W}\n` +
        `> 5️⃣ ممنوع الإسبام\n` +
        `> ${DIV_W}`;

      const welcomeEmbed = new EmbedBuilder()
        .setAuthor({ name: "Dragon $hop", iconURL: guildIconURL })
        .setTitle(`🎉 أهلاً بك في روومك يا <@${userId}>!`)
        .setDescription(
          `> ${DIV_W}\n` +
          `> مبروك عليك الروم! هنا مساحتك الخاصة.\n` +
          `> ${DIV_W}`
        )
        .setThumbnail(guildIconURL ?? null)
        .addFields({ name: `📋 قوانين الروم`, value: rulesText, inline: false })
        .setColor(0xf5c518)
        .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: guildIconURL });

      // أضف البانر الرئيسي كصورة أسفل الإمبيد
      if (fs.existsSync(DRAGON_BANNER_PATH)) {
        welcomeFiles.push(new AttachmentBuilder(DRAGON_BANNER_PATH, { name: "dragon_banner.webp" }));
        welcomeEmbed.setImage("attachment://dragon_banner.webp");
      }

      // أرسل الخط (text banner) كصورة مستقلة أعلى الإمبيد — بانر "قوانين المتاجر"
      if (fs.existsSync(STORES_RULES_BANNER_PATH)) {
        await newChannel.send({
          files: [new AttachmentBuilder(STORES_RULES_BANNER_PATH, { name: "dragon_text_banner.webp" })],
        }).catch(() => {});
      }

      // أرسل الإمبيد الترحيبي
      await newChannel.send({ embeds: [welcomeEmbed], files: welcomeFiles }).catch(() => {});

      // ── رسالة التهنئة في تكت الشراء ────────────────────────────────────
      const bannerFiles: AttachmentBuilder[] = [];
      const completionEmbed = new EmbedBuilder()
        .setTitle("🎉 تم إنشاء الروم!")
        .setDescription(
          `**اسم الروم:** ${finalName}\n` +
          `**رابط الروم:** <#${newChannel.id}>\n\n` +
          `${STAR_EMOJI} مبروك! الروم بتاعك اتعمل بنجاح.`
        )
        .setColor(0x00ff88);

      if (fs.existsSync(DRAGON_BANNER_PATH)) {
        bannerFiles.push(new AttachmentBuilder(DRAGON_BANNER_PATH, { name: "dragon_banner.webp" }));
        completionEmbed.setImage("attachment://dragon_banner.webp");
      }

      await channel.send({ embeds: [completionEmbed], files: bannerFiles });

      // أغلق التكت تلقائياً بعد 5 ثواني من إنشاء الروم
      setTimeout(() => channel.delete("Ticket closed after room creation").catch(() => {}), 5000);
    } catch (err) {
      logger.error({ err }, "Failed to create Discord room channel");
      await channel.send(`❌ حصل خطأ وقت إنشاء الروم. تواصل مع الأدمن.`);
    }
    return;
  }
  } catch (err) {
    logger.error({ err, messageId: message.id }, "Unhandled error in MessageCreate");
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  InteractionCreate — معالجة التفاعلات (أزرار + Slash Commands)
// ══════════════════════════════════════════════════════════════════════════════
client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  try {

  // ══════════════════════════════════════════════════════════════════════════
  //  BUTTONS
  // ══════════════════════════════════════════════════════════════════════════

  // ── زرار فئة المتجر (shopcat_*) ─────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("shopcat_")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const category = interaction.customId.replace("shopcat_", "");

    // ── فئة الإضافات (معالجة خاصة) ────────────────────────────────────────
    if (category === "الإضافات") {
      // NOTE: الإضافات مش رومات من DB — أسعارها في addon_prices table.
      //       عشان كده بنعمل embed خاص بيها مع أزرار كل إضافة.
      const guildIconURL = interaction.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;
      const embed = new EmbedBuilder()
        .setAuthor({ name: "Dragon $hop", iconURL: guildIconURL })
        .setTitle("أسعار الإضافات")
        .setDescription("أختر زر بالأسفل لمعرفة سعر الإضافة")
        .setColor(0x00bfff)
        .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p" });

      if (guildIconURL) embed.setThumbnail(guildIconURL);

      const files: AttachmentBuilder[] = [];
      if (fs.existsSync(ADDONS_BANNER_PATH)) {
        files.push(new AttachmentBuilder(ADDONS_BANNER_PATH, { name: "dragon_text_banner.webp" }));
        embed.setImage("attachment://dragon_text_banner.webp");
      }

      // بناء الأزرار من ADDONS array
      // ⚠️ راجع ملاحظة RTL في تعريف ADDONS array فوق
      const addonButtons = ADDONS.map((a) =>
        new ButtonBuilder()
          .setCustomId(`addoninfo_${a.key}`)
          .setLabel(a.label)
          .setEmoji(PEEPO_EMOJI)
          .setStyle(ButtonStyle.Secondary)
      );

      // سعر ثابت (مش من ADDONS/addon_prices) — بس زرار دخول لنفس الـ addoninfo_ handler
      addonButtons.push(
        new ButtonBuilder()
          .setCustomId("addoninfo_change_store_name")
          .setLabel("سعر تغيير اسم المتجر")
          .setEmoji(PEEPO_EMOJI)
          .setStyle(ButtonStyle.Secondary)
      );

      const components: ActionRowBuilder<ButtonBuilder>[] = [];
      let idx = 0;
      for (const rowSize of ADDON_ROW_SIZES) {
        const slice = addonButtons.slice(idx, idx + rowSize);
        if (slice.length > 0) components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...slice));
        idx += rowSize;
      }

      await interaction.editReply({ embeds: [embed], files, components });
      return;
    }

    // ── فئة المزاد (معالجة خاصة — يبعت الإمبيد في شانل المزاد) ──────────
    if (category === "المزاد") {
      const guild        = interaction.guild!;
      const guildIconURL = guild.iconURL({ extension: "png", size: 256 }) ?? undefined;

      // الإيموجيز المخصصة
      const STAR_EMOJI   = "<a:money:1524536753858285568>";
      const ZOOM_EMOJI   = "<a:aPES_Zoom:1496140715988619274>";
      const PROBOT_EMOJI_AUC = "<a:by_ez_84:1495757810569449603>";

      // ── الإمبيد المزخرف ─────────────────────────────────────────────────
      const auctionEmbed = new EmbedBuilder()
        .setAuthor({ name: "Dragon $hop", iconURL: guildIconURL })
        .setTitle("🏷️ الـ آسعار الـ مـزادات")
        .setColor(0xffd700)
        .addFields(
          {
            name:   "ـﮩ══════════════ﮩـ",
            value:
              `${STAR_EMOJI} **منشن :**\n` +
              `• ${ZOOM_EMOJI} @everyone\n\n` +
              `💰 **السعر :**\n` +
              `• ${PROBOT_EMOJI_AUC} 10,000,000\n` +
              `ـﮩ══════════════ﮩـ`,
            inline: false,
          },
          {
            name:   "\u200b",
            value:
              `${STAR_EMOJI} **منشن :**\n` +
              `• ${ZOOM_EMOJI} @here\n\n` +
              `💰 **السعر :**\n` +
              `• ${PROBOT_EMOJI_AUC} 5,000,000\n` +
              `ـﮩ══════════════ﮩـ`,
            inline: false,
          },
          {
            name:   "\u200b",
            value:
              `${STAR_EMOJI} **منشن :**\n` +
              `• ${ZOOM_EMOJI} <@&${AUCTION_ROLE_ID}>\n\n` +
              `💰 **السعر :**\n` +
              `• ${PROBOT_EMOJI_AUC} 3,000,000\n` +
              `ـﮩ══════════════ﮩـ`,
            inline: false,
          },
        )
        .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p" });

      if (guildIconURL) auctionEmbed.setThumbnail(guildIconURL);

      const auctionFiles: AttachmentBuilder[] = [];
      if (fs.existsSync(AUCTION_BANNER_PATH)) {
        auctionFiles.push(new AttachmentBuilder(AUCTION_BANNER_PATH, { name: "dragon_text_banner.webp" }));
        auctionEmbed.setImage("attachment://dragon_text_banner.webp");
      }

      // NOTE: أزرار الشراء اتشالت من هنا — الشراء بقى بس من قائمة "🛒 شراء" المنفصلة (openbuymenu).
      //       الإمبيد ده بقى لعرض الأسعار فقط.
      await interaction.editReply({ embeds: [auctionEmbed], files: auctionFiles });

      // ── شانل المزاد: شرح — مرة واحدة فقط للأبد ─────────────────────────
      // NOTE: auctionInfoMsgId بيتعبى من الشانل عند كل restart.
      //       لو موجود → ما نبعتش تاني. المواعيد تتحدث تلقائياً في رسالة منفصلة.
      if (!auctionInfoMsgId) {
        const infoCh = await guild.channels.fetch(AUCTION_INFO_CHANNEL_ID).catch(() => null) as TextChannel | null;
        if (infoCh) {
          const howEmbed = new EmbedBuilder()
            .setAuthor({ name: "Dragon $hop", iconURL: guildIconURL })
            .setTitle("🎰 كيف يعمل المزاد؟")
            .setDescription(
              `1️⃣ اختر نوع المزاد\n` +
              `2️⃣ اختر الموعد المناسب\n` +
              `3️⃣ ادفع عبر ProBot ويتأكد حجزك\n` +
              `4️⃣ في الموعد، البوت يفتح روم المزاد تلقائياً\n` +
              `5️⃣ الناس تتزايد — من يكتب أعلى مبلغ يفوز!\n` +
              `⏱️ المزاد ينتهي بعد **دقيقتين** من آخر عرض`,
            )
            .setColor(0x5865f2)
            .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p" });

          if (guildIconURL) howEmbed.setThumbnail(guildIconURL);

          const sent = await infoCh.send({ embeds: [howEmbed] });
          auctionInfoMsgId = sent.id;

          // بعت رسالة المواعيد مباشرة بعد الشرح
          await refreshAuctionScheduleMsg(guild);
        }
      }
      return;
    }

    // ── فئات الرومات العادية ────────────────────────────────────────────────
    const rooms = await db.select().from(roomsTable).where(eq(roomsTable.category, category));

    if (rooms.length === 0) {
      await interaction.editReply({ content: `📭 مفيش رومات في فئة **${category}** دلوقتي.` });
      return;
    }

    const guildIconURL = interaction.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;
    const embed = new EmbedBuilder()
      .setAuthor({ name: "Dragon $hop", iconURL: guildIconURL })
      .setTitle("تفاصيل الانواع")
      .setDescription("لمعرفة تفاصيل النوع اضغط على النوع الذي تريده")
      .setColor(0x00bfff)
      .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p" });

    if (guildIconURL) embed.setThumbnail(guildIconURL);

    const files: AttachmentBuilder[] = [];
    const shopcatBannerPath = SHOPCAT_BANNER_PATH[category] ?? DRAGON_TEXT_BANNER_PATH;
    if (fs.existsSync(shopcatBannerPath)) {
      files.push(new AttachmentBuilder(shopcatBannerPath, { name: "dragon_text_banner.webp" }));
      embed.setImage("attachment://dragon_text_banner.webp");
    }

    const roomButtons = rooms.map((r) =>
      new ButtonBuilder()
        .setCustomId(`roominfo_${r.id}`)
        .setLabel(roomLabel(r.name))
        .setStyle(ButtonStyle.Secondary)
    );

    const components: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let i = 0; i < roomButtons.length; i += 5) {
      components.push(
        new ActionRowBuilder<ButtonBuilder>().addComponents(...roomButtons.slice(i, i + 5))
      );
    }

    await interaction.editReply({ embeds: [embed], files, components });
    return;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  بانل الشراء المباشر (/buy) — نفس فئات وأزرار بانل الأسعار (shopcat_) بالظبط،
  //  لكن هنا مفيش عرض سعر؛ الضغط على أي فئة/إضافة يودّي على طول لخطوة الدفع.
  // ══════════════════════════════════════════════════════════════════════════

  // ── زرار فئة الشراء (buycat_*) ───────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("buycat_")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const category = interaction.customId.replace("buycat_", "");

    // ── فئة الإضافات ────────────────────────────────────────────────────────
    if (category === "الإضافات") {
      const embed = new EmbedBuilder()
        .setTitle("➕ شراء إضافات")
        .setDescription("اضغط على الإضافة اللي عايز تشتريها")
        .setColor(0x2ecc71)
        .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p" });

      // NOTE: نفس شكل أزرار "أسعار الإضافات" بالظبط (Secondary + إيموجي موحّد) —
      //       بس هنا بتودّي على طول لخطوة الدفع من غير عرض سعر.
      //       منشنات (everyone/here/offers) بتستخدم نفس customId بتاع مودال الكمية
      //       (buy_mention_*) عشان تفتح المودال على طول من غير مرحلة سعر.
      //       باقي الإضافات بتستخدم quickbuy_addon_<key> اللي بيتحقق من صحة
      //       الطلب (مثلاً هل عندك متجر) وبعدين يودّيك على طول لزرار الدفع.
      const buttons = [
        new ButtonBuilder().setCustomId("buy_mention_everyone").setLabel("منشن @everyone").setEmoji(BUY_EMOJI).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("buy_mention_here").setLabel("منشن @here").setEmoji(BUY_EMOJI).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("buy_mention_shop").setLabel("منشن @offers").setEmoji(BUY_EMOJI).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("quickbuy_addon_activate_store").setLabel("تفعيل المتجر").setEmoji(BUY_EMOJI).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("quickbuy_addon_change_store_type").setLabel("تغيير نوع المتجر").setEmoji(BUY_EMOJI).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("quickbuy_addon_change_store_owner").setLabel("تغيير مالك المتجر").setEmoji(BUY_EMOJI).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("quickbuy_addon_remove_partner").setLabel("إزالة شريك").setEmoji(BUY_EMOJI).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("quickbuy_addon_add_partner").setLabel("إضافة شريك").setEmoji(BUY_EMOJI).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("quickbuy_addon_mention_requests").setLabel("منشن طلبات").setEmoji(BUY_EMOJI).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("quickbuy_addon_mention_here_requests").setLabel("منشن هير طلبات").setEmoji(BUY_EMOJI).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("quickbuy_addon_mention_everyone_requests").setLabel("منشن إيفري طلبات").setEmoji(BUY_EMOJI).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("quickbuy_addon_remove_store_warning").setLabel("إزالة تحذير").setEmoji(BUY_EMOJI).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("quickbuy_addon_auto_lines").setLabel("خطوط تلقائيه").setEmoji(BUY_EMOJI).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("quickbuy_addon_auto_publish").setLabel("نشر تلقائي").setEmoji(BUY_EMOJI).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("quickbuy_change_store_name").setLabel("تغيير اسم المتجر").setEmoji(BUY_EMOJI).setStyle(ButtonStyle.Secondary),
      ];

      const components: ActionRowBuilder<ButtonBuilder>[] = [];
      for (const rowSize of ADDON_ROW_SIZES) {
        const slice = buttons.splice(0, rowSize);
        if (slice.length > 0) components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...slice));
      }

      await interaction.editReply({ embeds: [embed], components });
      return;
    }

    // ── فئة المزاد ──────────────────────────────────────────────────────────
    if (category === "المزاد") {
      const embed = new EmbedBuilder()
        .setTitle("🏷️ شراء منشن إعلان مزاد")
        .setDescription("اختار نوع المنشن اللي عايز تشتريه")
        .setColor(0x2ecc71)
        .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p" });

      // NOTE: نفس customId بتاع buy_auc_mention_* الأصلي — بيودّيك على طول لأمر التحويل.
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("buy_auc_mention_everyone").setLabel("@everyone").setEmoji(BUY_EMOJI).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("buy_auc_mention_here").setLabel("@here").setEmoji(BUY_EMOJI).setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("buy_auc_mention_offers").setLabel("@مزاد").setEmoji(BUY_EMOJI).setStyle(ButtonStyle.Secondary),
      );

      await interaction.editReply({ embeds: [embed], components: [row] });
      return;
    }

    // ── فئات الرومات العادية ────────────────────────────────────────────────
    const rooms = await db.select().from(roomsTable).where(eq(roomsTable.category, category));

    if (rooms.length === 0) {
      await interaction.editReply({ content: `📭 مفيش رومات في فئة **${category}** دلوقتي.` });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`شراء — ${category}`)
      .setDescription("اضغط على النوع اللي عايز تشتريه — هتتفتح لك تذكرة فوراً")
      .setColor(0x2ecc71)
      .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p" });

    const buycatFiles: AttachmentBuilder[] = [];
    const buycatBannerPath = BUYCAT_BANNER_PATH[category];
    if (buycatBannerPath && fs.existsSync(buycatBannerPath)) {
      buycatFiles.push(new AttachmentBuilder(buycatBannerPath, { name: "dragon_text_banner.webp" }));
      embed.setImage("attachment://dragon_text_banner.webp");
    }

    // NOTE: بنستخدم نفس customId "buy_<roomId>" بتاع الـ handler الأصلي —
    //       ده أهم حاجة عشان منكررش منطق إنشاء التذكرة تاني.
    const roomButtons = rooms.map((r) =>
      new ButtonBuilder()
        .setCustomId(`buy_${r.id}`)
        .setLabel(roomLabel(r.name))
        .setEmoji(BUY_EMOJI)
        .setStyle(ButtonStyle.Secondary)
    );

    const components: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let i = 0; i < roomButtons.length; i += 5) {
      components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...roomButtons.slice(i, i + 5)));
    }

    await interaction.editReply({ embeds: [embed], files: buycatFiles, components });
    return;
  }

  // ── أزرار الشراء السريع للإضافات (quickbuy_addon_*, quickbuy_change_store_name) ──
  // NOTE: كل واحدة بتتحقق من نفس الشروط اللي كانت في addoninfo_، وبعدين تعرض
  //       زرار الدفع الأصلي (pay_*/buy_change_store_name_*) على طول من غير
  //       عرض سعر منفصل قبلها — نفس منطق الدفع الأصلي متكررش خالص.
  if (interaction.isButton() && (interaction.customId.startsWith("quickbuy_addon_") || interaction.customId === "quickbuy_change_store_name")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const userId = interaction.user.id;

    const userStore = await db.select().from(purchasesTable)
      .where(and(eq(purchasesTable.discordUserId, userId), eq(purchasesTable.status, "completed")))
      .then((rows) => rows.find((p) => p.discordRoomId));

    if (!userStore) {
      await interaction.editReply({ content: `هو انت عندك متجر اساسا ؟ <a:ZA_TOM:1500527266055323848>` });
      return;
    }

    const confirmEmbed = (title: string) =>
      new EmbedBuilder().setTitle(title).setColor(0x2ecc71).setFooter({ text: "Dev By : mostafa9321 & ahmed_.p" });

    if (interaction.customId === "quickbuy_change_store_name") {
      const btn = new ButtonBuilder().setCustomId(`buy_change_store_name_${userStore.id}`).setLabel("✏️ تأكيد الشراء").setStyle(ButtonStyle.Primary);
      await interaction.editReply({ embeds: [confirmEmbed("✏️ تغيير اسم المتجر")], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(btn)] });
      return;
    }

    const addonKey = interaction.customId.replace("quickbuy_addon_", "");

    if (addonKey === "activate_store") {
      if (!userStore.isRoomDeactivated) {
        await interaction.editReply({ content: "✅ متجرك شغّال ومفيش داعي للتفعيل." });
        return;
      }
      const btn = new ButtonBuilder().setCustomId(`pay_reactivate_room_${userStore.id}`).setLabel("🔒 تأكيد الشراء").setStyle(ButtonStyle.Danger);
      await interaction.editReply({ embeds: [confirmEmbed("🔒 إعادة تفعيل المتجر")], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(btn)] });
      return;
    }

    if (addonKey === "remove_store_warning") {
      if (!userStore.roomWarningCount || userStore.roomWarningCount === 0) {
        await interaction.editReply({ content: `انت نظيف حبي <a:bingusgamingpat:1499748957142646794>` });
        return;
      }
      const btn = new ButtonBuilder().setCustomId(`pay_remove_warning_${userStore.id}`).setLabel("⚠️ تأكيد الشراء").setStyle(ButtonStyle.Danger);
      await interaction.editReply({ embeds: [confirmEmbed("⚠️ إزالة تحذير من المتجر")], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(btn)] });
      return;
    }

    if (addonKey === "add_partner") {
      if (userStore.partnerDiscordUserId) {
        await interaction.editReply({ content: `❌ متجرك عنده شريك بالفعل! (<@${userStore.partnerDiscordUserId}>)\nلازم تشيله الأول بزرار "إزالة شريك".` });
        return;
      }
      const btn = new ButtonBuilder().setCustomId(`pay_add_partner_${userStore.id}`).setLabel("🤝 تأكيد الشراء").setStyle(ButtonStyle.Primary);
      await interaction.editReply({ embeds: [confirmEmbed("🤝 إضافة شريك للمتجر")], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(btn)] });
      return;
    }

    if (addonKey === "remove_partner") {
      if (!userStore.partnerDiscordUserId) {
        await interaction.editReply({ content: "❌ متجرك مفيش فيه شريك." });
        return;
      }
      const btn = new ButtonBuilder().setCustomId(`pay_remove_partner_${userStore.id}`).setLabel("🗑️ تأكيد الشراء").setStyle(ButtonStyle.Danger);
      await interaction.editReply({ embeds: [confirmEmbed("🗑️ إزالة شريك من المتجر")], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(btn)] });
      return;
    }

    if (addonKey === "auto_lines") {
      const btn = new ButtonBuilder().setCustomId(`pay_auto_lines_${userStore.id}`).setLabel("✍️ تأكيد الشراء").setStyle(ButtonStyle.Primary);
      await interaction.editReply({ embeds: [confirmEmbed("✍️ تلقائي للخطوط")], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(btn)] });
      return;
    }

    if (addonKey === "auto_publish") {
      if (activeAutoPublishes.has(userId)) {
        await interaction.editReply({ content: "⏳ عندك نشر تلقائي شغّال بالفعل. خلّيه يخلص الأول." });
        return;
      }
      if (pendingAutoPublishes.has(userId)) {
        await interaction.editReply({ content: "⏳ عندك طلب نشر تلقائي لسه معلّق. خلّيه يخلص الأول." });
        return;
      }
      await createAutoPublishTicket(interaction, interaction.guild!, userId, interaction.user.username);
      return;
    }

    // ── الإضافات اللي مالهاش أوتوميشن (تغيير نوع/مالك المتجر، طلبات المنشن) ──
    // NOTE: دول مفيش لهم دفع تلقائي — التنفيذ بيتم يدوياً من الإدارة، فبنفتح
    //       تذكرة طلب بدل ما نودّي على زرار دفع مش موجود.
    const REQUEST_TICKET_ADDONS: Record<string, string> = {
      change_store_type:         "🔄 طلب تغيير نوع المتجر",
      change_store_owner:        "👤 طلب تغيير مالك المتجر",
      mention_requests:          "🔔 طلب منشن عروض",
      mention_here_requests:     "📣 طلب منشن هير",
      mention_everyone_requests: "📢 طلب منشن إيفري",
    };

    if (addonKey in REQUEST_TICKET_ADDONS) {
      const title = REQUEST_TICKET_ADDONS[addonKey]!;
      const guild = interaction.guild!;

      const [priceRow] = await db.select().from(addonPricesTable).where(eq(addonPricesTable.key, addonKey));
      const rawPrice    = priceRow ? Number(priceRow.price) : 0;
      const priceText   = Number.isFinite(rawPrice) && rawPrice > 0 ? `${Math.round(rawPrice).toLocaleString()} كريدت` : "غير محدد";

      const ticketChannel = await guild.channels.create({
        name:   `request-${interaction.user.username}`,
        type:   ChannelType.GuildText,
        parent: TICKETS_CATEGORY_ID,
        permissionOverwrites: [
          { id: guild.id,             deny:  [PermissionFlagsBits.ViewChannel] },
          { id: userId,               allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
          { id: guild.roles.everyone, deny:  [PermissionFlagsBits.ViewChannel] },
        ],
      });

      const DIV_RQ = "ـﮩ════════════════ﮩـ";
      const gIRQ   = guild.iconURL({ extension: "png", size: 256 }) ?? undefined;
      const rqEmbed = new EmbedBuilder()
        .setAuthor({ name: "Dragon $hop", iconURL: gIRQ })
        .setTitle(title)
        .setDescription(
          `<@${userId}>\n> ${DIV_RQ}\n\n` +
          `> ${MONEY_EMOJI} **السعر:** ${priceText}\n` +
          `> ⏳ الإدارة هتراجع طلبك وترد عليك هنا\n> ${DIV_RQ}`
        )
        .setColor(0x9b59b6)
        .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: gIRQ });

      await ticketChannel.send({ content: `<@${userId}> <@${OWNER_ID}>`, embeds: [rqEmbed] });
      await interaction.editReply({ content: `✅ افتحت لك تذكرة طلب في <#${ticketChannel.id}> — استنى رد الإدارة!` });
      return;
    }

    await interaction.editReply({ content: "❌ الإضافة مش متاحة للشراء المباشر." });
    return;
  }

  // ── زرار سعر إضافة (addoninfo_*) ────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("addoninfo_")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const rawKey = interaction.customId.replace("addoninfo_", "");

    // ── حالة خاصة: تغيير اسم المتجر (سعر ثابت، مش من ADDONS/addon_prices) ────
    if (rawKey === "change_store_name") {
      const userId = interaction.user.id;

      // تحقق من وجود متجر للمستخدم (completed purchase + discordRoomId)
      const userPurchases = await db.select().from(purchasesTable).where(
        and(eq(purchasesTable.discordUserId, userId), eq(purchasesTable.status, "completed"))
      );
      const userStore = userPurchases.find((p) => p.discordRoomId);

      if (!userStore) {
        await interaction.editReply({
          content: `هو انت عندك متجر اساسا ؟ <a:ZA_TOM:1500527266055323848>`,
        });
        return;
      }

      const DIV_S    = "ـﮩ════════════════ﮩـ";
      const gIU      = interaction.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;
      const renamePrice = calcTransferAmount(STORE_RENAME_PRICE);

      const priceEmbed = new EmbedBuilder()
        .setAuthor({ name: "Dragon $hop", iconURL: gIU })
        .setTitle(`${STAR_EMOJI} تغيير اسم المتجر`)
        .setDescription(`<@${userId}> ${MONEY_EMOJI}\n> ${DIV_S}`)
        .setColor(0x00bfff)
        .addFields(
          {
            name:  `${STAR_EMOJI} متجرك الحالي`,
            value: `> ${MONEY_EMOJI} **${userStore.customRoomName ?? userStore.roomName}**\n> ${DIV_S}`,
            inline: false,
          },
          {
            name:  `${STAR_EMOJI} السعر (شامل عمولة 5%)`,
            value: `> ${MONEY_EMOJI} **${renamePrice.toLocaleString()}** كريدت\n> ${DIV_S}`,
            inline: false,
          },
        )
        .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: gIU });

      const sFiles: AttachmentBuilder[] = [];
      if (fs.existsSync(DRAGON_TEXT_BANNER_PATH)) {
        sFiles.push(new AttachmentBuilder(DRAGON_TEXT_BANNER_PATH, { name: "dragon_text_banner.webp" }));
        priceEmbed.setImage("attachment://dragon_text_banner.webp");
      }

      // NOTE: زرار الشراء اتشال — الشراء بقى بس من قائمة "🛒 شراء" المنفصلة (openbuymenu).
      await interaction.editReply({
        embeds: [priceEmbed],
        files:  sFiles,
      });
      return;
    }

    const key   = rawKey as AddonKey;
    const addon = ADDONS.find((a) => a.key === key);

    if (!addon) {
      await interaction.editReply({ content: "❌ الإضافة مش موجودة." });
      return;
    }

    // ── حالة خاصة: أزرار أسعار المنشنات — كل زرار يعرض سعره فقط + زر شراء ──
    const MENTION_BUY_KEYS: Record<string, { price: number; label: string; buyId: string }> = {
      mention_here:     { price: 5_000_000,  label: "@here",                    buyId: "buy_mention_here"     },
      mention_everyone: { price: 15_000_000, label: "@everyone",                buyId: "buy_mention_everyone" },
      mention_shop:     { price: 8_000_000,  label: `<@&${OFFERS_ROLE_ID}>`,    buyId: "buy_mention_shop"     },
      mention_orders:   { price: 5_000_000,  label: `<@&${ORDERS_ROLE_ID}>`,    buyId: "buy_mention_orders"   },
      mention_auction:  { price: 3_000_000,  label: `<@&${AUCTION_ROLE_ID}>`,   buyId: "buy_mention_auction"  },
    };

    if (key in MENTION_BUY_KEYS) {
      const cfg          = MENTION_BUY_KEYS[key]!;
      const guildIconURL = interaction.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;
      const DIV          = "ـﮩ══════════════════ﮩـ";

      const pricesEmbed = new EmbedBuilder()
        .setAuthor({ name: "Dragon $hop", iconURL: guildIconURL })
        .setTitle(`💰 سعر منشن ${cfg.label}`)
        .setColor(0xffd700)
        .addFields({
          name:   `${STAR_EMOJI} ${cfg.label}`,
          value:  `> ${MONEY_EMOJI} السعر : **${cfg.price.toLocaleString()}** كريدت / منشن\n> ${DIV}`,
          inline: false,
        })
        .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: guildIconURL });

      if (guildIconURL) pricesEmbed.setThumbnail(guildIconURL);

      const bannerFiles: AttachmentBuilder[] = [];
      if (fs.existsSync(DRAGON_TEXT_BANNER_PATH)) {
        bannerFiles.push(new AttachmentBuilder(DRAGON_TEXT_BANNER_PATH, { name: "dragon_text_banner.webp" }));
        pricesEmbed.setImage("attachment://dragon_text_banner.webp");
      }

      // NOTE: زرار الشراء اتشال — الشراء بقى بس من قائمة "🛒 شراء" المنفصلة (openbuymenu).
      await interaction.editReply({
        embeds: [pricesEmbed],
        files:  bannerFiles,
      });
      return;
    }

    // ── حالة خاصة: تفعيل المتجر ────────────────────────────────────────────
    if (key === "activate_store") {
      const userId    = interaction.user.id;
      const userStore = await db.select().from(purchasesTable)
        .where(and(eq(purchasesTable.discordUserId, userId), eq(purchasesTable.status, "completed")))
        .then((rows) => rows.find((p) => p.discordRoomId));

      if (!userStore) {
        await interaction.editReply({ content: `هو انت عندك متجر اساسا ؟ <a:ZA_TOM:1500527266055323848>` });
        return;
      }
      if (!userStore.isRoomDeactivated) {
        await interaction.editReply({ content: "✅ متجرك شغّال ومفيش داعي للتفعيل." });
        return;
      }

      const [room] = await db.select().from(roomsTable).where(eq(roomsTable.id, userStore.roomId));
      const reactNet   = room ? Math.ceil(Number(room.price) * 0.5) : 1_000_000;
      const reactGross = calcTransferAmount(reactNet);

      const DIV_ACT  = "ـﮩ════════════════ﮩـ";
      const gIAct    = interaction.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;
      const actEmbed = new EmbedBuilder()
        .setAuthor({ name: "Dragon $hop", iconURL: gIAct })
        .setTitle("🔒 إعادة تفعيل المتجر")
        .setDescription(`<@${userId}>\n> ${DIV_ACT}`)
        .setColor(0xff9900)
        .addFields(
          { name: `${STAR_EMOJI} المتجر`,                             value: `> **${userStore.customRoomName ?? userStore.roomName}**\n> ${DIV_ACT}`, inline: false },
          { name: `${STAR_EMOJI} رسوم التفعيل (50% من قيمة المتجر)`, value: `> ${MONEY_EMOJI} **${reactGross.toLocaleString()}** كريدت\n> ${DIV_ACT}`, inline: false },
        )
        .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: gIAct });

      const actFiles: AttachmentBuilder[] = [];
      if (fs.existsSync(DRAGON_TEXT_BANNER_PATH)) {
        actFiles.push(new AttachmentBuilder(DRAGON_TEXT_BANNER_PATH, { name: "dragon_text_banner.webp" }));
        actEmbed.setImage("attachment://dragon_text_banner.webp");
      }

      // NOTE: زرار الدفع اتشال — الشراء بقى بس من قائمة "🛒 شراء" المنفصلة (openbuymenu).
      await interaction.editReply({
        embeds: [actEmbed],
        files:  actFiles,
      });
      return;
    }

    // ── حالة خاصة: إزالة تحذير من المتجر ──────────────────────────────────
    if (key === "remove_store_warning") {
      const userId    = interaction.user.id;
      const userStore = await db.select().from(purchasesTable)
        .where(and(eq(purchasesTable.discordUserId, userId), eq(purchasesTable.status, "completed")))
        .then((rows) => rows.find((p) => p.discordRoomId));

      if (!userStore) {
        await interaction.editReply({ content: `هو انت عندك متجر اساسا ؟ <a:ZA_TOM:1500527266055323848>` });
        return;
      }

      // مفيش تحذيرات — المستخدم نظيف
      if (!userStore.roomWarningCount || userStore.roomWarningCount === 0) {
        await interaction.editReply({
          content: `انت نظيف حبي <a:bingusgamingpat:1499748957142646794>`,
        });
        return;
      }

      const transferAmt  = calcTransferAmount(WARNING_REMOVAL_PRICE);
      const DIV_RW       = "ـﮩ════════════════ﮩـ";
      const gIRW         = interaction.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;
      const rwEmbed = new EmbedBuilder()
        .setAuthor({ name: "Dragon $hop", iconURL: gIRW })
        .setTitle(`⚠️ إزالة تحذير من المتجر`)
        .setDescription(`<@${userId}> ${MONEY_EMOJI}\n> ${DIV_RW}`)
        .setColor(0xff9900)
        .addFields(
          {
            name:  `${STAR_EMOJI} عدد تحذيراتك`,
            value: `> ⚠️ **${userStore.roomWarningCount} / 3** تحذير\n> ${DIV_RW}`,
            inline: false,
          },
          {
            name:  `${STAR_EMOJI} سعر إزالة تحذير واحد (شامل عمولة 5%)`,
            value: `> ${MONEY_EMOJI} **${transferAmt.toLocaleString()}** كريدت\n> ${DIV_RW}`,
            inline: false,
          },
        )
        .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: gIRW });

      const rwFiles: AttachmentBuilder[] = [];
      if (fs.existsSync(DRAGON_TEXT_BANNER_PATH)) {
        rwFiles.push(new AttachmentBuilder(DRAGON_TEXT_BANNER_PATH, { name: "dragon_text_banner.webp" }));
        rwEmbed.setImage("attachment://dragon_text_banner.webp");
      }

      // NOTE: زرار الدفع اتشال — الشراء بقى بس من قائمة "🛒 شراء" المنفصلة (openbuymenu).
      await interaction.editReply({
        embeds: [rwEmbed],
        files:  rwFiles,
      });
      return;
    }

    // ── حالة خاصة: النشر التلقائي ─────────────────────────────────────────────
    if (key === "auto_publish") {
      // NOTE: ده بقى عرض سعر بس — فتح التذكرة الفعلي بقى من قائمة "🛒 شراء" المنفصلة (quickbuy_addon_auto_publish).
      const DIV_AP  = "ـﮩ════════════════ﮩـ";
      const gIAP    = interaction.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;

      const apEmbed = new EmbedBuilder()
        .setAuthor({ name: "Dragon $hop", iconURL: gIAP })
        .setTitle(`📢 النشر التلقائي في متجرك`)
        .setColor(0x9b59b6)
        .addFields(
          {
            name:  `${STAR_EMOJI} السعر`,
            value: `> ${MONEY_EMOJI} **${AUTO_PUBLISH_PRICE_PER_DAY.toLocaleString()}** كريدت / يوم\n> ${DIV_AP}`,
            inline: false,
          },
          {
            name:  `${STAR_EMOJI} التردد`,
            value: `> 🔄 نشر كل **6 ساعات** طول المدة\n> ${DIV_AP}`,
            inline: false,
          },
        )
        .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: gIAP });

      const apFiles: AttachmentBuilder[] = [];
      if (fs.existsSync(DRAGON_TEXT_BANNER_PATH)) {
        apFiles.push(new AttachmentBuilder(DRAGON_TEXT_BANNER_PATH, { name: "dragon_text_banner.webp" }));
        apEmbed.setImage("attachment://dragon_text_banner.webp");
      }

      await interaction.editReply({ embeds: [apEmbed], files: apFiles });
      return;
    }

    // ── حالة خاصة: تلقائي للخطوط ─────────────────────────────────────────────
    if (key === "auto_lines") {
      const userId    = interaction.user.id;
      const userStore = await db.select().from(purchasesTable)
        .where(and(eq(purchasesTable.discordUserId, userId), eq(purchasesTable.status, "completed")))
        .then((rows) => rows.find((p) => p.discordRoomId));

      // معندوش متجر → رسالة مباشرة
      if (!userStore) {
        await interaction.editReply({ content: `هو انت عندك متجر اساسا ؟ <a:ZA_TOM:1500527266055323848>` });
        return;
      }

      const DIV_AL = "ـﮩ════════════════ﮩـ";
      const gIAL   = interaction.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;

      const alEmbed = new EmbedBuilder()
        .setAuthor({ name: "Dragon $hop", iconURL: gIAL })
        .setTitle("✍️ تلقائي للخطوط")
        .setDescription(`<@${userId}> ${MONEY_EMOJI}\n> ${DIV_AL}`)
        .setColor(0xf39c12)
        .addFields(
          {
            name:  `${STAR_EMOJI} الخدمة`,
            value: `> 🖼️ البوت يبعت صورة خطك تلقائياً بعد كل رسالة تنزلها انت أو شريكك في الروم\n> ${DIV_AL}`,
            inline: false,
          },
          {
            name:  `${STAR_EMOJI} السعر`,
            value: `> ${MONEY_EMOJI} **${AUTO_LINES_PRICE.toLocaleString()}** كريدت\n> ${DIV_AL}`,
            inline: false,
          },
        )
        .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: gIAL });

      const alFiles: AttachmentBuilder[] = [];
      if (fs.existsSync(DRAGON_TEXT_BANNER_PATH)) {
        alFiles.push(new AttachmentBuilder(DRAGON_TEXT_BANNER_PATH, { name: "dragon_text_banner.webp" }));
        alEmbed.setImage("attachment://dragon_text_banner.webp");
      }

      // NOTE: زرار الدفع اتشال — الشراء بقى بس من قائمة "🛒 شراء" المنفصلة (openbuymenu).
      await interaction.editReply({
        embeds: [alEmbed],
        files:  alFiles,
      });
      return;
    }

    // ── حالة خاصة: إضافة شريك ──────────────────────────────────────────────
    if (key === "add_partner") {
      const userId    = interaction.user.id;
      const userStore = await db.select().from(purchasesTable)
        .where(and(eq(purchasesTable.discordUserId, userId), eq(purchasesTable.status, "completed")))
        .then((rows) => rows.find((p) => p.discordRoomId));

      if (!userStore) {
        await interaction.editReply({ content: `هو انت عندك متجر اساسا ؟ <a:ZA_TOM:1500527266055323848>` });
        return;
      }
      if (userStore.partnerDiscordUserId) {
        await interaction.editReply({ content: `❌ متجرك عنده شريك بالفعل! (<@${userStore.partnerDiscordUserId}>)\nلازم تشيله الأول بزرار "سعر إزالة شريك".` });
        return;
      }

      const apGross = calcTransferAmount(ADD_PARTNER_PRICE);
      const DIV_AP  = "ـﮩ════════════════ﮩـ";
      const gIAP    = interaction.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;

      const apEmbed = new EmbedBuilder()
        .setAuthor({ name: "Dragon $hop", iconURL: gIAP })
        .setTitle(`${STAR_EMOJI} إضافة شريك للمتجر`)
        .setDescription(`<@${userId}>\n> ${DIV_AP}`)
        .setColor(0x00bfff)
        .addFields(
          { name: `${STAR_EMOJI} متجرك`,    value: `> **${userStore.customRoomName ?? userStore.roomName}**\n> ${DIV_AP}`, inline: false },
          { name: `${STAR_EMOJI} السعر`,    value: `> ${MONEY_EMOJI} **${apGross.toLocaleString()}** كريدت\n> ${DIV_AP}`, inline: false },
          { name: `${STAR_EMOJI} ملاحظات`, value: `> تقدر تضيف شريك واحد بس\n> الكولداون هيطبق على الاتنين مع بعض\n> ${DIV_AP}`, inline: false },
        )
        .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: gIAP });

      const apFiles: AttachmentBuilder[] = [];
      if (fs.existsSync(DRAGON_TEXT_BANNER_PATH)) {
        apFiles.push(new AttachmentBuilder(DRAGON_TEXT_BANNER_PATH, { name: "dragon_text_banner.webp" }));
        apEmbed.setImage("attachment://dragon_text_banner.webp");
      }

      // NOTE: زرار الدفع اتشال — الشراء بقى بس من قائمة "🛒 شراء" المنفصلة (openbuymenu).
      await interaction.editReply({
        embeds: [apEmbed],
        files:  apFiles,
      });
      return;
    }

    // ── حالة خاصة: إزالة شريك ──────────────────────────────────────────────
    if (key === "remove_partner") {
      const userId    = interaction.user.id;
      const userStore = await db.select().from(purchasesTable)
        .where(and(eq(purchasesTable.discordUserId, userId), eq(purchasesTable.status, "completed")))
        .then((rows) => rows.find((p) => p.discordRoomId));

      if (!userStore) {
        await interaction.editReply({ content: `هو انت عندك متجر اساسا ؟ <a:ZA_TOM:1500527266055323848>` });
        return;
      }
      if (!userStore.partnerDiscordUserId) {
        await interaction.editReply({ content: "❌ متجرك مفيش فيه شريك." });
        return;
      }

      const rpGross = calcTransferAmount(REMOVE_PARTNER_PRICE);
      const DIV_RP  = "ـﮩ════════════════ﮩـ";
      const gIRP    = interaction.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;

      const rpEmbed = new EmbedBuilder()
        .setAuthor({ name: "Dragon $hop", iconURL: gIRP })
        .setTitle(`${STAR_EMOJI} إزالة شريك من المتجر`)
        .setDescription(`<@${userId}>\n> ${DIV_RP}`)
        .setColor(0xff4444)
        .addFields(
          { name: `${STAR_EMOJI} الشريك الحالي`, value: `> <@${userStore.partnerDiscordUserId}>\n> ${DIV_RP}`, inline: false },
          { name: `${STAR_EMOJI} السعر`,          value: `> ${MONEY_EMOJI} **${rpGross.toLocaleString()}** كريدت\n> ${DIV_RP}`, inline: false },
        )
        .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: gIRP });

      const rpFiles: AttachmentBuilder[] = [];
      if (fs.existsSync(DRAGON_TEXT_BANNER_PATH)) {
        rpFiles.push(new AttachmentBuilder(DRAGON_TEXT_BANNER_PATH, { name: "dragon_text_banner.webp" }));
        rpEmbed.setImage("attachment://dragon_text_banner.webp");
      }

      // NOTE: زرار الدفع اتشال — الشراء بقى بس من قائمة "🛒 شراء" المنفصلة (openbuymenu).
      await interaction.editReply({
        embeds: [rpEmbed],
        files:  rpFiles,
      });
      return;
    }

    // اجيب السعر من DB
    const [row]     = await db.select().from(addonPricesTable).where(eq(addonPricesTable.key, key));
    const rawPrice   = row ? Number(row.price) : 0;
    const price      = Number.isFinite(rawPrice) ? rawPrice : 0;
    // لو السعر 0 أو مش متحدد → "غير محدد"
    const priceText  = price > 0 ? `${Math.round(price)} كريدت` : "غير محدد";

    const guildIconURL = interaction.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;
    const embed = new EmbedBuilder()
      .setAuthor({ name: "Dragon $hop", iconURL: guildIconURL })
      .setTitle(addon.label)
      .setColor(0x00bfff)
      .addFields({ name: "💰 السعر", value: priceText, inline: false })
      .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p" });

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── أزرار شراء منشن (buy_mention_*) → يفتح مودال الكمية فقط (النوع معروف) ──
  const MENTION_BUY_CONFIG: Record<string, { price: number; label: string; modalId: string }> = {
    buy_mention_here:     { price: 5_000_000,  label: "@here",    modalId: "modal_mention_here"     },
    buy_mention_everyone: { price: 15_000_000, label: "@everyone", modalId: "modal_mention_everyone" },
    buy_mention_shop:     { price: 8_000_000,  label: "@offers",  modalId: "modal_mention_shop"     },
    buy_mention_orders:   { price: 5_000_000,  label: "طلبيات",   modalId: "modal_mention_orders"   },
    buy_mention_auction:  { price: 3_000_000,  label: "مزاد",     modalId: "modal_mention_auction"  },
  };

  if (interaction.isButton() && interaction.customId in MENTION_BUY_CONFIG) {
    const cfg   = MENTION_BUY_CONFIG[interaction.customId]!;
    const modal = new ModalBuilder()
      .setCustomId(cfg.modalId)
      .setTitle(`شراء منشن ${cfg.label}`);

    const qtyInput = new TextInputBuilder()
      .setCustomId("mention_qty")
      .setLabel("عايز تشتري كم منشن")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("1")
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(5);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(qtyInput));
    await interaction.showModal(modal);
    return;
  }

  // ── مودال شراء منشن (modal_mention_*) ───────────────────────────────────
  const MENTION_MODAL_CONFIG: Record<string, { price: number; label: string }> = {
    modal_mention_here:     { price: 5_000_000,  label: "@here"    },
    modal_mention_everyone: { price: 15_000_000, label: "@everyone" },
    modal_mention_shop:     { price: 8_000_000,  label: "@offers"  },
    modal_mention_orders:   { price: 5_000_000,  label: "طلبيات"   },
    modal_mention_auction:  { price: 3_000_000,  label: "مزاد"     },
  };

  if (interaction.isModalSubmit() && interaction.customId in MENTION_MODAL_CONFIG) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const cfg    = MENTION_MODAL_CONFIG[interaction.customId]!;

    // ── تحقق من عملية شراء معلقة ─────────────────────────────────────────
    // NOTE: كل يوزر ممكن يكون عنده عملية واحدة بس في نفس الوقت.
    //       لو في عملية معلقة والوقت لسه ما خلصش → بلوك.
    const existingPending = pendingMentionPurchases.get(interaction.user.id);
    if (existingPending) {
      const remainingSec = Math.max(0, Math.ceil((existingPending.expiresAt - Date.now()) / 1000));
      const remainingMin = Math.floor(remainingSec / 60);
      const remainingSec2 = remainingSec % 60;
      const timeStr = remainingMin > 0
        ? `${remainingMin}:${String(remainingSec2).padStart(2, "0")} دقيقة`
        : `${remainingSec} ثانية`;
      await interaction.editReply({
        content:
          `❌ **عندك عملية شراء منشن لسه شغّالة!**\n\n` +
          `**النوع:** ${existingPending.label}\n` +
          `**الكمية:** ${existingPending.qty}\n` +
          `**الوقت المتبقي:** ${timeStr}\n\n` +
          `لو دفعت، البوت هيأكدها تلقائياً.\n` +
          `لو مش عايز تكملها، استنى الوقت ينتهي وهتتكنسل لوحدها. ⏳`,
      });
      return;
    }

    const qtyRaw = interaction.fields.getTextInputValue("mention_qty").trim().replace(/[,،٬\s]/g, "");
    const qty    = parseInt(qtyRaw, 10);

    if (isNaN(qty) || qty <= 0) {
      await interaction.editReply({ content: "❌ أدخل عدد صحيح أكبر من صفر." });
      return;
    }

    const netPrice    = cfg.price * qty;
    const transferAmt = calcTransferAmount(netPrice);
    const cmd         = `C <@${OWNER_ID}> ${transferAmt}`;

    // ── أضف العملية للـ pending map مع timeout دقيقتين ──────────────────
    // NOTE: الـ mentionKey بيتعمل extract من modalId (modal_mention_here → "here")
    const mentionKey  = interaction.customId.replace("modal_mention_", "") as MentionKey;
    const expiresAt   = Date.now() + 2 * 60 * 1000;
    const timeoutId   = setTimeout(
      () => cancelPendingMentionPurchase(interaction.user.id, true),
      2 * 60 * 1000
    );

    pendingMentionPurchases.set(interaction.user.id, {
      userId:      interaction.user.id,
      username:    interaction.user.username,
      mentionKey,
      label:       cfg.label,
      qty,
      netPrice,
      transferAmt,
      guildId:     interaction.guildId ?? "",
      channelId:   interaction.channelId ?? "",
      expiresAt,
      timeoutId,
    });

    logger.info(
      { userId: interaction.user.id, mentionKey, qty, transferAmt },
      "Pending mention purchase created — 2min window"
    );

    const DIV_T        = "ـﮩ════════════════ﮩـ";
    const guildIconURL = interaction.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;
    const transferFiles: AttachmentBuilder[] = [];

    const resultEmbed = new EmbedBuilder()
      .setAuthor({ name: "Dragon $hop", iconURL: guildIconURL })
      .setTitle(`${STAR_EMOJI} أمر تحويل المنشن`)
      .setDescription(
        `> ${MONEY_EMOJI} <@${interaction.user.id}> اتبع الخطوات التالية\n` +
        `> ${DIV_T}`
      )
      .setColor(0xffd700)
      .addFields(
        {
          name:  `${STAR_EMOJI} النوع والكمية`,
          value: `> ${MONEY_EMOJI} **${cfg.label}** — **${qty}** منشن\n> ${DIV_T}`,
          inline: false,
        },
        {
          name:  `${STAR_EMOJI} السعر الصافي`,
          value: `> ${MONEY_EMOJI} **${netPrice.toLocaleString()}** كريدت\n> ${DIV_T}`,
          inline: false,
        },
        {
          name:  `${STAR_EMOJI} مبلغ التحويل (شامل عمولة 5%)`,
          value: `> ${MONEY_EMOJI} **${transferAmt.toLocaleString()}** كريدت\n> ${DIV_T}`,
          inline: false,
        },
        {
          name:  `${STAR_EMOJI} أمر التحويل — انسخه وابعثه في ProBot`,
          value: `> \`\`\`${cmd}\`\`\`\n> ${DIV_T}`,
          inline: false,
        },
        {
          name:  `${STAR_EMOJI} المهلة`,
          value: `> ${MONEY_EMOJI} عندك **دقيقتين** تحول فيهم\n> بعدهم العملية بتتكنسل تلقائياً ⏰\n> ${DIV_T}`,
          inline: false,
        },
      )
      .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: guildIconURL });

    if (fs.existsSync(DRAGON_TEXT_BANNER_PATH)) {
      transferFiles.push(new AttachmentBuilder(DRAGON_TEXT_BANNER_PATH, { name: "dragon_text_banner.webp" }));
      resultEmbed.setImage("attachment://dragon_text_banner.webp");
    }

    await interaction.editReply({ embeds: [resultEmbed], files: transferFiles });
    await interaction.followUp({ content: `\`${cmd}\``, flags: MessageFlags.Ephemeral });
    return;
  }

  // ── زرار شراء منشن إعلان مزاد (buy_auc_mention_*) ──────────────────────
  // customId: buy_auc_mention_{everyone|here|offers}
  // NOTE: بيفتح تذكرة خاصة زي باقي المشتريات — الدفع بيتم جوّه التذكرة
  //       مش من خلال رسالة عامة في روم الأوامر.
  if (interaction.isButton() && interaction.customId.startsWith("buy_auc_mention_")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const mType    = interaction.customId.replace("buy_auc_mention_", "") as AuctionType;
    const typeCfg  = AUCTION_TYPES[mType];
    if (!typeCfg) { await interaction.editReply({ content: "❌ نوع منشن غير معروف." }); return; }

    const userId   = interaction.user.id;
    const username = interaction.user.username;
    const guild    = interaction.guild!;

    if (await isUserBanned(userId)) {
      await interaction.editReply({ content: "❌ أنت محظور ولا تستطيع الشراء." });
      return;
    }

    // تحقق من عملية معلقة موجودة
    const existingAM = pendingAucMentionPurchases.get(userId);
    if (existingAM) {
      const remainSec = Math.max(0, Math.ceil((existingAM.expiresAt - Date.now()) / 1000));
      await interaction.editReply({
        content: `❌ **عندك طلب منشن مزاد معلّق!** الوقت المتبقي: **${Math.floor(remainSec / 60)}:${String(remainSec % 60).padStart(2, "0")}** دقيقة\n\nتفتكرها في التذكرة <#${existingAM.ticketChannelId}>.`,
      });
      return;
    }

    const netPrice    = typeCfg.price;
    const transferAmt = calcTransferAmount(netPrice);
    const cmd         = `C <@${OWNER_ID}> ${transferAmt}`;

    // أنشئ تذكرة خاصة بالمنشن
    const ticketChannel = await guild.channels.create({
      name:   `auc-ad-${username}-${mType}`,
      type:   ChannelType.GuildText,
      parent: TICKETS_CATEGORY_ID,
      permissionOverwrites: [
        { id: guild.id,             deny:  [PermissionFlagsBits.ViewChannel] },
        { id: userId,               allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
        { id: guild.roles.everyone, deny:  [PermissionFlagsBits.ViewChannel] },
      ],
    });

    // سجّل في DB على طول عشان ProBot detection يلاقيه بـ channel.id
    const [amRecord] = await db
      .insert(auctionSchedulesTable)
      .values({
        discordUserId:   userId,
        discordUsername: username,
        auctionType:     mType,
        status:          "pending_mention_payment",
        ticketChannelId: ticketChannel.id,
        totalPrice:      String(transferAmt),
      })
      .returning();

    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 دقايق
    const timeoutId = setTimeout(async () => {
      pendingAucMentionPurchases.delete(userId);
      await db.update(auctionSchedulesTable)
        .set({ status: "cancelled" })
        .where(eq(auctionSchedulesTable.id, amRecord.id))
        .catch(() => {});
      ticketChannel.delete("Auc mention ticket timed out").catch(() => {});
      logger.info({ userId, mType }, "Auction mention purchase timed out");
    }, 5 * 60 * 1000);

    pendingAucMentionPurchases.set(userId, {
      userId, username, mentionType: mType,
      netPrice, transferAmt,
      guildId:         guild.id,
      ticketChannelId: ticketChannel.id,
      dbRecordId:      amRecord.id,
      expiresAt, timeoutId,
    });

    logger.info({ userId, mType, transferAmt }, "Pending auc mention purchase created — ticket opened");

    // ابعت أمر التحويل جوّه التذكرة على طول (خاصة، مفيش داعي لزر إظهار)
    const DIV_AM2    = "ـﮩ════════════════ﮩـ";
    const gIAM2      = guild.iconURL({ extension: "png", size: 256 }) ?? undefined;
    const amCmdEmbed = new EmbedBuilder()
      .setAuthor({ name: "Dragon $hop", iconURL: gIAM2 })
      .setTitle(`${typeCfg.emoji} طلب منشن إعلان مزاد — ${typeCfg.label}`)
      .setDescription(`<@${userId}> ${MONEY_EMOJI}\n> ${DIV_AM2}`)
      .setColor(0xffd700)
      .addFields(
        {
          name:  `${STAR_EMOJI} المنشن`,
          value: `> ${MONEY_EMOJI} **${typeCfg.label}**\n> ${DIV_AM2}`,
          inline: false,
        },
        {
          name:  `${STAR_EMOJI} أمر التحويل — انسخه وابعثه في ProBot`,
          value: `> \`\`\`${cmd}\`\`\`\n> ${DIV_AM2}`,
          inline: false,
        },
        {
          name:  `${STAR_EMOJI} مبلغ التحويل (شامل عمولة 5%)`,
          value: `> ${MONEY_EMOJI} **${transferAmt.toLocaleString()}** كريدت\n> ${DIV_AM2}`,
          inline: false,
        },
        {
          name:  `${STAR_EMOJI} المهلة`,
          value: `> ⏰ عندك **5 دقايق** تحول فيهم\n> ${DIV_AM2}`,
          inline: false,
        },
      )
      .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: gIAM2 });

    const amCmdFiles: AttachmentBuilder[] = [];
    if (fs.existsSync(DRAGON_TEXT_BANNER_PATH)) {
      amCmdFiles.push(new AttachmentBuilder(DRAGON_TEXT_BANNER_PATH, { name: "dragon_text_banner.webp" }));
      amCmdEmbed.setImage("attachment://dragon_text_banner.webp");
    }

    const closeAmBtn = new ButtonBuilder()
      .setCustomId(`close_aucmention_ticket_${userId}`)
      .setLabel("🔒 إلغاء الطلب")
      .setStyle(ButtonStyle.Danger);

    await ticketChannel.send({
      content:    `<@${userId}>`,
      embeds:     [amCmdEmbed],
      files:      amCmdFiles,
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(closeAmBtn)],
    });

    await interaction.editReply({ content: `✅ تم إنشاء تذكرة الطلب! <#${ticketChannel.id}>` });
    return;
  }

  // ── زرار إلغاء طلب منشن إعلان مزاد قبل الدفع (close_aucmention_ticket_*) ──
  if (interaction.isButton() && interaction.customId.startsWith("close_aucmention_ticket_")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const ownerIdAm = interaction.customId.replace("close_aucmention_ticket_", "");

    if (interaction.user.id !== ownerIdAm) {
      await interaction.editReply({ content: "❌ الزرار ده مش بتاعك." });
      return;
    }

    const pendingAm = pendingAucMentionPurchases.get(ownerIdAm);
    if (pendingAm) {
      clearTimeout(pendingAm.timeoutId);
      pendingAucMentionPurchases.delete(ownerIdAm);
      await db.update(auctionSchedulesTable)
        .set({ status: "cancelled" })
        .where(eq(auctionSchedulesTable.id, pendingAm.dbRecordId))
        .catch(() => {});
    }

    await interaction.editReply({ content: "🔒 تم إلغاء الطلب — التذكرة هتقفل دلوقتي." });
    setTimeout(() => (interaction.channel as TextChannel)?.delete("Auc mention ticket cancelled").catch(() => {}), 3000);
    return;
  }

  // ── زرار عرض أمر التحويل للمنشن (auc_mention_cmd_*) ────────────────────
  // customId: auc_mention_cmd_{userId}_{mType}
  if (interaction.isButton() && interaction.customId.startsWith("auc_mention_cmd_")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const parts  = interaction.customId.replace("auc_mention_cmd_", "").split("_");
    // parts: [userId, mType] — but mType can be "everyone", "here", "offers"
    // since userId is all digits, split at first underscore after digits
    const match2 = interaction.customId.match(/^auc_mention_cmd_(\d+)_(\w+)$/);
    if (!match2) { await interaction.editReply({ content: "❌ بيانات غلط." }); return; }
    const [, ownerId, mType2] = match2 as [string, string, AuctionType];

    // فقط صاحب الطلب يقدر يضغط
    if (interaction.user.id !== ownerId) {
      await interaction.editReply({ content: "❌ الزرار ده مش بتاعك." });
      return;
    }

    const pending2 = pendingAucMentionPurchases.get(ownerId);
    if (!pending2) {
      await interaction.editReply({ content: "❌ الطلب انتهى أو اتأكد بالفعل." });
      return;
    }

    const typeCfg2 = AUCTION_TYPES[mType2 as AuctionType];
    if (!typeCfg2) { await interaction.editReply({ content: "❌ نوع غير معروف." }); return; }
    const cmd2 = `C <@${OWNER_ID}> ${pending2.transferAmt}`;

    const DIV_CMD = "ـﮩ════════════════ﮩـ";
    const gICMD   = interaction.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;
    const cmdEmbed2 = new EmbedBuilder()
      .setAuthor({ name: "Dragon $hop", iconURL: gICMD })
      .setTitle(`📋 أمر التحويل — ${typeCfg2.label}`)
      .setDescription(`<@${ownerId}> ${MONEY_EMOJI}\n> ${DIV_CMD}`)
      .setColor(0xffd700)
      .addFields(
        {
          name:  `${STAR_EMOJI} أمر التحويل — انسخه وابعثه في ProBot`,
          value: `> \`\`\`${cmd2}\`\`\`\n> ${DIV_CMD}`,
          inline: false,
        },
        {
          name:  `${STAR_EMOJI} المبلغ`,
          value: `> ${MONEY_EMOJI} **${pending2.transferAmt.toLocaleString()}** كريدت\n> ${DIV_CMD}`,
          inline: false,
        },
      )
      .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: gICMD });

    await interaction.editReply({ embeds: [cmdEmbed2] });
    await interaction.followUp({ content: `\`${cmd2}\``, flags: MessageFlags.Ephemeral });
    return;
  }

  // ── زرار "اختار تفاصيل المزاد" بعد تأكيد ProBot (auc_mention_details_btn_*) ──
  if (interaction.isButton() && interaction.customId.startsWith("auc_mention_details_btn_")) {
    const match3 = interaction.customId.match(/^auc_mention_details_btn_(\d+)_(\w+)$/);
    if (!match3) return;
    const [, ownerId3, mType3] = match3 as [string, string, AuctionType];

    if (interaction.user.id !== ownerId3) {
      await interaction.reply({ content: "❌ الزرار ده مش بتاعك.", flags: MessageFlags.Ephemeral });
      return;
    }

    // ✅ تحقق من وجود توكن الدفع المؤكد (single-use)
    const readyToken = pendingAucMentionReady.get(ownerId3);
    if (!readyToken || readyToken.mentionType !== mType3 || readyToken.guildId !== (interaction.guildId ?? "")) {
      await interaction.reply({ content: "❌ مش لاقي تأكيد دفع لهذا الطلب. لو دفعت من فترة، الجلسة انتهت — ابدأ من الأول.", flags: MessageFlags.Ephemeral });
      return;
    }

    const typeCfg3 = AUCTION_TYPES[mType3];
    if (!typeCfg3) return;

    const modal3 = new ModalBuilder()
      .setCustomId(`auc_mention_modal_${ownerId3}_${mType3}`)
      .setTitle(`تفاصيل إعلان المزاد — ${typeCfg3.label}`);

    const roomInput = new TextInputBuilder()
      .setCustomId("auc_room_num")
      .setLabel("رقم الروم (1 أو 2 أو 3)")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("1")
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(1);

    const hourInput = new TextInputBuilder()
      .setCustomId("auc_hour")
      .setLabel("الساعة (10 لـ 22 توقيت القاهرة)")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("مثال: 14 (= 2م)")
      .setRequired(true)
      .setMinLength(2)
      .setMaxLength(2);

    const priceInput = new TextInputBuilder()
      .setCustomId("auc_selling_price")
      .setLabel("العكلة — سعر البيع في المزاد")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("مثال: 5000 أو 2.5k")
      .setRequired(true)
      .setMaxLength(50);

    modal3.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(roomInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(hourInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(priceInput),
    );

    await interaction.showModal(modal3);
    return;
  }

  // ── مودال تفاصيل المزاد (auc_mention_modal_*) ────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId.startsWith("auc_mention_modal_")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const match4 = interaction.customId.match(/^auc_mention_modal_(\d+)_(\w+)$/);
    if (!match4) { await interaction.editReply({ content: "❌ بيانات غلط." }); return; }
    const [, ownerId4, mType4] = match4 as [string, string, AuctionType];

    if (interaction.user.id !== ownerId4) {
      await interaction.editReply({ content: "❌ مش بتاعك." });
      return;
    }

    // ✅ تحقق من توكن الدفع المؤكد (يمنع تسجيل مزادات بدون دفع)
    const readyToken4 = pendingAucMentionReady.get(ownerId4);
    if (!readyToken4 || readyToken4.mentionType !== mType4 || readyToken4.guildId !== (interaction.guildId ?? "")) {
      await interaction.editReply({ content: "❌ مش لاقي تأكيد دفع لهذا الطلب. الجلسة انتهت — ابدأ من الأول." });
      return;
    }

    const typeCfg4 = AUCTION_TYPES[mType4];
    if (!typeCfg4) { await interaction.editReply({ content: "❌ نوع غير معروف." }); return; }

    // اقرأ القيم من المودال
    const roomNumStr   = interaction.fields.getTextInputValue("auc_room_num").trim();
    const hourStr4     = interaction.fields.getTextInputValue("auc_hour").trim();
    const sellingPrice = interaction.fields.getTextInputValue("auc_selling_price").trim();

    const roomNum = parseInt(roomNumStr, 10);
    if (isNaN(roomNum) || roomNum < 1 || roomNum > 3) {
      await interaction.editReply({ content: "❌ رقم الروم لازم يكون 1 أو 2 أو 3 بس." });
      return;
    }

    const targetHour4 = parseInt(hourStr4, 10);
    if (isNaN(targetHour4) || targetHour4 < 10 || targetHour4 > 22) {
      await interaction.editReply({ content: "❌ الساعة لازم تكون بين 10 و 22 (توقيت القاهرة)." });
      return;
    }

    // تحقق إن الساعة لسه جاية (مش فاتت)
    const { hour: currentHour4 } = getCairoTime();
    if (targetHour4 <= currentHour4) {
      await interaction.editReply({ content: `❌ الساعة **${hourToLabel(targetHour4)}** فاتت بالفعل! اختار ساعة قادمة.` });
      return;
    }

    if (!sellingPrice) {
      await interaction.editReply({ content: "❌ لازم تكتب العكلة." });
      return;
    }

    const roomChannelId4 = AUCTION_ROOM_CHANNEL_IDS[roomNum - 1];
    if (!roomChannelId4) {
      await interaction.editReply({ content: "❌ الروم ده مش موجود." });
      return;
    }

    // تحقق إن الوقت والروم مش محجوزين
    const { date: today4 } = getCairoTime();
    const existingSlot = await db
      .select()
      .from(auctionSchedulesTable)
      .where(
        and(
          eq(auctionSchedulesTable.scheduledDate, today4),
          eq(auctionSchedulesTable.scheduledHour, targetHour4),
          eq(auctionSchedulesTable.roomChannelId, roomChannelId4),
          ne(auctionSchedulesTable.status, "cancelled"),
        ),
      )
      .then((r) => r[0]);

    if (existingSlot) {
      await interaction.editReply({
        content: `❌ الروم **${roomNum}** في الساعة **${hourToLabel(targetHour4)}** محجوز بالفعل! اختار وقت أو روم تاني.`,
      });
      return;
    }

    // ticketChannelId المخزّن في الـ ready token هو تذكرة الطلب نفسها
    const ticketChannelId4 = readyToken4.ticketChannelId;

    // سجّل في DB
    const [aucRecord] = await db
      .insert(auctionSchedulesTable)
      .values({
        discordUserId:   ownerId4,
        discordUsername: interaction.user.username,
        auctionType:     mType4,
        scheduledDate:   today4,
        scheduledHour:   targetHour4,
        status:          "scheduled", // مدفوع بالفعل — جاهز
        roomChannelId:   roomChannelId4,
        ticketChannelId: ticketChannelId4,
        totalPrice:      String(calcTransferAmount(typeCfg4.price)),
        sellingPrice:    sellingPrice,
      })
      .returning();

    // امسح من الـ ready map (وألغي الـ timeout عشان مفيش memory leak)
    const usedToken = pendingAucMentionReady.get(ownerId4);
    if (usedToken) clearTimeout(usedToken.timeoutId);
    pendingAucMentionReady.delete(ownerId4);

    // بعت تأكيد جوّه تذكرة الطلب وبعدين اقفلها
    const DIV_CONF = "ـﮩ════════════════ﮩـ";
    const gICONF   = interaction.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;
    const confEmbed = new EmbedBuilder()
      .setAuthor({ name: "Dragon $hop", iconURL: gICONF })
      .setTitle(`✅ تم تسجيل إعلان المزاد!`)
      .setDescription(`<@${ownerId4}> ${MONEY_EMOJI}\n> ${DIV_CONF}`)
      .setColor(0x00ff88)
      .addFields(
        {
          name:  `${STAR_EMOJI} المنشن`,
          value: `> ${typeCfg4.emoji} **${typeCfg4.label}**\n> ${DIV_CONF}`,
          inline: false,
        },
        {
          name:  `${STAR_EMOJI} الروم`,
          value: `> <#${roomChannelId4}>\n> ${DIV_CONF}`,
          inline: false,
        },
        {
          name:  `${STAR_EMOJI} الموعد`,
          value: `> ⏰ **${hourToLabel(targetHour4)}** — ${today4} (توقيت القاهرة)\n> ${DIV_CONF}`,
          inline: false,
        },
        {
          name:  `${STAR_EMOJI} العكلة`,
          value: `> 💰 **${sellingPrice}**\n> ${DIV_CONF}`,
          inline: false,
        },
      )
      .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: gICONF });

    const confFiles: AttachmentBuilder[] = [];
    if (fs.existsSync(DRAGON_BANNER_PATH)) {
      confFiles.push(new AttachmentBuilder(DRAGON_BANNER_PATH, { name: "dragon_banner.webp" }));
      confEmbed.setImage("attachment://dragon_banner.webp");
    }

    try {
      const ticketCh4 = interaction.guild?.channels.cache.get(ticketChannelId4) as TextChannel | undefined;
      await ticketCh4?.send({ content: `<@${ownerId4}>`, embeds: [confEmbed], files: confFiles }).catch(() => {});
      // اقفل التذكرة بعد التأكيد — الطلب خلص
      setTimeout(() => ticketCh4?.delete("Auc mention ticket closed after confirmation").catch(() => {}), 5000);
    } catch { /* ignore */ }

    await interaction.editReply({
      content:
        `✅ **تم تسجيل إعلانك بنجاح!**\n\n` +
        `${typeCfg4.emoji} **${typeCfg4.label}** في <#${roomChannelId4}>\n` +
        `⏰ الموعد: **${hourToLabel(targetHour4)}** — ${today4}\n` +
        `💰 العكلة: **${sellingPrice}**\n\n` +
        `البوت هيبعت الإعلان تلقائياً في الموعد المحدد! ✅`,
    });

    logger.info({ userId: ownerId4, mType: mType4, roomChannelId: roomChannelId4, targetHour: targetHour4, sellingPrice, scheduleId: aucRecord.id }, "Auc mention scheduled");

    // حدّث رسالة المواعيد
    if (interaction.guild) refreshAuctionScheduleMsg(interaction.guild).catch(() => {});
    return;
  }

  // ── زرار شراء تغيير اسم المتجر (buy_change_store_name_*) ────────────────
  // customId: buy_change_store_name_{purchaseId}
  if (interaction.isButton() && interaction.customId.startsWith("buy_change_store_name_")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const purchaseId = parseInt(interaction.customId.replace("buy_change_store_name_", ""), 10);
    const userId     = interaction.user.id;

    // تحقق من عملية معلقة حالية
    const existingRename = pendingStoreRenames.get(userId);
    if (existingRename) {
      const remainingSec = Math.max(0, Math.ceil((existingRename.expiresAt - Date.now()) / 1000));
      const timeStr = `${Math.floor(remainingSec / 60)}:${String(remainingSec % 60).padStart(2, "0")} دقيقة`;
      await interaction.editReply({
        content:
          `❌ **عندك عملية تغيير اسم لسه شغّالة!**\n\n` +
          `**الوقت المتبقي:** ${timeStr}\n\n` +
          `لو دفعت، البوت هيأكدها تلقائياً.\n` +
          `لو مش عايز تكملها، استنى الوقت ينتهي وهتتكنسل لوحدها. ⏳`,
      });
      return;
    }

    // تحقق من وجود الشراء وأنه للمستخدم نفسه
    const [purchase] = await db.select().from(purchasesTable).where(eq(purchasesTable.id, purchaseId));
    if (!purchase || purchase.discordUserId !== userId || purchase.status !== "completed" || !purchase.discordRoomId) {
      await interaction.editReply({ content: "❌ مش لاقي المتجر ده أو انت مش صاحبه." });
      return;
    }

    const netPrice    = STORE_RENAME_PRICE;
    const transferAmt = calcTransferAmount(netPrice);
    const cmd         = `C <@${OWNER_ID}> ${transferAmt}`;

    // سجّل العملية المعلقة مع timeout دقيقتين
    const expiresAt = Date.now() + 2 * 60 * 1000;
    const timeoutId = setTimeout(
      () => cancelPendingStoreRename(userId, true),
      2 * 60 * 1000
    );
    pendingStoreRenames.set(userId, {
      userId,
      username:      interaction.user.username,
      purchaseId,
      roomChannelId: purchase.discordRoomId,
      currentName:   purchase.customRoomName ?? purchase.roomName,
      transferAmt,
      netPrice,
      guildId:       interaction.guildId ?? "",
      channelId:     interaction.channelId ?? "",
      expiresAt,
      timeoutId,
    });
    logger.info({ userId, purchaseId, transferAmt }, "Pending store rename created — 2min window");

    const DIV_T        = "ـﮩ════════════════ﮩـ";
    const guildIconURL = interaction.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;
    const renameFiles: AttachmentBuilder[] = [];

    const renameEmbed = new EmbedBuilder()
      .setAuthor({ name: "Dragon $hop", iconURL: guildIconURL })
      .setTitle(`${STAR_EMOJI} أمر تحويل تغيير اسم المتجر`)
      .setDescription(`<@${userId}> ${MONEY_EMOJI}\n> ${DIV_T}`)
      .setColor(0xffd700)
      .addFields(
        {
          name:  `${STAR_EMOJI} المتجر الحالي`,
          value: `> ${MONEY_EMOJI} **${purchase.customRoomName ?? purchase.roomName}**\n> ${DIV_T}`,
          inline: false,
        },
        {
          name:  `${STAR_EMOJI} السعر الصافي`,
          value: `> ${MONEY_EMOJI} **${netPrice.toLocaleString()}** كريدت\n> ${DIV_T}`,
          inline: false,
        },
        {
          name:  `${STAR_EMOJI} مبلغ التحويل (شامل عمولة 5%)`,
          value: `> ${MONEY_EMOJI} **${transferAmt.toLocaleString()}** كريدت\n> ${DIV_T}`,
          inline: false,
        },
        {
          name:  `${STAR_EMOJI} أمر التحويل — انسخه وابعثه في ProBot`,
          value: `> \`\`\`${cmd}\`\`\`\n> ${DIV_T}`,
          inline: false,
        },
        {
          name:  `${STAR_EMOJI} المهلة`,
          value: `> ${MONEY_EMOJI} عندك **دقيقتين** تحول فيهم\n> بعدهم العملية بتتكنسل تلقائياً ⏰\n> ${DIV_T}`,
          inline: false,
        },
      )
      .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: guildIconURL });

    if (fs.existsSync(DRAGON_TEXT_BANNER_PATH)) {
      renameFiles.push(new AttachmentBuilder(DRAGON_TEXT_BANNER_PATH, { name: "dragon_text_banner.webp" }));
      renameEmbed.setImage("attachment://dragon_text_banner.webp");
    }

    await interaction.editReply({ embeds: [renameEmbed], files: renameFiles });
    await interaction.followUp({ content: `\`${cmd}\``, flags: MessageFlags.Ephemeral });
    return;
  }

  // ── زرار نوع المزاد (auctype_*) — بينشئ تذكرة دفع على طول ───────────────
  // NOTE: مفيش اختيار موعد هنا خالص. الموعد بيتحدد تلقائياً بعد الدفع
  //       وبعد ما اليوزر يجاوب على سؤالي "المزاد على ايه" و"الدفع ازاي".
  if (interaction.isButton() && interaction.customId.startsWith("auctype_")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const aType = interaction.customId.replace("auctype_", "") as AuctionType;
    if (!AUCTION_TYPES[aType]) {
      await interaction.editReply({ content: "❌ نوع مزاد غير معروف." });
      return;
    }
    const typeCfg = AUCTION_TYPES[aType];

    const userId   = interaction.user.id;
    const username = interaction.user.username;

    if (await isUserBanned(userId)) {
      await interaction.editReply({ content: "❌ أنت محظور ولا تستطيع الشراء." });
      return;
    }

    const transferAmt = calcTransferAmount(typeCfg.price);
    const guild        = interaction.guild!;

    // أنشئ شانل تذكرة المزاد
    const ticketChannel = await guild.channels.create({
      name:   `auction-${username}-${aType}`,
      type:   ChannelType.GuildText,
      parent: TICKETS_CATEGORY_ID,
      permissionOverwrites: [
        { id: guild.id,             deny:  [PermissionFlagsBits.ViewChannel] },
        { id: userId,               allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
        { id: guild.roles.everyone, deny:  [PermissionFlagsBits.ViewChannel] },
      ],
    });

    // سجّل الحجز في DB — بدون موعد لسه (هيتحدد بعد الدفع + الأسئلة)
    const [auctionRecord] = await db
      .insert(auctionSchedulesTable)
      .values({
        discordUserId:   userId,
        discordUsername: username,
        auctionType:     aType,
        status:          "pending_payment",
        ticketChannelId: ticketChannel.id,
        totalPrice:      String(transferAmt),
      })
      .returning();

    const transferCommand = `C <@${OWNER_ID}> ${transferAmt}`;
    const ticketEmbed = new EmbedBuilder()
      .setTitle(`🎰 تذكرة مزاد — ${typeCfg.label}`)
      .setDescription(
        `مرحباً <@${userId}>! 👋\n\n` +
        `**نوع المزاد:** ${typeCfg.emoji} ${typeCfg.label}\n` +
        `**السعر:** ${typeCfg.price.toLocaleString()} كريدت\n` +
        `**مبلغ التحويل (مع عمولة ProBot 5%):** \`${transferAmt}\`\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📋 **أمر التحويل:**\n\`${transferCommand}\`\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `1️⃣ انسخ الأمر وبعثه في سيرفر ProBot\n` +
        `2️⃣ البوت هيتأكد تلقائياً ويسألك عن تفاصيل المزاد\n` +
        `3️⃣ بعد ما تجاوب، هيحدد لك ميعاد تلقائياً ✅`,
      )
      .setColor(0xffd700);

    const closeBtnA = new ButtonBuilder()
      .setCustomId(`close_auction_ticket_${auctionRecord.id}`)
      .setLabel("🔒 إلغاء الحجز")
      .setStyle(ButtonStyle.Danger);

    await ticketChannel.send({
      content:    `<@${userId}>`,
      embeds:     [ticketEmbed],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(closeBtnA)],
    });

    await interaction.editReply({ content: `✅ تم إنشاء تذكرة الحجز! <#${ticketChannel.id}>` });
    return;
  }

  // ── زرار فتح مودال تفاصيل المزاد (auc_item_modal_btn_*) ─────────────────
  // customId: auc_item_modal_btn_{scheduleId}
  // بيفتح مودال فيه خانتين: "المزاد على ايه؟" (إجباري) + "الدفع ازاي؟" (اختياري)
  if (interaction.isButton() && interaction.customId.startsWith("auc_item_modal_btn_")) {
    const scheduleId = parseInt(interaction.customId.replace("auc_item_modal_btn_", ""), 10);
    const [sched] = await db.select().from(auctionSchedulesTable).where(eq(auctionSchedulesTable.id, scheduleId));

    if (!sched || sched.discordUserId !== interaction.user.id || sched.status !== "awaiting_item") {
      await interaction.reply({ content: "❌ الزرار ده مش متاح دلوقتي.", flags: MessageFlags.Ephemeral });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(`auc_item_modal_submit_${scheduleId}`)
      .setTitle("تفاصيل المزاد");

    const itemInput = new TextInputBuilder()
      .setCustomId("auc_item_desc")
      .setLabel("المزاد على ايه؟ (إجباري)")
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder("مثال: ايفون 15 برو ماكس — جديد")
      .setRequired(true)
      .setMaxLength(500);

    const payInput = new TextInputBuilder()
      .setCustomId("auc_pay_method")
      .setLabel("اكتب طرق الدفع المطلوبة")
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder("مثال: فودافون كاش — انستاباي — كاش")
      .setRequired(true)
      .setMaxLength(300);

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(itemInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(payInput),
    );

    await interaction.showModal(modal);
    return;
  }

  // ── مودال تفاصيل المزاد — submit (auc_item_modal_submit_*) ───────────────
  if (interaction.isModalSubmit() && interaction.customId.startsWith("auc_item_modal_submit_")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const scheduleId = parseInt(interaction.customId.replace("auc_item_modal_submit_", ""), 10);
    const [sched] = await db.select().from(auctionSchedulesTable).where(eq(auctionSchedulesTable.id, scheduleId));

    if (!sched || sched.discordUserId !== interaction.user.id || sched.status !== "awaiting_item") {
      await interaction.editReply({ content: "❌ الطلب ده انتهى أو مش بتاعك." });
      return;
    }

    const itemDesc  = interaction.fields.getTextInputValue("auc_item_desc").trim();
    const payMethod = interaction.fields.getTextInputValue("auc_pay_method").trim() || null;

    if (!itemDesc) {
      await interaction.editReply({ content: "❌ لازم تكتب المزاد على ايه." });
      return;
    }

    // احفظ التفاصيل في DB (الستاتوس يفضل awaiting_item لحد ما اليوزر يختار اليوم)
    await db.update(auctionSchedulesTable)
      .set({ itemDescription: itemDesc, paymentMethod: payMethod })
      .where(eq(auctionSchedulesTable.id, sched.id));

    // ابني أزرار اختيار اليوم
    const availableDays = await getAvailableBookingDays();

    if (availableDays.length === 0) {
      await interaction.editReply({ content: "❌ مفيش مواعيد متاحة في الأيام الجاية. الأدمن سيتواصل معاك لتحديد ميعاد يدوياً." });
      return;
    }

    const dayButtons = availableDays.slice(0, 5).map((d) =>
      new ButtonBuilder()
        .setCustomId(`aucday_${scheduleId}|${d.date}`)
        .setLabel(d.label)
        .setStyle(ButtonStyle.Primary),
    );

    const ticketCh = sched.ticketChannelId
      ? (interaction.guild?.channels.cache.get(sched.ticketChannelId) as TextChannel | undefined)
      : (interaction.channel as TextChannel | undefined);

    await ticketCh?.send({
      content: "📅 **اختار يوم المزاد** (البوت هيختار الساعة المناسبة تلقائياً):",
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(...dayButtons)],
    }).catch(() => {});

    await interaction.editReply({ content: "✅ تم تسجيل تفاصيل المزاد! اختار اليوم من التذكرة ⬇️" });
    return;
  }

  // ── زرار اختيار يوم المزاد (aucday_*) ───────────────────────────────────
  // customId: aucday_{scheduleId}|{date}
  if (interaction.isButton() && interaction.customId.startsWith("aucday_")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const raw   = interaction.customId.replace("aucday_", "");
    const pipe  = raw.indexOf("|");
    if (pipe === -1) { await interaction.editReply({ content: "❌ بيانات غلط." }); return; }
    const scheduleId  = parseInt(raw.slice(0, pipe), 10);
    const chosenDate  = raw.slice(pipe + 1);

    const [sched] = await db.select().from(auctionSchedulesTable).where(eq(auctionSchedulesTable.id, scheduleId));
    if (!sched || sched.discordUserId !== interaction.user.id || sched.status !== "awaiting_item") {
      await interaction.editReply({ content: "❌ الطلب ده انتهى أو مش بتاعك." });
      return;
    }

    const slot = await findSlotOnDay(chosenDate);
    if (!slot) {
      await interaction.editReply({ content: `❌ اليوم ده (${chosenDate}) مش عنده مواعيد فاضية — جرب يوم تاني.` });
      return;
    }

    await db.update(auctionSchedulesTable)
      .set({
        scheduledDate: chosenDate,
        scheduledHour: slot.hour,
        roomChannelId: slot.roomChannelId,
        status:        "scheduled",
        delayMinutes:  0,
        reminded:      false,
      })
      .where(eq(auctionSchedulesTable.id, scheduleId));

    const changeBtn = new ButtonBuilder()
      .setCustomId(`aucchangeslot_${scheduleId}`)
      .setLabel("🔁 تغيير الميعاد")
      .setStyle(ButtonStyle.Primary);

    const ticketCh = sched.ticketChannelId
      ? (interaction.guild?.channels.cache.get(sched.ticketChannelId) as TextChannel | undefined)
      : (interaction.channel as TextChannel | undefined);

    await ticketCh?.send({
      content:
        `✅ **تم تحديد ميعاد مزادك!**\n\n` +
        `⏰ الموعد: **${hourToLabel(slot.hour)}** — ${chosenDate} (توقيت القاهرة)\n` +
        `📍 الروم: <#${slot.roomChannelId}>\n\n` +
        `مش عاجبك الميعاد؟ دوس على الزرار تحت ⬇️`,
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(changeBtn)],
    }).catch(() => {});

    await interaction.editReply({ content: "✅ تم! التذكرة هتتقفل بعد دقيقة." });

    if (interaction.guild) {
      await refreshAuctionScheduleMsg(interaction.guild, true).catch(() => {});
    }
    scheduleAuctionTicketAutoClose(scheduleId, ticketCh, 60_000);
    return;
  }

  // ── زرار تغيير الميعاد بعد ما البوت يحدده تلقائي (aucchangeslot_*) ─────
  if (interaction.isButton() && interaction.customId.startsWith("aucchangeslot_")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const scheduleId = parseInt(interaction.customId.replace("aucchangeslot_", ""), 10);
    const [sched] = await db.select().from(auctionSchedulesTable).where(eq(auctionSchedulesTable.id, scheduleId));

    if (!sched || sched.discordUserId !== interaction.user.id || sched.status !== "scheduled") {
      await interaction.editReply({ content: "❌ الحجز ده مش موجود أو مش قابل للتغيير دلوقتي." });
      return;
    }

    // أوقف الإقفال التلقائي للتذكرة لحد ما اليوزر يختار ميعاد جديد
    cancelAuctionTicketAutoClose(scheduleId);

    const { date, hour: currentHour } = getCairoTime();
    const booked = await db
      .select({ scheduledHour: auctionSchedulesTable.scheduledHour, roomChannelId: auctionSchedulesTable.roomChannelId })
      .from(auctionSchedulesTable)
      .where(
        and(
          eq(auctionSchedulesTable.scheduledDate, date),
          inArray(auctionSchedulesTable.status, ["scheduled", "active", "completed"]),
          ne(auctionSchedulesTable.id, scheduleId),
        ),
      );

    const usedRoomsByHour = new Map<number, Set<string>>();
    for (const b of booked) {
      if (b.scheduledHour == null || !b.roomChannelId) continue;
      if (!usedRoomsByHour.has(b.scheduledHour)) usedRoomsByHour.set(b.scheduledHour, new Set());
      usedRoomsByHour.get(b.scheduledHour)!.add(b.roomChannelId);
    }

    const availableHours = Array.from({ length: 13 }, (_, i) => i + 10) // 10 → 22
      .filter((h) => h > currentHour && (usedRoomsByHour.get(h)?.size ?? 0) < AUCTION_ROOM_CHANNEL_IDS.length);

    if (availableHours.length === 0) {
      await interaction.editReply({ content: "📭 مفيش مواعيد متاحة تانية اليوم — ميعادك الحالي هيفضل زي ما هو." });
      scheduleAuctionTicketAutoClose(scheduleId, interaction.channel as TextChannel, 60_000);
      return;
    }

    const slotButtons = availableHours.slice(0, 20).map((h) =>
      new ButtonBuilder()
        .setCustomId(`aucnewslot_${scheduleId}|${date}|${h}`)
        .setLabel(hourToLabel(h))
        .setStyle(ButtonStyle.Success),
    );
    const slotRows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let i = 0; i < slotButtons.length; i += 5) {
      slotRows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...slotButtons.slice(i, i + 5)));
    }

    await interaction.editReply({ content: "⬇️ اختار الميعاد الجديد:", components: slotRows });
    return;
  }

  // ── زرار اختيار ميعاد جديد (aucnewslot_*) ──────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("aucnewslot_")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const parts = interaction.customId.replace("aucnewslot_", "").split("|");
    if (parts.length !== 3) {
      await interaction.editReply({ content: "❌ بيانات الموعد غلط." });
      return;
    }
    const scheduleId = parseInt(parts[0], 10);
    const newDate    = parts[1];
    const newHour    = parseInt(parts[2], 10);

    const [sched] = await db.select().from(auctionSchedulesTable).where(eq(auctionSchedulesTable.id, scheduleId));
    if (!sched || sched.discordUserId !== interaction.user.id || sched.status !== "scheduled") {
      await interaction.editReply({ content: "❌ الحجز ده مش موجود." });
      return;
    }

    // تحقق من التوافر مرة تانية (race condition protection)
    const nowBooked = await db
      .select({ roomChannelId: auctionSchedulesTable.roomChannelId })
      .from(auctionSchedulesTable)
      .where(
        and(
          eq(auctionSchedulesTable.scheduledDate, newDate),
          eq(auctionSchedulesTable.scheduledHour, newHour),
          inArray(auctionSchedulesTable.status, ["scheduled", "active", "completed"]),
          ne(auctionSchedulesTable.id, scheduleId),
        ),
      );
    const bookedRoomIds = nowBooked.map((b) => b.roomChannelId).filter(Boolean) as string[];
    const freeRoom       = AUCTION_ROOM_CHANNEL_IDS.find((r) => !bookedRoomIds.includes(r));

    if (!freeRoom) {
      await interaction.editReply({ content: "❌ الميعاد ده امتلأ للتو. جرب ميعاد تاني." });
      return;
    }

    await db.update(auctionSchedulesTable)
      .set({ scheduledDate: newDate, scheduledHour: newHour, roomChannelId: freeRoom, delayMinutes: 0, reminded: false })
      .where(eq(auctionSchedulesTable.id, scheduleId));

    await interaction.editReply({ content: `✅ تم تغيير ميعادك إلى **${hourToLabel(newHour)}** — ${newDate}.` });

    if (interaction.guild) refreshAuctionScheduleMsg(interaction.guild).catch(() => {});
    scheduleAuctionTicketAutoClose(scheduleId, interaction.channel as TextChannel, 30_000);
    return;
  }

  // ── زرار المواعيد المحجوزة (auction_schedule_view) ──────────────────────
  if (interaction.isButton() && interaction.customId === "auction_schedule_view") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const { date } = getCairoTime();

    const schedules = await db
      .select()
      .from(auctionSchedulesTable)
      .where(
        and(
          eq(auctionSchedulesTable.scheduledDate, date),
          inArray(auctionSchedulesTable.status, ["scheduled", "active", "completed"]),
        ),
      );

    if (schedules.length === 0) {
      await interaction.editReply({ content: `📭 **مفيش مواعيد محجوزة اليوم** (${date})` });
      return;
    }

    const guildIconURL = interaction.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;
    const embed = new EmbedBuilder()
      .setAuthor({ name: "Dragon $hop", iconURL: guildIconURL })
      .setTitle(`📅 المواعيد المحجوزة — ${date}`)
      .setColor(0x5865f2)
      .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p" });

    if (guildIconURL) embed.setThumbnail(guildIconURL);

    const statusEmoji: Record<string, string> = {
      scheduled: "✅",
      active:    "🔴",
      completed: "✔️",
    };

    const typeEmoji: Record<string, string> = {
      everyone: "📢",
      here:     "📣",
      offers:   "🔔",
    };

    // رتّب حسب الساعة
    schedules.sort((a, b) => (a.scheduledHour ?? 0) - (b.scheduledHour ?? 0));

    const lines = schedules.map((s) => {
      const st   = statusEmoji[s.status] ?? "❓";
      const te   = typeEmoji[s.auctionType] ?? "";
      const time = `${hourToLabel(s.scheduledHour ?? 0)}:00`;
      const type = AUCTION_TYPES[s.auctionType as AuctionType]?.label ?? s.auctionType;
      return `${st} **${time}** — ${te} ${type} — <@${s.discordUserId}>`;
    });

    embed.setDescription(lines.join("\n"));

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  // ── زرار إلغاء تذكرة مزاد (close_auction_ticket_*) ─────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("close_auction_ticket_")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const auctionId = parseInt(interaction.customId.replace("close_auction_ticket_", ""), 10);
    const [aRecord] = await db.select().from(auctionSchedulesTable).where(eq(auctionSchedulesTable.id, auctionId));
    if (!aRecord) { await interaction.editReply({ content: "❌ الحجز مش موجود." }); return; }

    if (aRecord.status === "pending_payment") {
      await db.update(auctionSchedulesTable).set({ status: "cancelled" }).where(eq(auctionSchedulesTable.id, auctionId));
    }

    await interaction.editReply({ content: "🔒 جاري إلغاء الحجز..." });
    const ch = interaction.channel as TextChannel;
    setTimeout(() => ch.delete("Auction ticket cancelled").catch(() => {}), 3000);
    return;
  }

  // ── زرار معلومات روم (roominfo_*) ───────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("roominfo_")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const roomId = parseInt(interaction.customId.replace("roominfo_", ""), 10);
    const [room] = await db.select().from(roomsTable).where(eq(roomsTable.id, roomId));

    if (!room) {
      await interaction.editReply({ content: "❌ الروم مش موجود." });
      return;
    }

    const guildIconURL = interaction.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;
    const label        = roomLabel(room.name);
    const transferAmt  = calcTransferAmount(Number(room.price));
    const roleId       = ROOM_ROLE_IDS[room.name]; // قد يكون undefined لو الروم جديد

    const embed = new EmbedBuilder()
      .setAuthor({ name: "Dragon $hop", iconURL: guildIconURL })
      .setTitle(`丰丰 معلومات النوع 丰丰 ${label}`)
      .setColor(0x00bfff)
      .addFields(
        {
          name:  "‎",
          value:
            `丰 ▪ اسم النوع : ${label}\n` +
            `丰 ▪ شكل الرتبة : ${room.decorations || ""}${roleId ? ` <@&${roleId}>` : ""}\n` +
            `ـﮩ══════════════ﮩـ`,
          inline: false,
        },
        {
          name:  "منشنات النوع :",
          value:
            `◈ − @everyone : ${room.everyoneCount}\n` +
            `◈ − @here : ${room.hereCount}\n` +
            `◈ − <@&${OFFERS_ROLE_ID}> : ${room.offersCount}\n` +
            `ـﮩ══════════════ﮩـ`,
          inline: false,
        },
        {
          name:  "🎰 السعر :",
          value:
            `丰 ▪ السعر بكريدت : ${Math.round(Number(room.price))}\n` +
            `💸 مبلغ التحويل مع عمولة ProBot : ${transferAmt}`,
          inline: false,
        },
      )
      .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p" });

    // أضف صورة التنين لو موجودة
    const files: AttachmentBuilder[] = [];
    if (fs.existsSync(DRAGON_IMAGE_PATH)) {
      files.push(new AttachmentBuilder(DRAGON_IMAGE_PATH, { name: "dragon.webp" }));
      embed.setThumbnail("attachment://dragon.webp");
    }

    // NOTE: زرار الشراء اتشال من هنا — الشراء بقى بس من قائمة "🛒 شراء" المنفصلة (openbuymenu).
    //       الإمبيد ده بقى لعرض الأسعار فقط.
    await interaction.editReply({
      embeds: [embed],
      files,
    });
    return;
  }

  // ── زرار شراء (buy_*) ───────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("buy_")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const roomId = parseInt(interaction.customId.replace("buy_", ""), 10);
    const [room] = await db.select().from(roomsTable).where(eq(roomsTable.id, roomId));
    if (!room) { await interaction.editReply({ content: "❌ الروم مش موجود." }); return; }

    const userId   = interaction.user.id;
    const username = interaction.user.username;

    if (await isUserBanned(userId)) {
      await interaction.editReply({ content: "❌ أنت محظور حالياً ولا تستطيع الشراء." });
      return;
    }

    const guild       = interaction.guild!;
    const transferAmt = calcTransferAmount(Number(room.price));

    // إنشاء شانل التذكرة
    // NOTE: التذكرة بتتعمل تحت كاتيجوري TICKETS_CATEGORY_ID.
    //       الـ everyone مش يشوفها — بس العميل والبوت.
    const ticketChannel = await guild.channels.create({
      name:   `ticket-${username}-${room.name}`,
      type:   ChannelType.GuildText,
      parent: TICKETS_CATEGORY_ID,
      permissionOverwrites: [
        { id: guild.id,              deny:  [PermissionFlagsBits.ViewChannel] },
        { id: userId,                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
        { id: guild.roles.everyone,  deny:  [PermissionFlagsBits.ViewChannel] },
      ],
    });

    // أضف الشراء في DB بستاتوس pending
    const [purchase] = await db
      .insert(purchasesTable)
      .values({
        discordUserId:   userId,
        discordUsername: username,
        roomId:          room.id,
        roomName:        room.name,
        totalPrice:      String(transferAmt),
        status:          "pending",
        ticketChannelId: ticketChannel.id,
      })
      .returning();

    const transferCommand = `C <@${OWNER_ID}> ${transferAmt}`;
    await db
      .update(purchasesTable)
      .set({ transferCommand })
      .where(eq(purchasesTable.id, purchase.id));

    const closeBtn  = new ButtonBuilder()
      .setCustomId(`close_ticket_${purchase.id}`)
      .setLabel("🔒 إغلاق التذكرة")
      .setStyle(ButtonStyle.Danger);
    const getCmdBtn = new ButtonBuilder()
      .setCustomId(`get_transfer_cmd_${purchase.id}`)
      .setLabel("📋 أمر التحويل")
      .setStyle(ButtonStyle.Secondary);
    const promoBtn  = new ButtonBuilder()
      .setCustomId(`open_promo_modal_${purchase.id}`)
      .setLabel("عندي كود خصم")
      .setEmoji("1524963455797297152")
      .setStyle(ButtonStyle.Success);

    const ticketEmbed = new EmbedBuilder()
      .setTitle(`🎟️ تذكرة شراء — ${room.name}`)
      .setDescription(
        `مرحباً <@${userId}>! 👋\n\n` +
        `**الروم المطلوب:** ${room.name}\n` +
        `**السعر الصافي:** ${Math.round(Number(room.price))}\n` +
        `**مبلغ التحويل (مع عمولة ProBot 5%):** \`${transferAmt}\`\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📋 **أمر التحويل:**\n\`${transferCommand}\`\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `1️⃣ انسخ الأمر فوق وبعثه في سيرفر ProBot\n` +
        `2️⃣ بعد التحويل، البوت هيتأكد تلقائياً\n` +
        `3️⃣ بعدين اكتب اسم الروم اللي عايزه هنا\n\n` +
        `🎟️ لو عندك كود خصم، اضغط الزرار تحت **قبل** التحويل.`
      )
      .setColor(0xffd700);

    await ticketChannel.send({
      content:    `<@${userId}>`,
      embeds:     [ticketEmbed],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(getCmdBtn, promoBtn, closeBtn)],
    });

    await interaction.editReply({ content: `✅ تم إنشاء تذكرتك! اضغط هنا: <#${ticketChannel.id}>` });
    return;
  }

  // ── زرار أمر التحويل (get_transfer_cmd_*) ────────────────────────────────
  // NOTE: بيبعت الأمر مرتين — مرة كنص عادي ومرة كـ code block.
  //       ده عشان سهولة النسخ على كل الأجهزة.
  if (interaction.isButton() && interaction.customId.startsWith("get_transfer_cmd_")) {
    const purchaseId = parseInt(interaction.customId.replace("get_transfer_cmd_", ""), 10);
    const [purchase] = await db.select().from(purchasesTable).where(eq(purchasesTable.id, purchaseId));
    if (!purchase) {
      await interaction.reply({ content: "❌ الشراء مش موجود.", flags: MessageFlags.Ephemeral });
      return;
    }
    const amount   = purchase.transferCommand?.split(" ").pop() ?? Math.round(Number(purchase.totalPrice));
    const plainCmd = `C <@${OWNER_ID}> ${amount}`;
    await interaction.reply({ content: plainCmd, flags: MessageFlags.Ephemeral });
    await interaction.followUp({ content: `\`${plainCmd}\``, flags: MessageFlags.Ephemeral });
    return;
  }

  // ── زرار فتح مودال كود الخصم (open_promo_modal_*) ───────────────────────
  // NOTE: بيفتح مودال بسيط فيه خانة نص واحدة لإدخال الكود.
  //       التحقق والتطبيق الفعلي بيحصل في modal_promo_code_* handler.
  if (interaction.isButton() && interaction.customId.startsWith("open_promo_modal_")) {
    const purchaseId = parseInt(interaction.customId.replace("open_promo_modal_", ""), 10);

    const modal = new ModalBuilder()
      .setCustomId(`modal_promo_code_${purchaseId}`)
      .setTitle("🎟️ كود الخصم");

    const codeInput = new TextInputBuilder()
      .setCustomId("promo_code_input")
      .setLabel("اكتب الكود هنا")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(50);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(codeInput));
    await interaction.showModal(modal);
    return;
  }

  // ── مودال كود الخصم (modal_promo_code_*) ─────────────────────────────────
  // NOTE: بيتحقق من:
  //   1. إن التذكرة لسه pending (مش دفعت أو اتلغت أو خلصت).
  //   2. إن اللي بيستخدم الزرار هو صاحب التذكرة.
  //   3. إن الكود موجود، شغال (isActive)، ومعندوش استخدامات زيادة عن maxUses.
  //   4. إن التذكرة دي معملهاش خصم قبل كده (مينفعش تطبق كودين).
  // بعد التحقق: بيحسب الخصم، لو فيه فايض بيتحول نقاط، وبيحدّث totalPrice/transferCommand.
  // لو الخصم غطى السعر بالكامل → التذكرة بتتحط على "awaiting_room_name" على طول من غير ما ProBot يتحقق من حاجة.
  if (interaction.isModalSubmit() && interaction.customId.startsWith("modal_promo_code_")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const purchaseId = parseInt(interaction.customId.replace("modal_promo_code_", ""), 10);
    const rawCode     = interaction.fields.getTextInputValue("promo_code_input").trim().toUpperCase();
    const userId      = interaction.user.id;

    const [purchase] = await db.select().from(purchasesTable).where(eq(purchasesTable.id, purchaseId));
    if (!purchase) {
      await interaction.editReply({ content: "❌ التذكرة مش موجودة." });
      return;
    }
    if (purchase.discordUserId !== userId) {
      await interaction.editReply({ content: "❌ التذكرة دي مش ليك." });
      return;
    }
    if (purchase.status !== "pending") {
      await interaction.editReply({ content: "❌ مينفعش تستخدم كود بعد إرسال التحويل أو بعد ما التذكرة خلصت." });
      return;
    }
    if (purchase.appliedPromoCode) {
      await interaction.editReply({ content: `⚠️ انت مستخدم كود \`${purchase.appliedPromoCode}\` بالفعل على التذكرة دي.` });
      return;
    }

    const [promo] = await db.select().from(promoCodesTable).where(eq(promoCodesTable.code, rawCode));
    if (!promo || !promo.isActive || promo.usedCount >= promo.maxUses) {
      await interaction.editReply({ content: `❌ الكود \`${rawCode}\` مش موجود أو خلص استخدامه.` });
      return;
    }
    if (promo.type !== "discount") {
      await interaction.editReply({ content: "❌ الكود ده مش كود خصم." });
      return;
    }

    const [room] = await db.select().from(roomsTable).where(eq(roomsTable.id, purchase.roomId));
    if (!room) {
      await interaction.editReply({ content: "❌ حصل خطأ في بيانات الروم." });
      return;
    }

    const netPrice      = Number(room.price);
    const discount      = Math.min(promo.value, netPrice);
    const remainingNet  = netPrice - discount;
    const pointsAwarded = promo.value - discount;
    const newTransferAmt = remainingNet > 0 ? calcTransferAmount(remainingNet) : 0;
    const newTransferCommand = remainingNet > 0 ? `C <@${OWNER_ID}> ${newTransferAmt}` : null;

    // ── تطبيق ذري (atomic) عشان نمنع race condition لو حد ضغط الزرار مرتين
    //    بسرعة أو استخدم نفس الكود من تكتين في نفس اللحظة ──────────────────
    // 1. حجز استخدام الكود: بيتحدث بس لو لسه في حدود maxUses.
    const [reservedPromo] = await db.update(promoCodesTable)
      .set({ usedCount: sql`${promoCodesTable.usedCount} + 1` })
      .where(and(eq(promoCodesTable.id, promo.id), lt(promoCodesTable.usedCount, promo.maxUses), eq(promoCodesTable.isActive, true)))
      .returning();

    if (!reservedPromo) {
      await interaction.editReply({ content: `❌ الكود \`${rawCode}\` خلص استخدامه لسه فيه.` });
      return;
    }
    if (reservedPromo.usedCount >= reservedPromo.maxUses) {
      await db.update(promoCodesTable).set({ isActive: false }).where(eq(promoCodesTable.id, promo.id));
    }

    // 2. حجز التذكرة نفسها: بيتحدث بس لو لسه pending ومفيهاش كود متطبق قبل كده.
    const [reservedPurchase] = await db.update(purchasesTable)
      .set({
        totalPrice:       String(newTransferAmt),
        transferCommand:  newTransferCommand,
        appliedPromoCode: rawCode,
        discountAmount:   discount,
        // لو الخصم غطى السعر بالكامل — مفيش داعي لـ ProBot، ننتقل لمرحلة اسم الروم على طول
        status:           remainingNet === 0 ? "awaiting_room_name" : purchase.status,
      })
      .where(and(
        eq(purchasesTable.id, purchase.id),
        eq(purchasesTable.status, "pending"),
        isNull(purchasesTable.appliedPromoCode),
      ))
      .returning();

    if (!reservedPurchase) {
      // فشل حجز التذكرة (اتطبق كود عليها بالفعل أو اتغيرت حالتها) — رجّع الكود زي ما كان
      await db.update(promoCodesTable)
        .set({ usedCount: sql`${promoCodesTable.usedCount} - 1`, isActive: true })
        .where(eq(promoCodesTable.id, promo.id));
      await interaction.editReply({ content: "❌ التذكرة دي اتطبق عليها كود بالفعل أو حالتها اتغيرت." });
      return;
    }

    await db.insert(promoRedemptionsTable).values({
      promoCodeId:     promo.id,
      discordUserId:   userId,
      purchaseId:      purchase.id,
      discountApplied: discount,
      pointsAwarded,
    });

    if (pointsAwarded > 0) {
      await addUserPoints(userId, pointsAwarded);
    }

    const ticketChannel = interaction.channel as TextChannel | null;

    if (remainingNet === 0) {
      await ticketChannel?.send({
        content:
          `<@${userId}>\n` +
          `🎟️ تم تطبيق كود \`${rawCode}\` — الخصم غطّى سعر المتجر بالكامل! ✅\n` +
          (pointsAwarded > 0 ? `💠 وتم تحويل الباقي (**${pointsAwarded.toLocaleString()}**) لنقاط في حسابك.\n` : "") +
          `\n**مفيش داعي تدفع حاجة.** اكتب اسم الروم اللي عايزه هنا ⬇️`,
      }).catch(() => {});
    } else {
      await ticketChannel?.send({
        content:
          `<@${userId}>\n` +
          `🎟️ تم تطبيق كود \`${rawCode}\` — خصم **${discount.toLocaleString()}** كريدت! ✅\n` +
          (pointsAwarded > 0 ? `💠 وتم تحويل الباقي (**${pointsAwarded.toLocaleString()}**) لنقاط في حسابك.\n` : "") +
          `\n📋 **أمر التحويل الجديد:**\n\`${newTransferCommand}\`\n` +
          `💰 المبلغ الجديد المطلوب (مع عمولة ProBot 5%): \`${newTransferAmt}\``,
      }).catch(() => {});
    }

    await interaction.editReply({
      content: remainingNet === 0
        ? `✅ تم تطبيق الكود! المتجر اتغطى بالكامل، اكتب اسم الروم في التذكرة.`
        : `✅ تم تطبيق الكود! السعر الجديد بعد الخصم: **${newTransferAmt.toLocaleString()}** كريدت.`,
    });
    return;
  }

  // ── زرار "طلب المنتج" (request_product_<roomChannelId>) ──────────────────
  // NOTE: بيفتح ثريد خاص بين العميل وصاحب المتجر (وشريكه لو موجود) وكل
  //       الأدمنز، عشان مراجعة الطلب. كل متجر ليه عداد تكتات مستقل.
  if (interaction.isButton() && interaction.customId.startsWith("request_product_")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const roomChannelId = interaction.customId.replace("request_product_", "");
    const guild = interaction.guild;
    if (!guild) { await interaction.editReply({ content: "❌ الأمر ده شغال في السيرفر بس." }); return; }

    const [roomPurchase] = await db
      .select()
      .from(purchasesTable)
      .where(
        and(
          eq(purchasesTable.discordRoomId, roomChannelId),
          eq(purchasesTable.status, "completed"),
        ),
      );

    if (!roomPurchase) {
      await interaction.editReply({ content: "❌ المتجر ده مش موجود أو اتقفل." });
      return;
    }

    const storeOwnerId = roomPurchase.discordUserId;
    const partnerId    = roomPurchase.partnerDiscordUserId;

    if (interaction.user.id === storeOwnerId || interaction.user.id === partnerId) {
      await interaction.editReply({ content: "❌ مينفعش تطلب من متجرك بنفسك." });
      return;
    }

    const roomChannel = guild.channels.cache.get(roomChannelId) as TextChannel | undefined;
    if (!roomChannel) {
      await interaction.editReply({ content: "❌ متلاقيش شانل المتجر." });
      return;
    }

    // احسب رقم التكت — عداد مستقل لكل متجر (roomChannelId).
    // NOTE: في يونيك كونسترينت على (roomChannelId, ticketNumber) في الـ DB،
    //       فلو حصل تعارض بسبب ضغط متزامن بنعيد المحاولة برقم أعلى.
    let thread: import("discord.js").ThreadChannel | null = null;
    let ticketNumber = 0;
    let paddedNumber = "";
    const MAX_ATTEMPTS = 5;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const existingCount = await db
        .select({ id: productRequestsTable.id })
        .from(productRequestsTable)
        .where(eq(productRequestsTable.roomChannelId, roomChannelId))
        .then((rows) => rows.length);
      ticketNumber = existingCount + 1;
      paddedNumber = padTicketNumber(ticketNumber);

      if (!thread) {
        thread = await roomChannel.threads
          .create({
            name: `طلب-${paddedNumber}`,
            type: ChannelType.PrivateThread,
            invitable: false,
            reason: `طلب منتج من ${interaction.user.username}`,
          })
          .catch((err) => {
            logger.error({ err, roomChannelId }, "Failed to create product request thread");
            return null;
          });
        if (!thread) {
          await interaction.editReply({ content: "❌ فشل إنشاء ثريد المراجعة — جرب تاني." });
          return;
        }
      } else {
        await thread.setName(`طلب-${paddedNumber}`).catch(() => {});
      }

      try {
        await db.insert(productRequestsTable).values({
          roomChannelId,
          ticketNumber,
          threadId:          thread.id,
          requesterId:       interaction.user.id,
          requesterUsername: interaction.user.username,
          storeOwnerId,
          status:            "open",
        });
        break; // نجح الإدراج — كمّل
      } catch (err) {
        if (attempt === MAX_ATTEMPTS - 1) {
          await thread.delete("Failed to allocate ticket number").catch(() => {});
          logger.error({ err, roomChannelId }, "Failed to allocate product request ticket number");
          await interaction.editReply({ content: "❌ فشل حجز رقم التكت — جرب تاني." });
          return;
        }
        // تعارض على رقم التكت — أعد المحاولة برقم أعلى في نفس الثريد
      }
    }

    // ضيف الأطراف: العميل، صاحب المتجر، الشريك (لو موجود)، وأعضاء رتبة المراجعة
    const reviewerIds = await getRoleMemberIds(guild, PRODUCT_REQUEST_REVIEWER_ROLE_ID);
    const memberIds = new Set<string>([interaction.user.id, storeOwnerId, ...reviewerIds]);
    if (partnerId) memberIds.add(partnerId);

    for (const id of memberIds) {
      await thread!.members.add(id).catch(() => {});
    }

    const closeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`close_product_request_${thread.id}`)
        .setLabel("🔒 قفل التكت")
        .setStyle(ButtonStyle.Danger),
    );

    const requestEmbed = new EmbedBuilder()
      .setTitle(`📦 طلب منتج #${paddedNumber}`)
      .setDescription(
        `العميل: <@${interaction.user.id}>\n` +
        `صاحب المتجر: <@${storeOwnerId}>${partnerId ? `\nالشريك: <@${partnerId}>` : ""}\n\n` +
        `اتفقوا على الطلب هنا، وبعد ما تخلصوا اضغطوا "قفل التكت" عشان الأدمن يراجعه.`,
      )
      .setColor(0x00c8ff);

    await thread.send({
      content: `<@${interaction.user.id}> <@${storeOwnerId}>${partnerId ? ` <@${partnerId}>` : ""}`,
      embeds: [requestEmbed],
      components: [closeRow],
    }).catch(() => {});

    await interaction.editReply({ content: `✅ تم فتح تكت الطلب: ${thread}` });
    return;
  }

  // ── زرار "قفل التكت" (close_product_request_<threadId>) ─────────────────
  // NOTE: بيطرد العميل وصاحب المتجر (والشريك) من الثريد، ويسيب بس الأدمنز
  //       عشان يراجعوا الطلب، وبيغير اسم الثريد لـ closed-XXX.
  if (interaction.isButton() && interaction.customId.startsWith("close_product_request_")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const threadId = interaction.customId.replace("close_product_request_", "");
    const [record] = await db
      .select()
      .from(productRequestsTable)
      .where(eq(productRequestsTable.threadId, threadId));

    if (!record) { await interaction.editReply({ content: "❌ التكت ده مش موجود." }); return; }
    if (record.status === "closed") { await interaction.editReply({ content: "❌ التكت ده اتقفل بالفعل." }); return; }

    const thread = interaction.channel;
    if (!thread || !thread.isThread()) { await interaction.editReply({ content: "❌ الزرار ده شغال جوه الثريد بس." }); return; }
    const guild = interaction.guild;
    if (!guild) { await interaction.editReply({ content: "❌ الأمر ده شغال في السيرفر بس." }); return; }

    // اطرد العميل وصاحب المتجر والشريك من الثريد — سيبوا الأدمنز بس.
    // NOTE: لو حد منهم عضو في رتبة المراجعة أصلاً، سيبه — القاعدة إن اللي
    //       يفضل في الثريد بعد القفل هم أعضاء رتبة المراجعة بس.
    const idsToRemove = new Set<string>([record.requesterId, record.storeOwnerId]);
    const [roomPurchase] = await db
      .select({ partnerDiscordUserId: purchasesTable.partnerDiscordUserId })
      .from(purchasesTable)
      .where(eq(purchasesTable.discordRoomId, record.roomChannelId));
    if (roomPurchase?.partnerDiscordUserId) idsToRemove.add(roomPurchase.partnerDiscordUserId);

    const reviewerIds = new Set(await getRoleMemberIds(guild, PRODUCT_REQUEST_REVIEWER_ROLE_ID));
    for (const id of idsToRemove) {
      if (reviewerIds.has(id)) continue; // عضو مراجعة — يفضل في الثريد للمراجعة
      await thread.members.remove(id).catch(() => {});
    }

    const paddedNumber = padTicketNumber(record.ticketNumber);
    await thread.setName(`closed-${paddedNumber}`).catch(() => {});

    await db
      .update(productRequestsTable)
      .set({ status: "closed", closedAt: new Date() })
      .where(eq(productRequestsTable.id, record.id));

    await thread.send({ content: `🔒 تم قفل التكت — التاجر والعميل اتشالوا، متبقّي غير رتبة المراجعة.` }).catch(() => {});
    await interaction.editReply({ content: "✅ تم قفل التكت." });
    return;
  }

  // ── زرار إغلاق التذكرة (close_ticket_*) ─────────────────────────────────
  // NOTE: الشانل بيتحذف بعد 3 ثواني من الضغط.
  //       لو الشراء لسه pending يبقى cancelled في DB.
  if (interaction.isButton() && interaction.customId.startsWith("close_ticket_")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const purchaseId = parseInt(interaction.customId.replace("close_ticket_", ""), 10);
    const [purchase] = await db.select().from(purchasesTable).where(eq(purchasesTable.id, purchaseId));
    if (!purchase) { await interaction.editReply({ content: "❌ التذكرة مش موجودة." }); return; }

    if (purchase.status === "pending") {
      await db
        .update(purchasesTable)
        .set({ status: "cancelled" })
        .where(eq(purchasesTable.id, purchaseId));
    }

    const ch = interaction.channel as TextChannel;
    await interaction.editReply({ content: "🔒 جاري إغلاق التذكرة..." });
    setTimeout(() => ch.delete("Ticket closed manually").catch(() => {}), 3000);
    return;
  }

  // ── زرار تأكيد تحويل الملكية (confirm_transfer_*) ────────────────────────
  // NOTE: بس الأونر يقدر يضغطه.
  //       الـ customId بيكون: confirm_transfer_{purchaseId}_{newOwnerId}
  if (interaction.isButton() && interaction.customId.startsWith("confirm_transfer_")) {
    if (interaction.user.id !== OWNER_ID) {
      await interaction.reply({ content: "❌ بس الأونر يقدر يؤكد التحويل.", flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const parts      = interaction.customId.replace("confirm_transfer_", "").split("_");
    const purchaseId = parseInt(parts[0], 10);
    const newOwnerId = parts[1];

    const [purchase] = await db.select().from(purchasesTable).where(eq(purchasesTable.id, purchaseId));
    if (!purchase) { await interaction.editReply({ content: "❌ الشراء مش موجود." }); return; }

    // حدّث الـ owner في DB
    await db
      .update(purchasesTable)
      .set({ discordUserId: newOwnerId })
      .where(eq(purchasesTable.id, purchaseId));

    // حدّث permissions الشانل في Discord
    if (purchase.discordRoomId) {
      const roomChannel = interaction.guild!.channels.cache.get(purchase.discordRoomId) as TextChannel | undefined;
      if (roomChannel) {
        await roomChannel.permissionOverwrites
          .create(newOwnerId, { ViewChannel: true, SendMessages: true, MentionEveryone: true })
          .catch(() => {});
        await roomChannel.permissionOverwrites
          .delete(purchase.discordUserId)
          .catch(() => {});
        await roomChannel.send(
          `✅ تم تحويل ملكية الروم من <@${purchase.discordUserId}> لـ <@${newOwnerId}>.`
        );
      }
    }

    await interaction.editReply({ content: `✅ تم تحويل الملكية بنجاح.` });
    return;
  }

  // ── زرار دفع إزالة التحذير (pay_remove_warning_*) ───────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("pay_remove_warning_")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const purchaseId = parseInt(interaction.customId.replace("pay_remove_warning_", ""), 10);
    const userId     = interaction.user.id;

    const purchase = await db.select().from(purchasesTable)
      .where(and(eq(purchasesTable.id, purchaseId), eq(purchasesTable.discordUserId, userId)))
      .then((r) => r[0]);

    if (!purchase) {
      await interaction.editReply({ content: "❌ مش لاقي المتجر ده." });
      return;
    }
    if (pendingWarningRemovals.has(userId)) {
      await interaction.editReply({ content: "⏳ عندك عملية إزالة تحذير لسه شغّالة. خلّيها تخلص الأول." });
      return;
    }

    const transferAmt = calcTransferAmount(WARNING_REMOVAL_PRICE);
    const cmd         = `C <@${OWNER_ID}> ${transferAmt}`;
    const expiresAt   = Date.now() + 5 * 60 * 1000;
    const timeoutId   = setTimeout(() => { pendingWarningRemovals.delete(userId); }, 5 * 60 * 1000);

    pendingWarningRemovals.set(userId, {
      userId,
      username:      interaction.user.username,
      purchaseId,
      roomChannelId: purchase.discordRoomId ?? "",
      netPrice:      WARNING_REMOVAL_PRICE,
      transferAmt,
      guildId:       interaction.guildId ?? "",
      expiresAt,
      timeoutId,
    });

    const DIV_WB = "ـﮩ════════════════ﮩـ";
    const gIWB   = interaction.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;
    const wbEmbed = new EmbedBuilder()
      .setAuthor({ name: "Dragon $hop", iconURL: gIWB })
      .setTitle("💸 إزالة التحذير")
      .setDescription(`<@${userId}>\n> ${DIV_WB}`)
      .setColor(0xff9900)
      .addFields(
        { name: `${STAR_EMOJI} المبلغ المطلوب`, value: `> ${MONEY_EMOJI} **${transferAmt.toLocaleString()}** كريدت\n> ${DIV_WB}`, inline: false },
        { name: `${STAR_EMOJI} الأمر`,          value: `\`\`\`${cmd}\`\`\`\n> ${DIV_WB}`,                                          inline: false },
        { name: `${STAR_EMOJI} المهلة`,          value: `> ⏳ عندك **5 دقايق** تحول فيهم\n> ${DIV_WB}`,                             inline: false },
      )
      .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: gIWB });

    await interaction.editReply({ embeds: [wbEmbed] });
    return;
  }

  // ── زرار دفع إعادة التفعيل (pay_reactivate_room_*) ──────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("pay_reactivate_room_")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const purchaseId = parseInt(interaction.customId.replace("pay_reactivate_room_", ""), 10);
    const userId     = interaction.user.id;

    const purchase = await db.select().from(purchasesTable)
      .where(eq(purchasesTable.id, purchaseId))
      .then((r) => r[0]);

    if (!purchase || !purchase.isRoomDeactivated) {
      await interaction.editReply({ content: "❌ المتجر ده مش محتاج تفعيل." });
      return;
    }
    if (purchase.discordUserId !== userId) {
      await interaction.editReply({ content: "❌ الزرار ده مش ليك." });
      return;
    }
    if (pendingRoomReactivations.has(userId)) {
      await interaction.editReply({ content: "⏳ عندك عملية تفعيل لسه شغّالة." });
      return;
    }

    const [room]        = await db.select().from(roomsTable).where(eq(roomsTable.id, purchase.roomId));
    const reactNet      = room ? Math.ceil(Number(room.price) * 0.5) : 1_000_000;
    const reactGross    = calcTransferAmount(reactNet);
    const cmd           = `C <@${OWNER_ID}> ${reactGross}`;
    const expiresAt     = Date.now() + 5 * 60 * 1000;
    const timeoutId     = setTimeout(() => { pendingRoomReactivations.delete(userId); }, 5 * 60 * 1000);

    pendingRoomReactivations.set(userId, {
      userId,
      username:      interaction.user.username,
      purchaseId,
      roomChannelId: purchase.discordRoomId ?? "",
      netPrice:      reactNet,
      transferAmt:   reactGross,
      guildId:       interaction.guildId ?? "",
      expiresAt,
      timeoutId,
    });

    const reactChannel = interaction.guild?.channels.cache.get(REACTIVATION_CHANNEL_ID) as TextChannel | undefined;
    if (reactChannel) {
      await reactChannel.send(
        `<@${userId}> لإعادة تفعيل متجرك حوّل المبلغ التالي:\n\`\`\`${cmd}\`\`\``
      ).catch(() => {});
    }

    await interaction.editReply({
      content:
        `✅ تم إرسال أمر التحويل في <#${REACTIVATION_CHANNEL_ID}>\n` +
        `💰 المبلغ: **${reactGross.toLocaleString()}** كريدت\n` +
        `⏳ عندك **5 دقايق** تحول فيهم.`,
    });
    return;
  }

  // ── زرار دفع إضافة شريك (pay_add_partner_*) ─────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("pay_add_partner_")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const purchaseId = parseInt(interaction.customId.replace("pay_add_partner_", ""), 10);
    const userId     = interaction.user.id;

    const purchase = await db.select().from(purchasesTable)
      .where(and(
        eq(purchasesTable.id, purchaseId),
        eq(purchasesTable.discordUserId, userId),
        eq(purchasesTable.status, "completed"),
      ))
      .then((r) => r[0]);

    if (!purchase || !purchase.discordRoomId) {
      await interaction.editReply({ content: "❌ مش لاقي المتجر ده." });
      return;
    }
    if (purchase.partnerDiscordUserId) {
      await interaction.editReply({ content: "❌ متجرك عنده شريك بالفعل." });
      return;
    }
    if (pendingAddPartners.has(userId)) {
      await interaction.editReply({ content: "⏳ عندك عملية إضافة شريك لسه شغّالة." });
      return;
    }

    const apGross   = calcTransferAmount(ADD_PARTNER_PRICE);
    const cmd       = `C <@${OWNER_ID}> ${apGross}`;
    const expiresAt = Date.now() + 5 * 60 * 1000;
    const timeoutId = setTimeout(() => { pendingAddPartners.delete(userId); }, 5 * 60 * 1000);

    pendingAddPartners.set(userId, {
      userId,
      username:      interaction.user.username,
      purchaseId,
      roomChannelId: purchase.discordRoomId,
      netPrice:      ADD_PARTNER_PRICE,
      transferAmt:   apGross,
      guildId:       interaction.guildId ?? "",
      expiresAt,
      timeoutId,
    });

    // أرسل أمر ProBot في قناة التحويلات
    const apChannel = interaction.guild?.channels.cache.get(REACTIVATION_CHANNEL_ID) as TextChannel | undefined;
    if (apChannel) {
      await apChannel.send(
        `<@${userId}> لإضافة شريك لمتجرك حوّل المبلغ التالي:\n\`\`\`${cmd}\`\`\``
      ).catch(() => {});
    }

    const DIV_APB = "ـﮩ════════════════ﮩـ";
    const gIAPB   = interaction.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;
    const apPayEmbed = new EmbedBuilder()
      .setAuthor({ name: "Dragon $hop", iconURL: gIAPB })
      .setTitle("🤝 إضافة شريك")
      .setDescription(
        `<@${userId}>\n> ${DIV_APB}\n\n` +
        `\`\`\`${cmd}\`\`\`\n` +
        `> ${MONEY_EMOJI} **${apGross.toLocaleString()}** كريدت\n` +
        `> ⏳ عندك **5 دقايق** تحول فيهم\n> ${DIV_APB}`
      )
      .setColor(0x00bfff)
      .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: gIAPB });

    await interaction.editReply({ embeds: [apPayEmbed] });
    return;
  }

  // ── زرار دفع إزالة شريك (pay_remove_partner_*) ───────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("pay_remove_partner_")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const purchaseId = parseInt(interaction.customId.replace("pay_remove_partner_", ""), 10);
    const userId     = interaction.user.id;

    const purchase = await db.select().from(purchasesTable)
      .where(and(
        eq(purchasesTable.id, purchaseId),
        eq(purchasesTable.discordUserId, userId),
        eq(purchasesTable.status, "completed"),
      ))
      .then((r) => r[0]);

    if (!purchase || !purchase.discordRoomId) {
      await interaction.editReply({ content: "❌ مش لاقي المتجر ده." });
      return;
    }
    if (!purchase.partnerDiscordUserId) {
      await interaction.editReply({ content: "❌ متجرك مفيش فيه شريك." });
      return;
    }
    if (pendingRemovePartners.has(userId)) {
      await interaction.editReply({ content: "⏳ عندك عملية إزالة شريك لسه شغّالة." });
      return;
    }

    const rpGross   = calcTransferAmount(REMOVE_PARTNER_PRICE);
    const cmd       = `C <@${OWNER_ID}> ${rpGross}`;
    const expiresAt = Date.now() + 5 * 60 * 1000;
    const timeoutId = setTimeout(() => { pendingRemovePartners.delete(userId); }, 5 * 60 * 1000);

    pendingRemovePartners.set(userId, {
      userId,
      username:      interaction.user.username,
      purchaseId,
      roomChannelId: purchase.discordRoomId,
      partnerId:     purchase.partnerDiscordUserId,
      netPrice:      REMOVE_PARTNER_PRICE,
      transferAmt:   rpGross,
      guildId:       interaction.guildId ?? "",
      expiresAt,
      timeoutId,
    });

    const rpChannel = interaction.guild?.channels.cache.get(REACTIVATION_CHANNEL_ID) as TextChannel | undefined;
    if (rpChannel) {
      await rpChannel.send(
        `<@${userId}> لإزالة شريك من متجرك حوّل المبلغ التالي:\n\`\`\`${cmd}\`\`\``
      ).catch(() => {});
    }

    const DIV_RPB = "ـﮩ════════════════ﮩـ";
    const gIRPB   = interaction.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;
    const rpPayEmbed = new EmbedBuilder()
      .setAuthor({ name: "Dragon $hop", iconURL: gIRPB })
      .setTitle("🗑️ إزالة شريك")
      .setDescription(
        `<@${userId}>\n> ${DIV_RPB}\n\n` +
        `\`\`\`${cmd}\`\`\`\n` +
        `> ${MONEY_EMOJI} **${rpGross.toLocaleString()}** كريدت\n` +
        `> ⏳ عندك **5 دقايق** تحول فيهم\n> ${DIV_RPB}`
      )
      .setColor(0xff4444)
      .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: gIRPB });

    await interaction.editReply({ embeds: [rpPayEmbed] });
    return;
  }

  // ── زرار دفع تلقائي للخطوط (pay_auto_lines_*) ───────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("pay_auto_lines_")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const purchaseId = parseInt(interaction.customId.replace("pay_auto_lines_", ""), 10);
    const userId     = interaction.user.id;

    const purchase = await db.select().from(purchasesTable)
      .where(and(
        eq(purchasesTable.id, purchaseId),
        eq(purchasesTable.discordUserId, userId),
        eq(purchasesTable.status, "completed"),
      ))
      .then((r) => r[0]);

    if (!purchase || !purchase.discordRoomId) {
      await interaction.editReply({ content: "❌ مش لاقي المتجر ده." });
      return;
    }
    if (pendingAutoLinePurchases.has(userId)) {
      await interaction.editReply({ content: "⏳ عندك عملية تلقائي للخطوط لسه شغّالة." });
      return;
    }

    const alGross   = calcTransferAmount(AUTO_LINES_PRICE);
    const cmd       = `C <@${OWNER_ID}> ${alGross}`;
    const expiresAt = Date.now() + 10 * 60 * 1000;
    const timeoutId = setTimeout(() => { pendingAutoLinePurchases.delete(userId); }, 10 * 60 * 1000);

    pendingAutoLinePurchases.set(userId, {
      userId,
      username:      interaction.user.username,
      purchaseId,
      roomChannelId: purchase.discordRoomId,
      netPrice:      AUTO_LINES_PRICE,
      transferAmt:   alGross,
      guildId:       interaction.guildId ?? "",
      expiresAt,
      timeoutId,
    });

    // منشن في روم الأوامر مع أمر التحويل
    const alChannel = interaction.guild?.channels.cache.get(REACTIVATION_CHANNEL_ID) as TextChannel | undefined;
    if (alChannel) {
      await alChannel.send(
        `<@${userId}> لتفعيل تلقائي للخطوط حوّل المبلغ التالي:\n\`\`\`${cmd}\`\`\``
      ).catch(() => {});
    }

    const DIV_ALB = "ـﮩ════════════════ﮩـ";
    const gIALB   = interaction.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;
    const alPayEmbed = new EmbedBuilder()
      .setAuthor({ name: "Dragon $hop", iconURL: gIALB })
      .setTitle("✍️ تلقائي للخطوط")
      .setDescription(
        `<@${userId}>\n> ${DIV_ALB}\n\n` +
        `\`\`\`${cmd}\`\`\`\n` +
        `> ${MONEY_EMOJI} **${alGross.toLocaleString()}** كريدت\n` +
        `> ⏳ عندك **10 دقايق** تحول فيهم\n> ${DIV_ALB}`
      )
      .setColor(0xf39c12)
      .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: gIALB });

    await interaction.editReply({ embeds: [alPayEmbed] });
    return;
  }

  // ── زرار فتح مودال الاسم الجديد (open_store_rename_*) ───────────────────
  // NOTE: بيشتغل بعد تأكيد ProBot للدفع — بيفتح مودال لكتابة الاسم الجديد.
  //       الـ customId: open_store_rename_{userId}
  if (interaction.isButton() && interaction.customId.startsWith("open_store_rename_")) {
    const targetUserId = interaction.customId.replace("open_store_rename_", "");

    // بس اليوزر نفسه يقدر يضغط
    if (interaction.user.id !== targetUserId) {
      await interaction.reply({ content: "❌ الزرار ده مش ليك.", flags: MessageFlags.Ephemeral });
      return;
    }

    const pending = pendingStoreRenameReady.get(targetUserId);
    if (!pending) {
      await interaction.reply({ content: "❌ انتهت صلاحية الزرار أو العملية اتكنسلت.", flags: MessageFlags.Ephemeral });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(`modal_store_rename_${pending.purchaseId}`)
      .setTitle("تغيير اسم المتجر");

    const nameInput = new TextInputBuilder()
      .setCustomId("new_store_name")
      .setLabel("الاسم الجديد للمتجر")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("مثال: Dragon VIP")
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(50);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput));
    await interaction.showModal(modal);
    return;
  }

  // ── مودال تغيير اسم المتجر (modal_store_rename_*) ────────────────────────
  // NOTE: بيعمل setName للشانل بعد استبدال المسافات العادية بـ NO-BREAK SPACE (U+00A0)
  //       عشان Discord ما يحوّلهاش لـ `-`.
  //       الـ customId: modal_store_rename_{purchaseId}
  if (interaction.isModalSubmit() && interaction.customId.startsWith("modal_store_rename_")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const purchaseId = parseInt(interaction.customId.replace("modal_store_rename_", ""), 10);
    const userId     = interaction.user.id;

    // تحقق من الـ pending
    const pending = pendingStoreRenameReady.get(userId);
    if (!pending || pending.purchaseId !== purchaseId) {
      await interaction.editReply({ content: "❌ انتهت صلاحية هذه العملية. حاول من الأول." });
      return;
    }
    pendingStoreRenameReady.delete(userId);

    const rawName     = interaction.fields.getTextInputValue("new_store_name").trim();
    const channelName = formatChannelName(rawName); // استبدال spaces بـ U+00A0

    if (!rawName || rawName.length > 50) {
      await interaction.editReply({ content: "❌ الاسم مش صالح. اكتب اسم بين 1 و 50 حرف." });
      return;
    }

    // جيب الشانل من Discord
    const roomChannel = interaction.guild?.channels.cache.get(pending.roomChannelId) as import("discord.js").TextChannel | undefined;
    if (!roomChannel) {
      await interaction.editReply({ content: "❌ مش لاقي شانل المتجر. تواصل مع الأدمن." });
      return;
    }

    // غيّر اسم الشانل في Discord
    try {
      await roomChannel.setName(channelName, `تغيير اسم المتجر — طُلب من ${interaction.user.username}`);
    } catch (err) {
      logger.error({ err, channelName }, "Failed to rename store channel");
      await interaction.editReply({ content: "❌ فشل تغيير الاسم. تأكد إن البوت عنده صلاحية إدارة الشانلات." });
      return;
    }

    // حدّث الـ DB بالاسم الجديد
    await db.update(purchasesTable)
      .set({ customRoomName: rawName })
      .where(eq(purchasesTable.id, purchaseId));

    logger.info({ userId, purchaseId, rawName, channelName }, "Store channel renamed successfully");

    // أرسل تأكيد في الشانل المُعاد تسميته
    const DIV_D        = "ـﮩ════════════════ﮩـ";
    const guildIconURL = interaction.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;
    const doneFiles: AttachmentBuilder[] = [];

    const doneEmbed = new EmbedBuilder()
      .setAuthor({ name: "Dragon $hop", iconURL: guildIconURL })
      .setTitle(`${STAR_EMOJI} تم تغيير اسم المتجر!`)
      .setDescription(`<@${userId}> ${MONEY_EMOJI}\n> ${DIV_D}`)
      .setColor(0x00ff88)
      .addFields({
        name:  `${STAR_EMOJI} الاسم الجديد`,
        value: `> ${MONEY_EMOJI} **${rawName}**\n> ${DIV_D}`,
        inline: false,
      })
      .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: guildIconURL });

    if (fs.existsSync(DRAGON_BANNER_PATH)) {
      doneFiles.push(new AttachmentBuilder(DRAGON_BANNER_PATH, { name: "dragon_banner.webp" }));
      doneEmbed.setImage("attachment://dragon_banner.webp");
    }

    await roomChannel.send({ embeds: [doneEmbed], files: doneFiles });
    await interaction.editReply({ content: `✅ تم تغيير اسم المتجر لـ **${rawName}** بنجاح!` });
    return;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SLASH COMMANDS
  // ══════════════════════════════════════════════════════════════════════════
  if (interaction.isChatInputCommand()) {

  // ── /shop ─────────────────────────────────────────────────────────────────
  if (interaction.commandName === "shop") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await sendShopPanel(interaction.channel as TextChannel);
    await interaction.editReply({ content: "✅ تم فتح بانل الأسعار!" });
  }

  // ── /buy ──────────────────────────────────────────────────────────────────
  if (interaction.commandName === "buy") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    await sendBuyPanel(interaction.channel as TextChannel);
    await interaction.editReply({ content: "✅ تم فتح بانل الشراء!" });
  }

  // ── /myroom ───────────────────────────────────────────────────────────────
  if (interaction.commandName === "myroom") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const purchases = await db
      .select()
      .from(purchasesTable)
      .where(
        and(
          eq(purchasesTable.discordUserId, interaction.user.id),
          eq(purchasesTable.status, "completed")
        )
      );
    if (purchases.length === 0) {
      await interaction.editReply({ content: "❌ مش عندك أي روم حالياً." });
      return;
    }
    const list = purchases
      .map((p) =>
        `• ${p.customRoomName ?? p.roomName}${p.discordRoomId ? ` (<#${p.discordRoomId}>)` : ""}`
      )
      .join("\n");
    await interaction.editReply({ content: `**الرومات بتاعتك:**\n${list}` });
  }

  // ── /addroom ──────────────────────────────────────────────────────────────
  // NOTE: بيضيف روم جديد للـ DB — مش بيعدل STATIC_ROOMS في الكود.
  //       الرومات المضافة هنا مش بتتـ override من syncStaticRooms لأنها بتعمل match بالاسم + الكاتيجوري.
  if (interaction.commandName === "addroom") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.editReply({ content: "❌ محتاج صلاحية Administrator." });
      return;
    }
    const name          = interaction.options.getString("name", true);
    const category      = interaction.options.getString("category", true);
    const price         = interaction.options.getNumber("price", true);
    const decorations   = interaction.options.getString("decorations") ?? "";
    const categoryId    = interaction.options.getString("category_id") ?? null;
    const offersCount   = interaction.options.getInteger("offers") ?? 0;
    const hereCount     = interaction.options.getInteger("here") ?? 0;
    const everyoneCount = interaction.options.getInteger("everyone") ?? 0;

    const [newRoom] = await db
      .insert(roomsTable)
      .values({
        name, category,
        price: String(price),
        decorations,
        discordCategoryId: categoryId,
        offersCount, hereCount, everyoneCount,
      })
      .returning();

    await interaction.editReply({
      content:
        `✅ **تم إضافة الروم بنجاح!**\n\n` +
        `🆔 ID: \`${newRoom.id}\`\n📛 الاسم: ${name}\n📂 الكاتيجوري: ${category}\n` +
        `💰 السعر الصافي: ${Math.round(price)}\n💸 مبلغ التحويل: ${calcTransferAmount(price)}\n` +
        `🎨 الزخارف: ${decorations || "لا يوجد"}\n` +
        `📢 @offers: ${offersCount} | 📣 @here: ${hereCount} | 🔊 @everyone: ${everyoneCount}`,
    });
  }

  // ── /listrooms ────────────────────────────────────────────────────────────
  if (interaction.commandName === "listrooms") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.editReply({ content: "❌ محتاج صلاحية Administrator." });
      return;
    }
    const rooms = await db.select().from(roomsTable).orderBy(roomsTable.category);
    if (rooms.length === 0) {
      await interaction.editReply({ content: "📭 مفيش رومات. استخدم `/addroom`." });
      return;
    }
    const lines = rooms.map((r) =>
      `**#${r.id}** — ${r.name} (${r.category})\n` +
      `   💰 سعر صافي: ${Math.round(Number(r.price))} | تحويل: ${calcTransferAmount(Number(r.price))}\n` +
      `   🎨 ${r.decorations || "بدون زخارف"} | 📂 Cat ID: ${r.discordCategoryId ?? "—"}\n` +
      `   📢 ${r.offersCount} offers | 📣 ${r.hereCount} here | 🔊 ${r.everyoneCount} everyone`
    );
    await interaction.editReply({ content: `**📋 قائمة الرومات:**\n\n${lines.join("\n\n")}` });
  }

  // ── /storerules ───────────────────────────────────────────────────────────
  // NOTE: بيبعت نفس بانر + إمبيد "قوانين المتاجر" اللي بيتبعت تلقائي في روم
  //       العميل الجديد (نفس STORES_RULES_BANNER_PATH و rulesText).
  if (interaction.commandName === "storerules") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (
      interaction.user.id !== OWNER_ID &&
      !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    ) {
      await interaction.editReply({ content: "❌ محتاج صلاحية Administrator." });
      return;
    }

    const targetChannel = interaction.channel as TextChannel;
    const guildIconURLSR = interaction.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;
    const DIV_SR = "ـﮩ════════════════ﮩـ";

    const rulesTextSR =
      `> 1️⃣ ممنوع السب أو نشر أي نوع من المحتوى الغير لائق أو التلميح له\n` +
      `> ${DIV_SR}\n` +
      `> 2️⃣ ممنوع نشر أي نوع من اللينكات\n` +
      `> ${DIV_SR}\n` +
      `> 3️⃣ لا تحاول استخدام منشنات أكثر من رصيدك\n` +
      `> ${DIV_SR}\n` +
      `> 4️⃣ ممنوع الترويج للسيرفرات\n` +
      `> ${DIV_SR}\n` +
      `> 5️⃣ ممنوع الإسبام\n` +
      `> ${DIV_SR}`;

    const rulesEmbedSR = new EmbedBuilder()
      .setAuthor({ name: "Dragon $hop", iconURL: guildIconURLSR })
      .setTitle(`<a:C983:1526072321620574218> قوانين المتاجر`)
      .setDescription(`> ${DIV_SR}\n> اتبع القوانين دي عشان تضمن استمرار متجرك.\n> ${DIV_SR}`)
      .setThumbnail(guildIconURLSR ?? null)
      .addFields({ name: `<a:C983:1526072321620574218> القوانين`, value: rulesTextSR, inline: false })
      .setColor(0xf5c518)
      .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: guildIconURLSR });

    const rulesFilesSR: AttachmentBuilder[] = [];
    if (fs.existsSync(STORES_RULES_BANNER_PATH)) {
      rulesFilesSR.push(new AttachmentBuilder(STORES_RULES_BANNER_PATH, { name: "dragon_text_banner_stores_rules.webp" }));
      rulesEmbedSR.setImage("attachment://dragon_text_banner_stores_rules.webp");
    }
    await targetChannel.send({ embeds: [rulesEmbedSR], files: rulesFilesSR }).catch(() => {});

    // ── الخط (line) بيتبعت بعد الإمبيد، مش قبله ──────────────────────────
    if (fs.existsSync(STORES_RULES_LINE_PATH)) {
      await targetChannel.send({
        files: [new AttachmentBuilder(STORES_RULES_LINE_PATH, { name: "dragon_line_stores_rules.webp" })],
      }).catch(() => {});
    }

    await interaction.editReply({ content: "✅ تم إرسال إمبيد الخط وقوانين المتاجر." });
    return;
  }

  // ── /synccategories ───────────────────────────────────────────────────────
  if (interaction.commandName === "synccategories") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (
      interaction.user.id !== OWNER_ID &&
      !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    ) {
      await interaction.editReply({ content: "❌ محتاج صلاحية Administrator." });
      return;
    }
    const rooms = await db.select().from(roomsTable).where(eq(roomsTable.category, "المتاجر"));
    const lines = ROOM_CATEGORY_ORDER.map((name) => {
      const r = rooms.find((x) => x.name === name);
      if (!r) return `◻️ **${name}** → ❌ مش في الـ DB`;
      const status = r.discordCategoryId
        ? `✅ \`${r.discordCategoryId}\``
        : `❌ مش مربوط — استخدم \`/setcategoryid\``;
      return `${r.decorations || "◻️"} **${name}** (ID: ${r.id}) → ${status}`;
    });
    await interaction.editReply({
      content:
        `📋 **حالة ربط الرومات:**\n\n${lines.join("\n")}\n\n` +
        `💡 استخدم \`/setcategoryid\` لربط أي روم.`,
    });
  }

  // ── /setcategoryid ────────────────────────────────────────────────────────
  if (interaction.commandName === "setcategoryid") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.editReply({ content: "❌ محتاج صلاحية Administrator." });
      return;
    }
    const roomId = interaction.options.getInteger("room_id", true);
    const catId  = interaction.options.getString("category_id", true).trim();
    const [room] = await db.select().from(roomsTable).where(eq(roomsTable.id, roomId));
    if (!room) {
      await interaction.editReply({ content: `❌ مفيش روم بالـ ID ده (${roomId}).` });
      return;
    }
    await db.update(roomsTable).set({ discordCategoryId: catId }).where(eq(roomsTable.id, roomId));
    await interaction.editReply({
      content:
        `✅ **تم الربط بنجاح!**\n\n` +
        `📦 الروم: **${room.name}** (ID: ${roomId})\n` +
        `📂 الكاتيجوري: \`${catId}\``,
    });
  }

  // ── /deleteroom ───────────────────────────────────────────────────────────
  // NOTE: بيحذف الروم من DB بس — مش بيحذف الشانلات على Discord.
  if (interaction.commandName === "deleteroom") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.editReply({ content: "❌ محتاج صلاحية Administrator." });
      return;
    }
    const roomId    = interaction.options.getInteger("id", true);
    const [deleted] = await db.delete(roomsTable).where(eq(roomsTable.id, roomId)).returning();
    if (!deleted) {
      await interaction.editReply({ content: `❌ مفيش روم بالـ ID ده (${roomId}).` });
      return;
    }
    await interaction.editReply({ content: `✅ تم حذف الروم **${deleted.name}** (ID: ${roomId}).` });
  }

  // ── /givebalance ──────────────────────────────────────────────────────────
  // NOTE: بيضيف رصيد منشنات ليوزر معين ويديله رول mention-bypass تلقائياً.
  if (interaction.commandName === "givebalance") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.editReply({ content: "❌ محتاج صلاحية Administrator." });
      return;
    }
    const targetUser  = interaction.options.getUser("user", true);
    const mentionType = interaction.options.getString("type", true) as "offers" | "here" | "everyone" | "orders" | "auction";
    const amount      = interaction.options.getInteger("amount", true);
    const user        = await getOrCreateUser(targetUser.id, targetUser.username);
    const balKey      = `${mentionType}Balance` as "offersBalance" | "hereBalance" | "everyoneBalance" | "ordersBalance" | "auctionBalance";
    const newBalance  = user[balKey] + amount;

    await db
      .update(botUsersTable)
      .set({ [balKey]: newBalance })
      .where(eq(botUsersTable.discordUserId, targetUser.id));

    const mentionName =
      mentionType === "offers"  ? `<@&${OFFERS_ROLE_ID}>` :
      mentionType === "orders"  ? `<@&${ORDERS_ROLE_ID}>` :
      mentionType === "auction" ? `<@&${AUCTION_ROLE_ID}>` :
      mentionType === "here"    ? "@here"                 : "@everyone";

    // لو الرصيد أصبح موجود → دي رول "منشن مفعّل" عشان يقدر يمنشن
    if (newBalance > 0 && interaction.guild) {
      await grantMentionRole(interaction.guild, targetUser.id);
    }

    await interaction.editReply({
      content:
        `✅ تم إضافة **${amount}** منشن ${mentionName} لـ <@${targetUser.id}>\n` +
        `📊 رصيده الحالي: ${newBalance} منشن`,
    });
  }

  // ── /setaddonprice ────────────────────────────────────────────────────────
  // NOTE: بيعمل upsert في addon_prices table.
  //       لو الإضافة موجودة → يعدّل السعر والـ label.
  //       لو مش موجودة → يعمل row جديد.
  //       السعر بيتخزن كـ text (مش number) لتفادي مشاكل الدقة العشرية في DB.
  if (interaction.commandName === "setaddonprice") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.editReply({ content: "❌ محتاج صلاحية Administrator." });
      return;
    }
    const key   = interaction.options.getString("addon", true) as AddonKey;
    const price = interaction.options.getNumber("price", true);
    const addon = ADDONS.find((a) => a.key === key)!;

    if (!Number.isFinite(price) || price < 0) {
      await interaction.editReply({ content: "❌ السعر لازم يكون رقم صحيح موجب." });
      return;
    }

    const roundedPrice = Math.round(price);
    await db
      .insert(addonPricesTable)
      .values({ key, label: addon.label, price: String(roundedPrice) })
      .onConflictDoUpdate({
        target: addonPricesTable.key,
        set:    { label: addon.label, price: String(roundedPrice), updatedAt: new Date() },
      });

    await interaction.editReply({
      content:
        `✅ **تم تحديث السعر!**\n\n` +
        `📌 الإضافة: **${addon.label}**\n` +
        `💰 السعر الجديد: **${roundedPrice} كريدت**`,
    });
  }

  // ── /transferroom ─────────────────────────────────────────────────────────
  // NOTE: رسوم التحويل = 50% من سعر الروم الصافي.
  //       الزرار confirm_transfer بيظهر للأونر في نفس الشانل.
  //       الأونر لازم يتأكد إن العميل دفع الرسوم قبل ما يضغط تأكيد.
  if (interaction.commandName === "transferroom") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const targetUser  = interaction.options.getUser("user", true);
    const roomNameArg = interaction.options.getString("room", true);
    const userId      = interaction.user.id;

    const purchases = await db
      .select()
      .from(purchasesTable)
      .where(
        and(
          eq(purchasesTable.discordUserId, userId),
          eq(purchasesTable.status, "completed")
        )
      );

    const purchase = purchases.find((p) =>
      (p.customRoomName ?? p.roomName).toLowerCase().includes(roomNameArg.toLowerCase())
    );
    if (!purchase) {
      await interaction.editReply({ content: "❌ مش لاقي روم بالاسم ده عندك." });
      return;
    }

    const [room] = await db.select().from(roomsTable).where(eq(roomsTable.id, purchase.roomId));
    if (!room) { await interaction.editReply({ content: "❌ الروم مش موجود." }); return; }

    const transferFee = Number(room.price) * 0.5;

    const embed = new EmbedBuilder()
      .setTitle("🔄 تحويل ملكية روم")
      .setDescription(
        `<@${userId}> عايز يحول ملكية الروم **${purchase.customRoomName ?? purchase.roomName}** ` +
        `لـ <@${targetUser.id}>\n\n` +
        `**رسوم التحويل:** ${Math.round(transferFee)} (نص ثمن الروم الصافي)\n\n` +
        `⚠️ لازم تدفع رسوم التحويل للأونر عشان يتم التحويل.`
      )
      .setColor(0xffa500);

    const confirmBtn = new ButtonBuilder()
      .setCustomId(`confirm_transfer_${purchase.id}_${targetUser.id}`)
      .setLabel("✅ تأكيد الدفع وإتمام التحويل")
      .setStyle(ButtonStyle.Success);

    await (interaction.channel as TextChannel).send({
      content:    `<@${OWNER_ID}>`,
      embeds:     [embed],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(confirmBtn)],
    });

    await interaction.editReply({
      content: `✅ تم إرسال طلب تحويل الملكية. رسوم التحويل: ${Math.round(transferFee)}`,
    });
  }
  // ── /warnstore ────────────────────────────────────────────────────────────
  if (interaction.commandName === "warnstore") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (
      interaction.user.id !== OWNER_ID &&
      !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    ) {
      await interaction.editReply({ content: "❌ محتاج صلاحية Administrator." });
      return;
    }

    const targetUser = interaction.options.getUser("user", true);
    const reason     = interaction.options.getString("reason", true).trim();

    const purchase = await db.select().from(purchasesTable)
      .where(and(eq(purchasesTable.discordUserId, targetUser.id), eq(purchasesTable.status, "completed")))
      .then((rows) => rows.find((p) => p.discordRoomId));

    if (!purchase) {
      await interaction.editReply({ content: `❌ <@${targetUser.id}> مالوش متجر نشط.` });
      return;
    }

    const newWarningCount  = purchase.roomWarningCount + 1;
    const shouldDeactivate = newWarningCount >= 3 && !purchase.isRoomDeactivated;

    await db.update(purchasesTable)
      .set({
        roomWarningCount:  newWarningCount,
        isRoomDeactivated: purchase.isRoomDeactivated || shouldDeactivate,
      })
      .where(eq(purchasesTable.id, purchase.id));

    const DIV_W2  = "ـﮩ════════════════ﮩـ";
    const gIW2    = interaction.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;
    const roomCh  = interaction.guild?.channels.cache.get(purchase.discordRoomId!) as TextChannel | undefined;

    if (roomCh) {
      // ── إمبيد التحذير ──────────────────────────────────────────────────
      const warnEmbed = new EmbedBuilder()
        .setAuthor({ name: "Dragon $hop", iconURL: gIW2 })
        .setTitle("⚠️ تحذير للمتجر")
        .setDescription(
          `<@${targetUser.id}>\n> ${DIV_W2}\n\n` +
          `**تم تحذير متجرك**\n` +
          `**السبب:** ${reason}\n\n` +
          `\`\`\`لو متجرك وصل 3 تحذيرات سيتم الغاء تفعيل متجرك\`\`\`\n` +
          `لازاله التحذير يتم دفع رسوم قدرها **${WARNING_REMOVAL_PRICE.toLocaleString()}**\n\n` +
          `> **عدد التحذيرات:** ${newWarningCount} / 3\n` +
          `> ${DIV_W2}`
        )
        .setColor(0xff4444)
        .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: gIW2 });

      const warnFiles: AttachmentBuilder[] = [];
      if (fs.existsSync(DRAGON_TEXT_BANNER_PATH)) {
        warnFiles.push(new AttachmentBuilder(DRAGON_TEXT_BANNER_PATH, { name: "dragon_text_banner.webp" }));
        warnEmbed.setImage("attachment://dragon_text_banner.webp");
      }

      const removeWarnBtn = new ButtonBuilder()
        .setCustomId(`pay_remove_warning_${purchase.id}`)
        .setLabel(`💸 إزالة التحذير — ${calcTransferAmount(WARNING_REMOVAL_PRICE).toLocaleString()} كريدت`)
        .setStyle(ButtonStyle.Secondary);

      await roomCh.send({
        content:    `<@${targetUser.id}>`,
        embeds:     [warnEmbed],
        files:      warnFiles,
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(removeWarnBtn)],
      }).catch(() => {});

      // ── إيقاف الروم عند 3 تحذيرات ─────────────────────────────────────
      if (shouldDeactivate) {
        await roomCh.permissionOverwrites.edit(targetUser.id, {
          ViewChannel:     false,
          SendMessages:    false,
          MentionEveryone: false,
        }).catch(() => {});

        const [room]    = await db.select().from(roomsTable).where(eq(roomsTable.id, purchase.roomId));
        const reactNet  = room ? Math.ceil(Number(room.price) * 0.5) : 1_000_000;
        const reactGross = calcTransferAmount(reactNet);

        const deactEmbed = new EmbedBuilder()
          .setAuthor({ name: "Dragon $hop", iconURL: gIW2 })
          .setTitle(`<a:027:1499812826255200369> تم الغاء تفعيل متجرك`)
          .setDescription(
            `<@${targetUser.id}>\n> ${DIV_W2}\n\n` +
            `لاعاده التفعيل يرجى دفع الرسوم\n\n` +
            `\`\`\`رسوم التفعيل = 50% من قيمة المتجر\n` +
            `المبلغ المطلوب: ${reactGross.toLocaleString()} كريدت\`\`\`\n` +
            `> ${DIV_W2}`
          )
          .setColor(0x2b2d31)
          .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: gIW2 });

        const deactFiles: AttachmentBuilder[] = [];
        if (fs.existsSync(DRAGON_TEXT_BANNER_PATH)) {
          deactFiles.push(new AttachmentBuilder(DRAGON_TEXT_BANNER_PATH, { name: "dragon_text_banner.webp" }));
          deactEmbed.setImage("attachment://dragon_text_banner.webp");
        }

        const payReactBtn = new ButtonBuilder()
          .setCustomId(`pay_reactivate_room_${purchase.id}`)
          .setLabel(`💸 دفع رسوم التفعيل — ${reactGross.toLocaleString()} كريدت`)
          .setStyle(ButtonStyle.Danger);

        await roomCh.send({
          content:    `<@${targetUser.id}>`,
          embeds:     [deactEmbed],
          files:      deactFiles,
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(payReactBtn)],
        }).catch(() => {});
      }
    }

    await interaction.editReply({
      content: shouldDeactivate
        ? `✅ تم تحذير <@${targetUser.id}> وتم **إيقاف** متجره (3/3 تحذيرات).`
        : `✅ تم تحذير <@${targetUser.id}> — تحذير **${newWarningCount}/3**.`,
    });
  }

  // ── /stopautopublish ─────────────────────────────────────────────────────
  if (interaction.commandName === "stopautopublish") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (
      interaction.user.id !== OWNER_ID &&
      !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    ) {
      await interaction.editReply({ content: "❌ محتاج صلاحية Administrator." });
      return;
    }

    const targetUser = interaction.options.getUser("user", true);

    // لو لسه في مرحلة الدفع/الاختيار (مش بدأ ينشر فعلياً) — كنسل الطلب المعلّق كمان
    const pending = pendingAutoPublishes.get(targetUser.id);
    if (pending) {
      clearTimeout(pending.timeoutId);
      pendingAutoPublishes.delete(targetUser.id);
    }
    pendingAutoPublishReady.delete(targetUser.id);

    const guild  = interaction.guild!;
    const stopped = await stopAutoPublish(guild, targetUser.id);

    if (!stopped && !pending) {
      await interaction.editReply({ content: `❌ <@${targetUser.id}> مالوش نشر تلقائي شغّال أو معلّق حالياً.` });
      return;
    }

    await interaction.editReply({
      content: `✅ تم إيقاف النشر التلقائي الخاص بـ <@${targetUser.id}>.`,
    });
    return;
  }

  // ── /storestatus ─────────────────────────────────────────────────────────
  if (interaction.commandName === "storestatus") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (
      interaction.user.id !== OWNER_ID &&
      !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    ) {
      await interaction.editReply({ content: "❌ محتاج صلاحية Administrator." });
      return;
    }

    const targetUser = interaction.options.getUser("user", true);
    const action      = interaction.options.getString("action", true) as "activate" | "deactivate";

    const purchase = await db.select().from(purchasesTable)
      .where(and(eq(purchasesTable.discordUserId, targetUser.id), eq(purchasesTable.status, "completed")))
      .then((rows) => rows.find((p) => p.discordRoomId));

    if (!purchase) {
      await interaction.editReply({ content: `❌ <@${targetUser.id}> مالوش متجر نشط.` });
      return;
    }

    const wantDeactivate = action === "deactivate";
    if (purchase.isRoomDeactivated === wantDeactivate) {
      await interaction.editReply({
        content: wantDeactivate
          ? `⚠️ متجر <@${targetUser.id}> متوقف بالفعل.`
          : `⚠️ متجر <@${targetUser.id}> مفعّل بالفعل.`,
      });
      return;
    }

    // لو في عملية إعادة تفعيل معلّقة (المستخدم دافع أو بينتظر يدفع) الغيها — الأدمن بيتصرف يدوي بدون رسوم
    const pendingReact = pendingRoomReactivations.get(targetUser.id);
    if (pendingReact) {
      clearTimeout(pendingReact.timeoutId);
      pendingRoomReactivations.delete(targetUser.id);
    }

    await db.update(purchasesTable)
      .set({ isRoomDeactivated: wantDeactivate })
      .where(eq(purchasesTable.id, purchase.id));

    const roomCh = interaction.guild?.channels.cache.get(purchase.discordRoomId!) as TextChannel | undefined;
    if (roomCh) {
      await roomCh.permissionOverwrites.edit(targetUser.id, wantDeactivate
        ? { ViewChannel: false, SendMessages: false, MentionEveryone: false }
        : { ViewChannel: true,  SendMessages: true,  MentionEveryone: true  }
      ).catch(() => {});

      const DIV_SS = "ـﮩ════════════════ﮩـ";
      const gISS   = interaction.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;
      const statusEmbed = new EmbedBuilder()
        .setAuthor({ name: "Dragon $hop", iconURL: gISS })
        .setTitle(wantDeactivate ? "🚫 تم إلغاء تفعيل المتجر" : "✅ تم تفعيل المتجر")
        .setDescription(
          `<@${targetUser.id}>\n> ${DIV_SS}\n\n` +
          (wantDeactivate
            ? `تم إلغاء تفعيل متجرك من قِبل الإدارة **بدون رسوم**.`
            : `تم إعادة تفعيل متجرك من قِبل الإدارة **بدون رسوم**.`) +
          `\n> ${DIV_SS}`
        )
        .setColor(wantDeactivate ? 0x2b2d31 : 0x00ff88)
        .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: gISS });

      const statusFiles: AttachmentBuilder[] = [];
      if (fs.existsSync(DRAGON_TEXT_BANNER_PATH)) {
        statusFiles.push(new AttachmentBuilder(DRAGON_TEXT_BANNER_PATH, { name: "dragon_text_banner.webp" }));
        statusEmbed.setImage("attachment://dragon_text_banner.webp");
      }

      await roomCh.send({ content: `<@${targetUser.id}>`, embeds: [statusEmbed], files: statusFiles }).catch(() => {});
    }

    await interaction.editReply({
      content: wantDeactivate
        ? `✅ تم إلغاء تفعيل متجر <@${targetUser.id}> بدون رسوم.`
        : `✅ تم تفعيل متجر <@${targetUser.id}> بدون رسوم.`,
    });
    return;
  }

  // ── /addpromocode ────────────────────────────────────────────────────────
  if (interaction.commandName === "addpromocode") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (
      interaction.user.id !== OWNER_ID &&
      !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    ) {
      await interaction.editReply({ content: "❌ محتاج صلاحية Administrator." });
      return;
    }

    const rawCode = interaction.options.getString("code", true).trim().toUpperCase();
    const value   = interaction.options.getInteger("value", true);
    const uses    = interaction.options.getInteger("uses") ?? 1;

    if (!rawCode || /\s/.test(rawCode)) {
      await interaction.editReply({ content: "❌ الكود لازم يكون كلمة واحدة بدون فراغات." });
      return;
    }
    if (value <= 0) {
      await interaction.editReply({ content: "❌ القيمة لازم تكون أكبر من صفر." });
      return;
    }

    const [existing] = await db.select().from(promoCodesTable).where(eq(promoCodesTable.code, rawCode));
    if (existing) {
      await interaction.editReply({ content: `❌ الكود \`${rawCode}\` موجود بالفعل.` });
      return;
    }

    await db.insert(promoCodesTable).values({
      code:      rawCode,
      type:      "discount",
      value,
      maxUses:   Math.max(1, uses),
      createdBy: interaction.user.id,
    });

    await interaction.editReply({
      content:
        `✅ تم إنشاء كود الخصم \`${rawCode}\`\n` +
        `> 💰 القيمة: **${value.toLocaleString()}** كريدت\n` +
        `> 🔁 عدد مرات الاستخدام: **${Math.max(1, uses)}**`,
    });
    return;
  }

  // ── /removepromocode ─────────────────────────────────────────────────────
  if (interaction.commandName === "removepromocode") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (
      interaction.user.id !== OWNER_ID &&
      !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    ) {
      await interaction.editReply({ content: "❌ محتاج صلاحية Administrator." });
      return;
    }

    const rawCode = interaction.options.getString("code", true).trim().toUpperCase();
    const [promo] = await db.select().from(promoCodesTable).where(eq(promoCodesTable.code, rawCode));
    if (!promo) {
      await interaction.editReply({ content: `❌ الكود \`${rawCode}\` مش موجود.` });
      return;
    }

    await db.update(promoCodesTable).set({ isActive: false }).where(eq(promoCodesTable.id, promo.id));
    await interaction.editReply({ content: `✅ تم تعطيل الكود \`${rawCode}\`.` });
    return;
  }

  // ── /listpromocodes ───────────────────────────────────────────────────────
  if (interaction.commandName === "listpromocodes") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (
      interaction.user.id !== OWNER_ID &&
      !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    ) {
      await interaction.editReply({ content: "❌ محتاج صلاحية Administrator." });
      return;
    }

    const codes = await db.select().from(promoCodesTable).orderBy(promoCodesTable.id);
    if (codes.length === 0) {
      await interaction.editReply({ content: "📭 مفيش أكواد خصم لسه." });
      return;
    }

    const lines = codes.map((c) =>
      `${c.isActive ? "🟢" : "🔴"} \`${c.code}\` — 💰 ${c.value.toLocaleString()} | 🔁 ${c.usedCount}/${c.maxUses}`
    );
    await interaction.editReply({ content: lines.join("\n").slice(0, 1900) });
    return;
  }

  // ── /points (إضافة/خصم يدوي من أدمن) ────────────────────────────────────
  if (interaction.commandName === "points") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (
      interaction.user.id !== OWNER_ID &&
      !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    ) {
      await interaction.editReply({ content: "❌ محتاج صلاحية Administrator." });
      return;
    }

    const targetUser = interaction.options.getUser("user", true);
    const action      = interaction.options.getString("action", true) as "add" | "remove";
    const amount      = interaction.options.getInteger("amount", true);

    if (amount <= 0) {
      await interaction.editReply({ content: "❌ الكمية لازم تكون أكبر من صفر." });
      return;
    }

    const delta      = action === "add" ? amount : -amount;
    const newBalance = await addUserPoints(targetUser.id, delta);

    await interaction.editReply({
      content:
        (action === "add"
          ? `✅ تم إضافة **${amount.toLocaleString()}** نقطة لـ <@${targetUser.id}>.`
          : `✅ تم خصم **${amount.toLocaleString()}** نقطة من <@${targetUser.id}>.`) +
        `\n💠 رصيده الحالي: **${newBalance.toLocaleString()}** نقطة.`,
    });
    return;
  }

  // ── /mypoints ─────────────────────────────────────────────────────────────
  if (interaction.commandName === "mypoints") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const balance = await getUserPoints(interaction.user.id);
    await interaction.editReply({ content: `💠 رصيدك من النقاط: **${balance.toLocaleString()}** نقطة.` });
    return;
  }

  } // end isChatInputCommand block

  // ── StringSelectMenu: اختيار مدة النشر التلقائي (autopub_duration_*) ───────
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("autopub_duration_")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const userId  = interaction.customId.replace("autopub_duration_", "");
    const days    = parseInt(interaction.values[0]!, 10);
    const netPrice    = AUTO_PUBLISH_PRICE_PER_DAY * days;
    const transferAmt = calcTransferAmount(netPrice);
    const cmd         = `C <@${OWNER_ID}> ${transferAmt}`;
    const expiresAt   = Date.now() + 10 * 60 * 1000; // 10 دقايق

    // تحقق من وجود متجر
    const userStore = await db.select().from(purchasesTable)
      .where(and(eq(purchasesTable.discordUserId, userId), eq(purchasesTable.status, "completed")))
      .then((rows) => rows.find((p) => p.discordRoomId));
    if (!userStore) {
      await interaction.editReply({ content: "❌ مش لاقي متجرك." });
      return;
    }

    if (pendingAutoPublishes.has(userId)) clearTimeout(pendingAutoPublishes.get(userId)!.timeoutId);
    const timeoutId = setTimeout(() => {
      pendingAutoPublishes.delete(userId);
    }, 10 * 60 * 1000);

    pendingAutoPublishes.set(userId, {
      userId,
      username:        interaction.user.username,
      storePurchaseId: userStore.id,
      roomChannelId:   userStore.discordRoomId ?? "",
      ticketChannelId: interaction.channelId,
      days,
      netPrice,
      transferAmt,
      guildId:   interaction.guildId ?? "",
      expiresAt,
      timeoutId,
    });

    const DIV_DS  = "ـﮩ════════════════ﮩـ";
    const gIDS    = interaction.guild?.iconURL({ extension: "png", size: 256 }) ?? undefined;
    const dsEmbed = new EmbedBuilder()
      .setAuthor({ name: "Dragon $hop", iconURL: gIDS })
      .setTitle(`📢 النشر التلقائي — ${days} ${days === 1 ? "يوم" : "أيام"}`)
      .setDescription(`<@${userId}> ${MONEY_EMOJI}\n> ${DIV_DS}`)
      .setColor(0x9b59b6)
      .addFields(
        { name: `${STAR_EMOJI} المدة`,          value: `> ⏱ **${days}** ${days === 1 ? "يوم" : "أيام"} (نشر كل 6 ساعات)\n> ${DIV_DS}`, inline: false },
        { name: `${STAR_EMOJI} المبلغ المطلوب`, value: `> ${MONEY_EMOJI} **${transferAmt.toLocaleString()}** كريدت\n> ${DIV_DS}`, inline: false },
        { name: `${STAR_EMOJI} أمر التحويل`,    value: `\`\`\`${cmd}\`\`\`\n> ${DIV_DS}`, inline: false },
        { name: `${STAR_EMOJI} المهلة`,          value: `> ⏳ عندك **10 دقايق** تحول فيهم\n> ${DIV_DS}`, inline: false },
      )
      .setFooter({ text: "Dev By : mostafa9321 & ahmed_.p", iconURL: gIDS });

    await interaction.editReply({ embeds: [dsEmbed] });
    return;
  }

  // ── زرار YES — استخدام رصيد المنشنات مع النشر ─────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("autopub_mention_yes_")) {
    // format: autopub_mention_yes_{userId}_{purchaseId}_{days}_{roomChannelId}
    const parts         = interaction.customId.replace("autopub_mention_yes_", "").split("_");
    const userId        = parts[0]!;
    const purchaseId    = parseInt(parts[1]!, 10);
    const days          = parseInt(parts[2]!, 10);
    const roomChannelId = parts.slice(3).join("_");

    if (interaction.user.id !== userId) {
      await interaction.reply({ content: "❌ الزرار ده مش ليك.", flags: MessageFlags.Ephemeral });
      return;
    }

    // تأكد إن ده لسه تفويض صالح من دفعة حديثة — يمنع إعادة استخدام زرار قديم بدون دفع جديد
    const ready = pendingAutoPublishReady.get(userId);
    if (!ready || ready.storePurchaseId !== purchaseId) {
      await interaction.reply({ content: "❌ انتهت صلاحية هذا الزرار أو العملية اتستخدمت قبل كده.", flags: MessageFlags.Ephemeral });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(`modal_autopub_yes_${userId}_${purchaseId}_${days}_${roomChannelId}`)
      .setTitle("📢 تفاصيل النشر التلقائي");

    const mentionTypeInput = new TextInputBuilder()
      .setCustomId("mention_type")
      .setLabel("نوع المنشن (here/everyone/offers/orders/auction)")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("here")
      .setRequired(true)
      .setMaxLength(10);

    const mentionCountInput = new TextInputBuilder()
      .setCustomId("mention_count")
      .setLabel("كام منشن كل نشرة؟")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("1")
      .setRequired(true)
      .setMaxLength(3);

    const messageInput = new TextInputBuilder()
      .setCustomId("message")
      .setLabel("رسالة الإعلان")
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder("اكتب الإعلان هنا...")
      .setRequired(true)
      .setMaxLength(1800);

    const imageInput = new TextInputBuilder()
      .setCustomId("image_url")
      .setLabel("لينك الصورة (اختياري)")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("https://...")
      .setRequired(false)
      .setMaxLength(500);

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(mentionTypeInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(mentionCountInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(messageInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(imageInput),
    );

    await interaction.showModal(modal);
    return;
  }

  // ── زرار NO — بدون منشنات، مودال مباشر ───────────────────────────────────
  if (interaction.isButton() && interaction.customId.startsWith("autopub_mention_no_")) {
    const parts         = interaction.customId.replace("autopub_mention_no_", "").split("_");
    const userId        = parts[0]!;
    const purchaseId    = parseInt(parts[1]!, 10);
    const days          = parseInt(parts[2]!, 10);
    const roomChannelId = parts.slice(3).join("_");

    if (interaction.user.id !== userId) {
      await interaction.reply({ content: "❌ الزرار ده مش ليك.", flags: MessageFlags.Ephemeral });
      return;
    }

    // تأكد إن ده لسه تفويض صالح من دفعة حديثة — يمنع إعادة استخدام زرار قديم بدون دفع جديد
    const ready = pendingAutoPublishReady.get(userId);
    if (!ready || ready.storePurchaseId !== purchaseId) {
      await interaction.reply({ content: "❌ انتهت صلاحية هذا الزرار أو العملية اتستخدمت قبل كده.", flags: MessageFlags.Ephemeral });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(`modal_autopub_no_${userId}_${purchaseId}_${days}_${roomChannelId}`)
      .setTitle("📢 رسالة النشر التلقائي");

    const messageInput = new TextInputBuilder()
      .setCustomId("message")
      .setLabel("رسالة الإعلان")
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder("اكتب الإعلان هنا...")
      .setRequired(true)
      .setMaxLength(1800);

    const imageInput = new TextInputBuilder()
      .setCustomId("image_url")
      .setLabel("لينك الصورة (اختياري)")
      .setStyle(TextInputStyle.Short)
      .setPlaceholder("https://...")
      .setRequired(false)
      .setMaxLength(500);

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(messageInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(imageInput),
    );

    await interaction.showModal(modal);
    return;
  }

  // ── مودال النشر التلقائي مع منشنات (modal_autopub_yes_*) ─────────────────
  if (interaction.isModalSubmit() && interaction.customId.startsWith("modal_autopub_yes_")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    // format: modal_autopub_yes_{userId}_{purchaseId}_{days}_{roomChannelId}
    const rest             = interaction.customId.replace("modal_autopub_yes_", "");
    const firstUnderscore  = rest.indexOf("_");
    const secondUnderscore = rest.indexOf("_", firstUnderscore + 1);
    const thirdUnderscore  = rest.indexOf("_", secondUnderscore + 1);
    const userId           = rest.slice(0, firstUnderscore);
    const purchaseId       = parseInt(rest.slice(firstUnderscore + 1, secondUnderscore), 10);
    const days             = parseInt(rest.slice(secondUnderscore + 1, thirdUnderscore), 10);
    const roomChannelId    = rest.slice(thirdUnderscore + 1);

    // تأكد إن التفويض لسه صالح ولسه ما اتستخدمش، وبعدين استهلكه
    const ready = pendingAutoPublishReady.get(userId);
    if (!ready || ready.storePurchaseId !== purchaseId) {
      await interaction.editReply({ content: "❌ انتهت صلاحية هذه العملية. حاول من الأول." });
      return;
    }
    pendingAutoPublishReady.delete(userId);

    const rawMentionType  = interaction.fields.getTextInputValue("mention_type").trim().toLowerCase();
    const rawMentionCount = interaction.fields.getTextInputValue("mention_count").trim();
    const msgContent      = interaction.fields.getTextInputValue("message").trim();
    const imageUrl        = interaction.fields.getTextInputValue("image_url").trim() || undefined;

    // تحقق من نوع المنشن
    const validTypes = ["here", "everyone", "offers", "orders", "auction"] as const;
    const mentionType = validTypes.find((t) => t === rawMentionType);
    if (!mentionType) {
      await interaction.editReply({ content: `❌ نوع المنشن غلط — لازم يكون: here / everyone / offers / orders / auction` });
      return;
    }

    const mentionsPerPost = parseInt(rawMentionCount, 10);
    if (isNaN(mentionsPerPost) || mentionsPerPost < 1 || mentionsPerPost > 50) {
      await interaction.editReply({ content: "❌ عدد المنشنات لازم يكون بين 1 و50." });
      return;
    }

    // تحقق من الرصيد
    const user   = await getOrCreateUser(userId, interaction.user.username);
    const balKey =
      mentionType === "here"     ? "hereBalance" :
      mentionType === "everyone" ? "everyoneBalance" :
      mentionType === "orders"   ? "ordersBalance" :
      mentionType === "auction"  ? "auctionBalance" : "offersBalance";
    if (user[balKey] < mentionsPerPost) {
      await interaction.editReply({
        content: `❌ رصيدك من @${mentionType} (${user[balKey]}) أقل من المطلوب كل نشرة (${mentionsPerPost}).`,
      });
      return;
    }

    // تحقق من المحتوى
    const hasBadWord  = findBadWord(msgContent);
    const hasLink     = /https?:\/\/|www\./i.test(msgContent);
    const hasMention  = /@(everyone|here)|<@[&!]?\d+>/.test(msgContent);
    if (hasBadWord) {
      await interaction.editReply({ content: `❌ الرسالة تحتوي على كلمة محظورة.` });
      return;
    }
    if (hasLink) {
      await interaction.editReply({ content: `❌ ممنوع نشر لينكات في الإعلان.` });
      return;
    }
    if (hasMention) {
      await interaction.editReply({ content: `❌ ممنوع وضع منشنات في نص الرسالة — استخدم زرار المنشنات الخاص.` });
      return;
    }

    const guild = interaction.guild!;
    await startAutoPublish(guild, {
      userId,
      username:        interaction.user.username,
      roomChannelId,
      message:         msgContent,
      imageUrl,
      mentionType,
      mentionsPerPost,
      durationMs:      days * 24 * 60 * 60 * 1000,
    });

    await interaction.editReply({
      content: `✅ بدأ النشر التلقائي في متجرك! كل 6 ساعات لمدة **${days}** ${days === 1 ? "يوم" : "أيام"} مع منشن @${mentionType} (${mentionsPerPost} كل نشرة).`,
    });
    return;
  }

  // ── مودال النشر التلقائي بدون منشنات (modal_autopub_no_*) ────────────────
  if (interaction.isModalSubmit() && interaction.customId.startsWith("modal_autopub_no_")) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    // format: modal_autopub_no_{userId}_{purchaseId}_{days}_{roomChannelId}
    const rest             = interaction.customId.replace("modal_autopub_no_", "");
    const firstUnderscore  = rest.indexOf("_");
    const secondUnderscore = rest.indexOf("_", firstUnderscore + 1);
    const thirdUnderscore  = rest.indexOf("_", secondUnderscore + 1);
    const userId           = rest.slice(0, firstUnderscore);
    const purchaseId       = parseInt(rest.slice(firstUnderscore + 1, secondUnderscore), 10);
    const days             = parseInt(rest.slice(secondUnderscore + 1, thirdUnderscore), 10);
    const roomChannelId    = rest.slice(thirdUnderscore + 1);

    // تأكد إن التفويض لسه صالح ولسه ما اتستخدمش، وبعدين استهلكه
    const ready = pendingAutoPublishReady.get(userId);
    if (!ready || ready.storePurchaseId !== purchaseId) {
      await interaction.editReply({ content: "❌ انتهت صلاحية هذه العملية. حاول من الأول." });
      return;
    }
    pendingAutoPublishReady.delete(userId);

    const msgContent = interaction.fields.getTextInputValue("message").trim();
    const imageUrl   = interaction.fields.getTextInputValue("image_url").trim() || undefined;

    // تحقق من المحتوى
    const hasBadWord = findBadWord(msgContent);
    const hasLink    = /https?:\/\/|www\./i.test(msgContent);
    const hasMention = /@(everyone|here)|<@[&!]?\d+>/.test(msgContent);
    if (hasBadWord) {
      await interaction.editReply({ content: `❌ الرسالة تحتوي على كلمة محظورة.` });
      return;
    }
    if (hasLink) {
      await interaction.editReply({ content: `❌ ممنوع نشر لينكات في الرساله.` });
      return;
    }
    if (hasMention) {
      await interaction.editReply({ content: `❌ ممنوع وضع منشنات في نص الرسالة.` });
      return;
    }

    const guild = interaction.guild!;
    await startAutoPublish(guild, {
      userId,
      username:        interaction.user.username,
      roomChannelId,
      message:         msgContent,
      imageUrl,
      mentionsPerPost: 0,
      durationMs:      days * 24 * 60 * 60 * 1000,
    });

    await interaction.editReply({
      content: `✅ بدأ النشر التلقائي في متجرك! كل 6 ساعات لمدة **${days}** ${days === 1 ? "يوم" : "أيام"}.`,
    });
    return;
  }

  } catch (err) {
    logger.error({ err, interactionId: interaction.id }, "Unhandled error in InteractionCreate");
    // حاول تبلّغ المستخدم لو الـ interaction لسه ما اتردّش
    try {
      if (interaction.isRepliable()) {
        const replyMethod = interaction.deferred || interaction.replied
          ? interaction.editReply.bind(interaction)
          : interaction.reply.bind(interaction);
        await replyMethod({ content: "❌ حصل خطأ غير متوقع. حاول تاني أو تواصل مع الأدمن." });
      }
    } catch { /* تجاهل أخطاء الـ fallback reply */ }
  }
});

// ══════════════════════════════════════════════════════════════════════════════
//  startBot — نقطة الدخول
//  NOTE: بيتنادى من index.ts عند بدء الـ server.
//        المتغيرات المطلوبة بتتتحقق منها عند import البوت — لو مش موجودة بيرمي error.
// ══════════════════════════════════════════════════════════════════════════════
export function startBot(): void {
  client.login(TOKEN).catch((err) => {
    logger.error({ err }, "Failed to login to Discord — exiting");
    process.exit(1);
  });
}
