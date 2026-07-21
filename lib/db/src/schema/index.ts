/**
 * ╔══════════════════════════════════════════════════════════════════════╗
 * ║                     Dragon Shop — DB Schema                         ║
 * ║                                                                      ║
 * ║  الجداول:                                                             ║
 * ║  • rooms          — أنواع الرومات المتاحة للبيع                      ║
 * ║  • purchases      — سجل الشراء ومراحل العملية                        ║
 * ║  • bot_users      — بيانات اليوزرز (رصيد منشنات / حظر / تحذيرات)    ║
 * ║  • addon_prices   — أسعار الإضافات الـ 21                           ║
 * ║  • warnings       — سجل التحذيرات التفصيلي                          ║
 * ║                                                                      ║
 * ║  بعد أي تعديل في الـ schema:                                         ║
 * ║    cd lib/db && pnpm run push                                        ║
 * ║  (أو: drizzle-kit push --force لو في conflict)                       ║
 * ╚══════════════════════════════════════════════════════════════════════╝
 */

import { pgTable, text, serial, integer, boolean, timestamp, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ══════════════════════════════════════════════════════════════════════════════
//  rooms — أنواع الرومات
//  NOTE: الرومات الثابتة (STATIC_ROOMS في bot.ts) بتتـ sync لهذا الجدول
//        كل ما البوت يشتغل. الرومات المضافة بـ /addroom كمان بتتحفظ هنا.
//
//  price: بيتخزن كـ text مش number عشان نتجنب مشاكل الـ floating point.
//         استخدم Number(room.price) عند القراءة.
//  discordCategoryId: الـ ID بتاع الكاتيجوري في Discord.
//         null = مش مربوط بكاتيجوري (الروم بيتعمل بدون parent).
// ══════════════════════════════════════════════════════════════════════════════
export const roomsTable = pgTable("rooms", {
  id:                serial("id").primaryKey(),
  name:              text("name").notNull(),
  category:          text("category").notNull(),
  price:             text("price").notNull().default("0"),           // سعر صافي بالكريدت
  decorations:       text("decorations").notNull().default(""),     // إيموجي الزخرفة
  offersCount:       integer("offers_count").notNull().default(0),  // منشنات @offers المرفقة
  hereCount:         integer("here_count").notNull().default(0),    // منشنات @here المرفقة
  everyoneCount:     integer("everyone_count").notNull().default(0),// منشنات @everyone المرفقة
  ordersCount:       integer("orders_count").notNull().default(0),  // منشنات @طلبيات المرفقة
  auctionCount:      integer("auction_count").notNull().default(0), // منشنات @مزاد المرفقة
  discordCategoryId: text("discord_category_id"),                   // Discord Category ID
  createdAt:         timestamp("created_at").defaultNow(),
});

export const insertRoomSchema = createInsertSchema(roomsTable).omit({ id: true, createdAt: true });
export type InsertRoom = z.infer<typeof insertRoomSchema>;
export type Room = typeof roomsTable.$inferSelect;

// ══════════════════════════════════════════════════════════════════════════════
//  purchases — سجل الشراء
//  NOTE: دورة حياة الـ status:
//    pending → awaiting_room_name → awaiting_room_creation → completed
//                                                           → cancelled (لو التذكرة اتغلقت)
//
//  totalPrice: بيتحسب مع عمولة ProBot (5%) وقت إنشاء التذكرة.
//  transferCommand: الأمر الكامل اللي العميل يبعته لـ ProBot (مثال: "C @owner 1053").
//  ticketChannelId: Discord channel ID للتذكرة (بيتحذف بعد الإغلاق).
//  discordRoomId: Discord channel ID للروم النهائي بعد الإنشاء.
// ══════════════════════════════════════════════════════════════════════════════
export const purchasesTable = pgTable("purchases", {
  id:              serial("id").primaryKey(),
  discordUserId:   text("discord_user_id").notNull(),
  discordUsername: text("discord_username").notNull(),
  roomId:          integer("room_id").notNull(),
  roomName:        text("room_name").notNull(),
  customRoomName:  text("custom_room_name"),               // الاسم المخصص بعد التنسيق
  totalPrice:      text("total_price").notNull().default("0"), // المبلغ مع العمولة
  transferCommand: text("transfer_command"),               // أمر ProBot الكامل
  status:          text("status").notNull().default("pending"),
  ticketChannelId: text("ticket_channel_id"),
  discordRoomId:    text("discord_room_id"),
  roomWarningCount:     integer("room_warning_count").notNull().default(0),
  isRoomDeactivated:    boolean("is_room_deactivated").notNull().default(false),
  partnerDiscordUserId: text("partner_discord_user_id"),                        // Discord ID شريك الروم (واحد بس)
  appliedPromoCode:     text("applied_promo_code"),        // كود الخصم المطبّق على التذكرة دي (لو فيه)
  discountAmount:       integer("discount_amount").notNull().default(0), // قيمة الخصم الصافية المطبّقة
  createdAt:        timestamp("created_at").defaultNow(),
  updatedAt:        timestamp("updated_at").defaultNow(),
});

export const insertPurchaseSchema = createInsertSchema(purchasesTable).omit({
  id: true, createdAt: true, updatedAt: true,
});
export type InsertPurchase = z.infer<typeof insertPurchaseSchema>;
export type Purchase = typeof purchasesTable.$inferSelect;

// ══════════════════════════════════════════════════════════════════════════════
//  bot_users — بيانات اليوزرز
//  NOTE: بيتعمل record تلقائياً لكل يوزر تفاعل مع البوت (getOrCreateUser).
//
//  الرصيد (offersBalance / hereBalance / everyoneBalance):
//    بينزل بـ 1 كل ما اليوزر يستخدم المنشن في روم عنده.
//    لو الرصيد = 0 في كل الأنواع → البوت بيشيل رول mention-bypass.
//
//  الحظر:
//    isBanned = true + bannedUntil = null → حظر دائم (يدوي)
//    isBanned = true + bannedUntil = date → حظر مؤقت (تلقائي بعد 3 تحذيرات)
//    البوت بيرفع الحظر المؤقت تلقائياً لما تاريخه يخلص.
// ══════════════════════════════════════════════════════════════════════════════
export const botUsersTable = pgTable("bot_users", {
  id:              serial("id").primaryKey(),
  discordUserId:   text("discord_user_id").notNull().unique(),
  discordUsername: text("discord_username").notNull(),
  offersBalance:   integer("offers_balance").notNull().default(0),
  hereBalance:     integer("here_balance").notNull().default(0),
  everyoneBalance: integer("everyone_balance").notNull().default(0),
  ordersBalance:   integer("orders_balance").notNull().default(0),
  auctionBalance:  integer("auction_balance").notNull().default(0),
  isBanned:        boolean("is_banned").notNull().default(false),
  bannedUntil:     timestamp("banned_until"),               // null = دائم أو مش محظور
  warningCount:    integer("warning_count").notNull().default(0),
  createdAt:       timestamp("created_at").defaultNow(),
});

export const insertBotUserSchema = createInsertSchema(botUsersTable).omit({
  id: true, createdAt: true,
});
export type InsertBotUser = z.infer<typeof insertBotUserSchema>;
export type BotUser = typeof botUsersTable.$inferSelect;

// ══════════════════════════════════════════════════════════════════════════════
//  addon_prices — أسعار الإضافات
//  NOTE: كل إضافة من الـ 21 موجودة في ADDONS array في bot.ts ليها key فريد.
//        السعر بيتخزن كـ text (راجع ملاحظة price في rooms).
//        لو الإضافة مش موجودة في الجدول → السعر "غير محدد" في الـ embed.
//
//  عشان تضيف/تعدل سعر إضافة: استخدم /setaddonprice من Discord.
//  عشان تشوف كل الأسعار: SELECT * FROM addon_prices ORDER BY key;
// ══════════════════════════════════════════════════════════════════════════════
export const addonPricesTable = pgTable("addon_prices", {
  id:        serial("id").primaryKey(),
  key:       text("key").notNull().unique(), // مفتاح الإضافة (من ADDONS array في bot.ts)
  label:     text("label").notNull(),        // الاسم العربي (للـ reference)
  price:     text("price").notNull().default("0"), // السعر بالكريدت
  updatedAt: timestamp("updated_at").defaultNow(), // آخر تعديل
});

export type AddonPrice = typeof addonPricesTable.$inferSelect;

// ══════════════════════════════════════════════════════════════════════════════
//  warnings — سجل التحذيرات
//  NOTE: كل تحذير بيتسجل كـ row منفصل.
//        عدد الـ rows اللي عندها نفس discordUserId = عدد تحذيراته.
//        عند 3 تحذيرات → حظر 4 أيام تلقائي.
//        التحذيرات مش بتتمسح لو الحظر انتهى — بتتراكم.
//
//  messageContent: الرسالة الأصلية اللي سببت التحذير (للـ logging).
// ══════════════════════════════════════════════════════════════════════════════
export const warningsTable = pgTable("warnings", {
  id:             serial("id").primaryKey(),
  discordUserId:  text("discord_user_id").notNull(),
  discordUsername: text("discord_username").notNull(),
  reason:         text("reason").notNull(),          // سبب التحذير
  messageContent: text("message_content"),           // محتوى الرسالة (اختياري)
  createdAt:      timestamp("created_at").defaultNow(),
});

export const insertWarningSchema = createInsertSchema(warningsTable).omit({
  id: true, createdAt: true,
});
export type InsertWarning = z.infer<typeof insertWarningSchema>;
export type Warning = typeof warningsTable.$inferSelect;

// ══════════════════════════════════════════════════════════════════════════════
//  auction_schedules — حجوزات المزاد
//  NOTE: كل حجز بيمر بالحالات:
//    pending_payment → awaiting_item → awaiting_payment_method → scheduled
//                                                                → active → completed
//                                                                → cancelled
//
//  scheduledDate/scheduledHour/roomChannelId: بتفضل null لحد ما البوت يحدد
//    ميعاد تلقائي بعد ما اليوزر يجاوب على سؤالي "المزاد على ايه" و"الدفع ازاي".
//  delayMinutes: تأجيل تراكمي (بالدقايق) لو الروم لسه مشغول بمزاد سابق وقت الميعاد.
//  reminded: true بعد ما البوت يبعت تذكير قبل نص ساعة (يمنع تكرار التذكير).
//  itemDescription: إجابة السؤال الإجباري "المزاد على ايه؟".
//  paymentMethod: إجابة السؤال الاختياري "الدفع ازاي؟" (ممكن تكون null لو تخطى).
//  roomChannelId: ID شانل المزاد في Discord (من الـ 3 رومات الثابتة).
//  winnerUserId: بيتعبى لما الأدمن يكتب "مبروك @الفايز" — مفيش winningBid
//    لأن المزايدة بقت يدوية بالكامل تحت إدارة الأدمن، والبوت مالوش دعوة بالأرقام.
// ══════════════════════════════════════════════════════════════════════════════
export const auctionSchedulesTable = pgTable("auction_schedules", {
  id:               serial("id").primaryKey(),
  discordUserId:    text("discord_user_id").notNull(),
  discordUsername:  text("discord_username").notNull(),
  auctionType:      text("auction_type").notNull(),       // 'everyone' | 'here' | 'offers'
  scheduledDate:    text("scheduled_date"),                // YYYY-MM-DD توقيت القاهرة — null لحد ما يتحدد
  scheduledHour:    integer("scheduled_hour"),              // 0–23 توقيت القاهرة — null لحد ما يتحدد
  delayMinutes:     integer("delay_minutes").notNull().default(0),
  reminded:         boolean("reminded").notNull().default(false),
  status:           text("status").notNull().default("pending_payment"),
  roomChannelId:    text("room_channel_id"),
  ticketChannelId:  text("ticket_channel_id"),
  totalPrice:       text("total_price"),
  itemDescription:  text("item_description"),
  paymentMethod:    text("payment_method"),
  winnerUserId:     text("winner_user_id"),
  winningBid:       integer("winning_bid"),
  /**
   * لو مش null → المزاد ده "إعلان بيع" (mention-only) مش مزاد مزايدة.
   * بيتخزن السعر اللي صاحب المزاد حاطه.
   */
  sellingPrice:     text("selling_price"),
  createdAt:        timestamp("created_at").defaultNow(),
});
export type AuctionSchedule = typeof auctionSchedulesTable.$inferSelect;

// ══════════════════════════════════════════════════════════════════════════════
//  promo_codes — أكواد البروموشن
//  NOTE: نوعين مخطط لهم (راجع notes/promo-codes.md للتفاصيل الكاملة):
//    • "discount"  (شغال دلوقتي) — كود بقيمة كريدت معينة، بيتطبق على سعر
//      المتجر عند الشراء. لو قيمة الكود أكبر من سعر المتجر، الفرق بيتحول
//      لنقاط (points) في حساب المستخدم.
//    • "free_week" (لسه هيتعمل) — كود بيدي أسبوع مجاني في نوع متجر معين،
//      بيتدي للناس اللي بتجيب إنفايتس وعندها متجر.
//
//  value: القيمة الصافية بالكريدت (بدون عمولة ProBot) — دايماً بتتفسر
//         حسب "type". للـ discount هي قيمة الخصم الكاملة.
//  maxUses / usedCount: بيتحكموا في عدد مرات استخدام الكود (افتراضي مرة واحدة).
//  isActive: بيتقفل تلقائي لما usedCount توصل maxUses، أو يدوي بالأدمن.
// ══════════════════════════════════════════════════════════════════════════════
export const promoCodesTable = pgTable("promo_codes", {
  id:            serial("id").primaryKey(),
  code:          text("code").notNull().unique(),        // بيتخزن دايماً UPPERCASE
  type:          text("type").notNull().default("discount"), // 'discount' | 'free_week' (مش متفعل لسه)
  value:         integer("value").notNull(),              // القيمة الصافية بالكريدت
  roomTypeId:    integer("room_type_id"),                 // للاستخدام المستقبلي مع free_week (تحديد نوع متجر معين)
  maxUses:       integer("max_uses").notNull().default(1),
  usedCount:     integer("used_count").notNull().default(0),
  isActive:      boolean("is_active").notNull().default(true),
  createdBy:     text("created_by").notNull(),             // Discord ID للأدمن اللي عمل الكود
  createdAt:     timestamp("created_at").defaultNow(),
});
export const insertPromoCodeSchema = createInsertSchema(promoCodesTable).omit({
  id: true, createdAt: true, usedCount: true,
});
export type InsertPromoCode = z.infer<typeof insertPromoCodeSchema>;
export type PromoCode = typeof promoCodesTable.$inferSelect;

// ══════════════════════════════════════════════════════════════════════════════
//  promo_redemptions — سجل استخدام الأكواد
//  NOTE: بيتسجل صف لكل مرة كود اتستخدم فيها، عشان نمنع نفس اليوزر يستخدم
//        نفس الكود مرتين على نفس التذكرة، ولعمل تدقيق (audit) لو حصل خلاف.
// ══════════════════════════════════════════════════════════════════════════════
export const promoRedemptionsTable = pgTable("promo_redemptions", {
  id:              serial("id").primaryKey(),
  promoCodeId:     integer("promo_code_id").notNull(),
  discordUserId:   text("discord_user_id").notNull(),
  purchaseId:      integer("purchase_id"),                // التذكرة اللي اتطبق فيها الكود
  discountApplied: integer("discount_applied").notNull().default(0),
  pointsAwarded:   integer("points_awarded").notNull().default(0),
  createdAt:       timestamp("created_at").defaultNow(),
});
export type PromoRedemption = typeof promoRedemptionsTable.$inferSelect;

// ══════════════════════════════════════════════════════════════════════════════
//  user_points — رصيد النقاط
//  NOTE: النقاط دي عملة تانية غير رصيد المنشنات (offers/here/everyone في
//        bot_users). بتتزود من فرق كود الخصم (لو قيمته أكبر من سعر المتجر)،
//        أو يدوي بالأدمن عن طريق /points.
//        الاستخدام المستقبلي: شراء منشنات أو حاجات تانية بالنقاط (لسه ماتعملش
//        — راجع notes/promo-codes.md).
// ══════════════════════════════════════════════════════════════════════════════
export const userPointsTable = pgTable("user_points", {
  id:            serial("id").primaryKey(),
  discordUserId: text("discord_user_id").notNull().unique(),
  points:        integer("points").notNull().default(0),
  updatedAt:     timestamp("updated_at").defaultNow(),
});
export type UserPoints = typeof userPointsTable.$inferSelect;

// ══════════════════════════════════════════════════════════════════════════════
//  product_requests — تكتات "طلب المنتج"
//  NOTE: بتتعمل لما عميل يضغط زرار "طلب المنتج" تحت رسالة صاحب متجر.
//        ticketNumber: عداد مستقل لكل متجر (roomChannelId) — بيبدأ من 1.
//        status: 'open' → 'closed' (لما الأدمن يقفل التكت من الثريد).
//        threadId: الثريد اللي اتعمل جوه شانل المتجر للمراجعة.
// ══════════════════════════════════════════════════════════════════════════════
export const productRequestsTable = pgTable("product_requests", {
  id:                serial("id").primaryKey(),
  roomChannelId:     text("room_channel_id").notNull(),
  ticketNumber:      integer("ticket_number").notNull(),
  threadId:          text("thread_id").notNull(),
  requesterId:       text("requester_id").notNull(),
  requesterUsername: text("requester_username").notNull(),
  storeOwnerId:      text("store_owner_id").notNull(),
  status:            text("status").notNull().default("open"), // 'open' | 'closed'
  createdAt:         timestamp("created_at").defaultNow(),
  closedAt:          timestamp("closed_at"),
}, (table) => [
  // بيمنع تكرار نفس رقم التكت لنفس المتجر لو حصل ضغط متزامن على الزرار
  unique("product_requests_room_ticket_unique").on(table.roomChannelId, table.ticketNumber),
]);
export type ProductRequest = typeof productRequestsTable.$inferSelect;
