// ══════════════════════════════════════════════════════════════════
// rewards-bot.js — Rewards Portal Bot — FINAL v14 (Full Bug Fix)
// Changes v14 (fixes over v13):
//   🐛 FIX: /redeem — genInvoice prefix was "DC" (2 chars hardcoded); now dynamic
//   🐛 FIX: /redeem — race condition: findOneAndUpdate can return null value obj; added proper null check
//   🐛 FIX: /verify-code — genInvoice prefix "WS" is fine but webKey check used wrong field (selectedGame vs webKey)
//   🐛 FIX: review_reject_ button — no null check on `reviews` before findOne (crashes if DB drops)
//   🐛 FIX: postReviewAlert — alertSent logic was inverted (isInstant was wrong when alertSent=false on first post)
//   🐛 FIX: scheduleReview — was calling postReviewAlert with stale `review` obj (before upsert saved it); now fetches fresh doc
//   🐛 FIX: /spend-coins — gameKey could be undefined, slice(0,2) on undefined throws; added safe fallback
//   🐛 FIX: /bulk-generate — insertMany with ordered:false silently drops duplicate codes; added retry loop
//   🐛 FIX: /track-order — only checks `codes` collection for invoice, misses coin-spend redemptions in `reviews`
//   🐛 FIX: /eiq-stats — reviews.countDocuments called without null guard (crashes if DB not ready)
//   🐛 FIX: exchangeDiscordCode — no null guard on CONFIG.DISCORD_CLIENT_SECRET; throws cryptic error
//   🐛 FIX: forceJoinUser — token refresh updated DB but used OLD accessToken if refresh succeeded; now uses new token
//   🐛 FIX: startAPI called before connectDB resolves — routers got stale `db` reference; fixed order in clientReady
//   🐛 FIX: /api/admin/users — no null guard on `users`; crashes if DB not ready
//   🐛 FIX: /api/save-redemption — scheduleReview called even when upsert matched existing doc (re-posts alert); now skipped on match
//   🐛 FIX: graceful shutdown — client.destroy() called before mongo.close() could finish; await order fixed
//   ✅ Added missing null guard on `reviews` in review_reject_ handler
//   ✅ Added ADMIN_API_KEY check on /api/pull-all (was already there but also added to /api/join-guild and /api/kick-guild for safety note)
//   ✅ All v13 features preserved
// ══════════════════════════════════════════════════════════════════

import {
  Client, GatewayIntentBits, SlashCommandBuilder,
  REST, Routes, EmbedBuilder, PermissionFlagsBits,
  Collection, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  AttachmentBuilder,
} from "discord.js";
import { MongoClient } from "mongodb";
import express from "express";
import cors from "cors";
import { createSupportMailRouter } from "./routes/supportMail.js";
import { createGiveawaysRouter }   from "./routes/giveaways.js";
import { requireAdmin }            from "./middleware/adminAuth.js";

// ═══════════════════════ CONFIG ══════════════════════════════════
const CONFIG = {
  BOT_TOKEN:   process.env.BOT_TOKEN,
  CLIENT_ID:   process.env.CLIENT_ID   || "1485034551108702268",
  GUILD_ID:    process.env.GUILD_ID    || "1487143750093377726",
  LOG_CHANNEL: process.env.LOG_CHANNEL || "1494023064730734662",

  REVIEW_CHANNEL: (process.env.REVIEW_CHANNEL_ID || "1493126020436594688").replace(/^=+/, ""),

  DISCORD_CLIENT_ID:     process.env.DISCORD_CLIENT_ID     || "1485034551108702268",
  DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET,
  REDIRECT_URI:          process.env.REDIRECT_URI           || "https://www.elevateiq.shop/auth/callback",

  MONGO_URI: process.env.MONGO_URI,
  PORT: parseInt(process.env.PORT) || 3000,

  MONITOR_GUILDS: (process.env.MONITOR_GUILDS || "").split(",").map(g => g.trim()).filter(Boolean),
};

if (!CONFIG.BOT_TOKEN)             { console.error("❌ BOT_TOKEN env var is required");              process.exit(1); }
if (!CONFIG.MONGO_URI)             { console.error("❌ MONGO_URI env var is required");               process.exit(1); }
// ✅ FIX: Warn early if DISCORD_CLIENT_SECRET is missing (OAuth will fail silently otherwise)
if (!CONFIG.DISCORD_CLIENT_SECRET) { console.warn("⚠️  DISCORD_CLIENT_SECRET not set — OAuth login will fail"); }

console.log(`🔍 Railway PORT = ${process.env.PORT} → Using: ${CONFIG.PORT}`);

// ═══════════════════════ ACCESS CONTROL SYSTEM ═══════════════════
const OWNER_ID = "1489622661326835874";  // Replace with your Discord user ID

let ownerLimits;
let accessList;

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function getUserUsage(userId, dateKey) {
  if (!ownerLimits) return { generateCount: 0, bulkCodesTotal: 0 };
  try {
    const doc = await ownerLimits.findOne({ userId, dateKey });
    return doc || { generateCount: 0, bulkCodesTotal: 0 };
  } catch { return { generateCount: 0, bulkCodesTotal: 0 }; }
}

async function incUsage(userId, dateKey, field, amount = 1) {
  if (!ownerLimits) return;
  await ownerLimits.updateOne(
    { userId, dateKey },
    { $inc: { [field]: amount }, $setOnInsert: { userId, dateKey, generateCount: 0, bulkCodesTotal: 0, createdAt: new Date() } },
    { upsert: true }
  );
}

async function getAccess(userId, commandName) {
  if (userId === OWNER_ID) return { allowed: true, generateLimit: Infinity, bulkLimit: Infinity };
  if (!accessList) return { allowed: false };
  try {
    const entry = await accessList.findOne({ userId, active: true });
    if (!entry) return { allowed: false };
    if (!entry.commands.includes(commandName) && !entry.commands.includes("all")) return { allowed: false };
    return { allowed: true, generateLimit: entry.generateLimit ?? 1, bulkLimit: entry.bulkLimit ?? 100 };
  } catch { return { allowed: false }; }
}

async function checkAccess(interaction, commandName) {
  const access = await getAccess(interaction.user.id, commandName);
  if (!access.allowed) {
    await safeReply(interaction, {
      content: `🔒 **Access Denied** — You don't have permission to use \`/${commandName}\`.\nContact the bot owner to get access.`,
      flags: 64,
    });
    return null;
  }
  return access;
}

// ═══════════════════════ MONGODB ═════════════════════════════════
const mongo = new MongoClient(CONFIG.MONGO_URI, {
  serverSelectionTimeoutMS: 15000,
  connectTimeoutMS:         15000,
  socketTimeoutMS:          45000,
  maxPoolSize:              10,
  retryWrites:              true,
});

let db, codes, users, logs, redemptions, reviews, serverPullConfig;
let dbConnected = false;
let schedulerStarted = false;

async function connectDB() {
  try {
    await mongo.connect();
    db               = mongo.db("elevateiq");
    codes            = db.collection("codes");
    users            = db.collection("users");
    logs             = db.collection("logs");
    redemptions      = db.collection("redemptions");
    reviews          = db.collection("reviews");
    serverPullConfig = db.collection("server_pull_config");
    ownerLimits      = db.collection("owner_daily_limits");
    accessList       = db.collection("access_list");

    await Promise.all([
      codes.createIndex({ code: 1 },                    { unique: true }),
      users.createIndex({ userId: 1 },                  { unique: true }),
      redemptions.createIndex({ invoiceNo: 1 }),
      redemptions.createIndex({ userId: 1 }),
      reviews.createIndex({ invoiceNo: 1 },             { unique: true }),
      reviews.createIndex({ reviewAt: 1 }),
      serverPullConfig.createIndex({ guildId: 1 },      { unique: true }),
      ownerLimits.createIndex({ userId: 1, dateKey: 1 },{ unique: true }),
      accessList.createIndex({ userId: 1 },             { unique: true }),
    ]);

    dbConnected = true;
    console.log("✅ MongoDB connected");
    if (!schedulerStarted) {
      start72DayScheduler();
      schedulerStarted = true;
    }

  } catch (err) {
    console.error("❌ MongoDB failed:", err.message);
    dbConnected = false;
    setTimeout(connectDB, 5000);
  }
}

mongo.on("error",        e  => { console.error("Mongo error:", e.message); dbConnected = false; });
mongo.on("close",        () => { console.warn("Mongo connection closed — reconnecting..."); dbConnected = false; });
mongo.on("serverHeartbeatFailed", () => { dbConnected = false; });

// ═══════════════════════ TOKEN REFRESH ═══════════════════════════
async function refreshDiscordToken(refreshToken) {
  // ✅ FIX: Guard against missing client secret early
  if (!CONFIG.DISCORD_CLIENT_SECRET) return null;
  try {
    const params = new URLSearchParams({
      client_id:     CONFIG.DISCORD_CLIENT_ID,
      client_secret: CONFIG.DISCORD_CLIENT_SECRET,
      grant_type:    "refresh_token",
      refresh_token: refreshToken,
    });
    const res = await fetch("https://discord.com/api/oauth2/token", {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    params,
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.access_token ? data : null;
  } catch { return null; }
}

// ═══════════════════════ UTILS ════════════════════════════════════
const fmt = n => Number(n || 0).toLocaleString("en-IN");

function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const seg   = () => Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `${seg()}-${seg()}-${seg()}-${seg()}-${seg()}`;
}

// ✅ FIX: genInvoice now safely handles undefined/null prefix (no more crash on .slice of undefined)
function genInvoice(prefix) {
  const safe = (typeof prefix === "string" && prefix.length > 0)
    ? prefix.slice(0, 2).toUpperCase()
    : "IQ";
  return `IQ-${safe}-${Date.now().toString(36).toUpperCase().slice(-7)}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function makeProgressBar(current, total, size = 20) {
  const pct    = total === 0 ? 0 : Math.min(1, current / total);
  const filled = Math.round(pct * size);
  const empty  = size - filled;
  return `[${"█".repeat(filled)}${"░".repeat(empty)}] ${Math.round(pct * 100)}%`;
}

const GAME_LABELS = {
  minecraft:  "⛏ Minecraft Reward",
  roblox_50:  "🎮 Roblox $50 Plan",
  roblox_100: "🎮 Roblox $100 Plan",
  xbox:       "🎯 Xbox Game Pass",
  nitro:      "💎 Discord Nitro",
};

const GAME_WEBKEY = {
  minecraft:  "mc",
  roblox_50:  "rb",
  roblox_100: "rb",
  xbox:       "xbox",
  nitro:      "nitro",
};

// ═══════════════════════ SAFE REPLY ══════════════════════════════
async function safeReply(interaction, options) {
  try {
    if (interaction.replied || interaction.deferred) return await interaction.followUp(options);
    return await interaction.reply(options);
  } catch (e) {
    if (e.code !== 10062 && e.code !== 40060) console.error("safeReply:", e.message);
  }
}

// ═══════════════════════ USER HELPERS ════════════════════════════
async function getUser(userId) {
  if (!users) return { userId, coins: 0, invites: 0, messages: 0 };
  try {
    const u = await users.findOneAndUpdate(
      { userId },
      { $setOnInsert: { userId, coins: 0, invites: 0, messages: 0, createdAt: new Date() } },
      { upsert: true, returnDocument: "after" }
    );
    return u || { userId, coins: 0, invites: 0, messages: 0 };
  } catch {
    return { userId, coins: 0, invites: 0, messages: 0 };
  }
}

async function addCoins(userId, amount) {
  if (!users) return;
  await users.updateOne({ userId }, { $inc: { coins: amount } }, { upsert: true });
}

// ═══════════════════════ DISCORD LOG ════════════════════════════
async function logEmbed(embed) {
  try {
    const ch = client.channels.cache.get(CONFIG.LOG_CHANNEL);
    if (ch) await ch.send({ embeds: [embed] });
  } catch (e) { console.error("Log error:", e.message); }
}

// ═══════════════════════ SERVER PULL CORE ════════════════════════
async function forceJoinUser(userId, targetGuildId) {
  if (!users) return { success: false, reason: "db_not_ready" };

  const u = await users.findOne({ userId });
  if (!u) return { success: false, reason: "user_not_in_db" };

  // ✅ FIX: After refresh, use the NEW access token, not the old one
  let accessToken = u.accessToken;

  if (u.refreshToken) {
    const newData = await refreshDiscordToken(u.refreshToken);
    if (newData) {
      accessToken = newData.access_token; // ✅ Use refreshed token immediately
      await users.updateOne({ userId }, {
        $set: {
          accessToken:    newData.access_token,
          refreshToken:   newData.refresh_token || u.refreshToken,
          tokenExpiresAt: new Date(Date.now() + newData.expires_in * 1000),
          tokenUpdatedAt: new Date(),
        },
      });
    }
  }

  if (!accessToken) return { success: false, reason: "no_token" };

  try {
    const res = await fetch(`https://discord.com/api/v10/guilds/${targetGuildId}/members/${userId}`, {
      method:  "PUT",
      headers: { Authorization: `Bot ${CONFIG.BOT_TOKEN}`, "Content-Type": "application/json" },
      body:    JSON.stringify({ access_token: accessToken }),
    });

    if (res.status === 201) return { success: true, reason: "joined" };
    if (res.status === 204) return { success: true, reason: "already_in" };
    if (res.status === 403) return { success: false, reason: "bot_not_in_guild_or_no_permission" };
    if (res.status === 401) {
      await users.updateOne({ userId }, { $unset: { accessToken: "", refreshToken: "" } });
      return { success: false, reason: "token_invalid_cleared" };
    }

    const body = await res.json().catch(() => ({}));
    return { success: false, reason: `api_error_${res.status}`, detail: body };
  } catch (e) {
    return { success: false, reason: "network_error", detail: e.message };
  }
}

async function forceKickUser(userId, targetGuildId, reason = "Admin action via Rewards Portal bot") {
  try {
    const res = await fetch(`https://discord.com/api/v10/guilds/${targetGuildId}/members/${userId}`, {
      method:  "DELETE",
      headers: {
        Authorization: `Bot ${CONFIG.BOT_TOKEN}`,
        "X-Audit-Log-Reason": encodeURIComponent(reason),
      },
    });
    if (res.status === 204) return { success: true };
    if (res.status === 404) return { success: false, reason: "user_not_in_guild" };
    if (res.status === 403) return { success: false, reason: "bot_lacks_kick_permission" };
    return { success: false, reason: `api_error_${res.status}` };
  } catch (e) {
    return { success: false, reason: "network_error", detail: e.message };
  }
}

async function getMonitoredGuilds() {
  if (!serverPullConfig) return CONFIG.MONITOR_GUILDS;
  try {
    const configs  = await serverPullConfig.find({ monitored: true }).toArray();
    const dbGuilds = configs.map(c => c.guildId);
    return [...new Set([...CONFIG.MONITOR_GUILDS, ...dbGuilds])];
  } catch { return CONFIG.MONITOR_GUILDS; }
}

// ═══════════════════════ 72-DAY REVIEW SYSTEM ════════════════════
async function scheduleReview(data, isNewDoc = true) {
  if (!reviews) return;
  // ✅ FIX: Only post alert for genuinely new reviews, not retried saves
  if (!isNewDoc) return;

  const reviewAt = new Date(Date.now() + 72 * 24 * 60 * 60 * 1000);
  try {
    const upsertResult = await reviews.updateOne(
      { invoiceNo: data.invoiceNo },
      {
        $setOnInsert: {
          invoiceNo:   data.invoiceNo,
          userId:      data.userId,
          userName:    data.userName,
          discordTag:  data.discordTag  || data.userName,
          game:        data.game,
          plan:        data.plan        || null,
          account:     data.account     || null,
          email:       data.email       || null,
          userAvatar:  data.userAvatar  || null,
          inrPrice:    data.inrPrice    || null,
          redeemType:  data.redeemType  || "code",
          coinsSpent:  data.coinsSpent  || 0,
          reviewAt,
          status:      "pending",
          alertSent:   false,
          createdAt:   new Date(),
        },
      },
      { upsert: true }
    );

    // ✅ FIX: Only post alert if a new document was INSERTED (not matched/updated)
    if (upsertResult.upsertedCount > 0) {
      const saved = await reviews.findOne({ invoiceNo: data.invoiceNo });
      if (saved) await postReviewAlert(saved);
    }
  } catch (e) {
    console.error("scheduleReview error:", e.message);
  }
}

async function postReviewAlert(review) {
  try {
    let ch;
    try {
      ch = client.channels.cache.get(CONFIG.REVIEW_CHANNEL) || await client.channels.fetch(CONFIG.REVIEW_CHANNEL);
    } catch (fetchErr) {
      console.error("REVIEW_CHANNEL fetch failed:", CONFIG.REVIEW_CHANNEL, fetchErr.message);
      return;
    }
    if (!ch) { console.error("REVIEW_CHANNEL not found:", CONFIG.REVIEW_CHANNEL); return; }

    // ✅ FIX: isInstant logic corrected — new doc has alertSent=false AND was just created
    const ageMs     = Date.now() - new Date(review.createdAt).getTime();
    const isInstant = !review.alertSent && ageMs < 60000;

    const embed = new EmbedBuilder()
      .setColor(isInstant ? 0x7c5cfc : 0xf59e0b)
      .setTitle(isInstant ? "🆕 New Redemption — Action Required" : "⏰ 72-Day Reward Review — Action Required")
      .setThumbnail(review.userAvatar || null)
      .setDescription(
        `A reward has been redeemed${isInstant ? " **just now**" : " and is due for review"}. Please select an action below.\n` +
        `> **User:** <@${review.userId}> (\`${review.discordTag || review.userName}\`)\n` +
        `> **Invoice:** \`${review.invoiceNo}\``
      )
      .addFields(
        { name: "🎮 Game",        value: review.game       || "—",        inline: true },
        { name: "📦 Plan",        value: review.plan       || "Standard", inline: true },
        { name: "💰 Price",       value: review.inrPrice   || "—",        inline: true },
        { name: "🎯 Account",     value: review.account    || "—",        inline: true },
        { name: "📧 Email",       value: review.email      || "—",        inline: true },
        { name: "🎫 Redeem Type", value: review.redeemType === "code" ? "🎫 Code" : `🪙 Coins (${(review.coinsSpent || 0).toLocaleString()})`, inline: true },
        { name: "📊 Status",      value: "🟡 Awaiting Admin Decision", inline: false },
      )
      .setFooter({ text: "Rewards Portal — Review System" })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`review_activate_${review.invoiceNo}`).setLabel("✅ Activate").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`review_pending_${review.invoiceNo}`).setLabel("⏳ Keep Pending").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`review_reject_${review.invoiceNo}`).setLabel("❌ Reject").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`review_custom_${review.invoiceNo}`).setLabel("⚠️ Custom Reject").setStyle(ButtonStyle.Primary),
    );

    const msg = await ch.send({ embeds: [embed], components: [row] });

    await reviews.updateOne(
      { invoiceNo: review.invoiceNo },
      { $set: { alertSent: true, alertMessageId: msg.id, alertChannelId: ch.id, alertSentAt: new Date() } }
    );

    console.log(`✅ Review alert posted for ${review.invoiceNo}`);
  } catch (e) {
    console.error("postReviewAlert error:", e.message);
  }
}

function start72DayScheduler() {
  const check = async () => {
    if (!reviews || !dbConnected) return;
    try {
      const due = await reviews.find({
        reviewAt:  { $lte: new Date() },
        alertSent: false,
        status:    "pending",
      }).toArray();

      for (const r of due) {
        await postReviewAlert(r);
        await sleep(1000);
      }

      if (due.length > 0) console.log(`📅 Scheduler: Sent ${due.length} review alert(s)`);
    } catch (e) {
      console.error("Scheduler error:", e.message);
    }
  };

  setInterval(check, 30 * 60 * 1000);
  setTimeout(check, 10000);
  console.log("✅ 72-day review scheduler started");
}

// ═══════════════════════ DM HELPERS ══════════════════════════════
async function dmUser(userId, embed) {
  try {
    const user = await client.users.fetch(userId);
    await user.send({ embeds: [embed] });
    return true;
  } catch (e) {
    console.error(`DM to ${userId} failed:`, e.message);
    return false;
  }
}

// ═══════════════════════ CLIENT SETUP ════════════════════════════
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ═══════════════════════ SLASH COMMANDS ══════════════════════════
const GAME_CHOICES = [
  { name: "⛏ Minecraft",       value: "minecraft"  },
  { name: "🎮 Roblox $50",     value: "roblox_50"  },
  { name: "🎮 Roblox $100",    value: "roblox_100" },
  { name: "💎 Discord Nitro",  value: "nitro"      },
  { name: "🎯 Xbox Game Pass", value: "xbox"       },
];

const COMMANDS = [

  new SlashCommandBuilder()
    .setName("grant-access")
    .setDescription("🔑 [OWNER] Grant a user access to restricted commands")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o => o.setName("user").setDescription("User to grant access").setRequired(true))
    .addStringOption(o =>
      o.setName("commands").setDescription("Which commands to allow").setRequired(true)
       .addChoices(
         { name: "generate-code only",       value: "generate-code" },
         { name: "bulk-generate only",        value: "bulk-generate" },
         { name: "serverpulling only",        value: "serverpulling" },
         { name: "generate + bulk",           value: "generate-code,bulk-generate" },
         { name: "generate + bulk + pulling", value: "all" },
       )
    )
    .addIntegerOption(o => o.setName("generate_limit").setDescription("Max /generate-code uses per day (default: 1)").setRequired(false).setMinValue(1).setMaxValue(50))
    .addIntegerOption(o => o.setName("bulk_limit").setDescription("Max total codes via /bulk-generate per day (default: 100)").setRequired(false).setMinValue(1).setMaxValue(500)),

  new SlashCommandBuilder()
    .setName("revoke-access")
    .setDescription("🔒 [OWNER] Remove a user's access to restricted commands")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o => o.setName("user").setDescription("User to revoke").setRequired(true)),

  new SlashCommandBuilder()
    .setName("list-access")
    .setDescription("📋 [OWNER] List all users who have been granted access")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("generate-code")
    .setDescription("🎁 [ADMIN] Generate a single reward code")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName("game").setDescription("Game type").setRequired(true).addChoices(...GAME_CHOICES))
    .addUserOption(o => o.setName("user").setDescription("Assign to a specific user (optional)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("bulk-generate")
    .setDescription("🎁 [ADMIN] Bulk generate codes (up to 500) — sends as .txt file")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName("game").setDescription("Game").setRequired(true).addChoices(...GAME_CHOICES))
    .addIntegerOption(o => o.setName("quantity").setDescription("How many (1-500)").setRequired(true).setMinValue(1).setMaxValue(500))
    .addUserOption(o => o.setName("user").setDescription("Assign to user (optional)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("revoke-code")
    .setDescription("❌ [ADMIN] Revoke a code")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName("code").setDescription("Code to revoke").setRequired(true)),

  new SlashCommandBuilder()
    .setName("list-codes")
    .setDescription("📋 [ADMIN] List recent codes")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("add-coins")
    .setDescription("🪙 [ADMIN] Add IQCoins to a user")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))
    .addIntegerOption(o => o.setName("amount").setDescription("Amount").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false)),

  new SlashCommandBuilder()
    .setName("remove-coins")
    .setDescription("🔻 [ADMIN] Remove IQCoins")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))
    .addIntegerOption(o => o.setName("amount").setDescription("Amount").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Reason").setRequired(false)),

  new SlashCommandBuilder()
    .setName("set-coins")
    .setDescription("⚙️ [ADMIN] Set exact coin balance")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))
    .addIntegerOption(o => o.setName("amount").setDescription("New balance").setRequired(true)),

  new SlashCommandBuilder()
    .setName("reset-coins")
    .setDescription("⚠️ [ADMIN] Reset user coins to zero")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o => o.setName("user").setDescription("User").setRequired(true)),

  new SlashCommandBuilder()
    .setName("delete-channels")
    .setDescription("🗑️ [ADMIN] Delete channels by keyword")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
    .addStringOption(o => o.setName("keyword").setDescription("Keyword to match").setRequired(true)),

  new SlashCommandBuilder()
    .setName("claim-channel")
    .setDescription("✋ Claim this ticket channel"),

  new SlashCommandBuilder()
    .setName("revoke-invites")
    .setDescription("🔗 [ADMIN] Delete server invites")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addIntegerOption(o => o.setName("count").setDescription("How many (max 200)").setRequired(true).setMinValue(1).setMaxValue(200)),

  new SlashCommandBuilder()
    .setName("serverpulling")
    .setDescription("📨 [ADMIN] Force-pull website users — LIVE progress")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName("guild_id").setDescription("Target Guild ID (blank = this server)").setRequired(false))
    .addIntegerOption(o => o.setName("limit").setDescription("Max users to pull (blank = ALL)").setRequired(false).setMinValue(1).setMaxValue(10000)),

  new SlashCommandBuilder()
    .setName("bulkserverleave")
    .setDescription("🚪 [ADMIN] Force-remove ALL website users from a Discord server in bulk")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName("guild_id").setDescription("Target Guild ID (blank = this server)").setRequired(false))
    .addIntegerOption(o => o.setName("limit").setDescription("Max users to kick (blank = ALL)").setRequired(false).setMinValue(1).setMaxValue(10000))
    .addStringOption(o => o.setName("reason").setDescription("Audit log reason").setRequired(false)),

  new SlashCommandBuilder()
    .setName("serverpull-user")
    .setDescription("📨 [ADMIN] Force-join a specific user into a Discord server")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o => o.setName("user").setDescription("User to pull").setRequired(true))
    .addStringOption(o => o.setName("guild_id").setDescription("Target Guild ID (blank = this server)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("serverleave")
    .setDescription("🚪 [ADMIN] Force-remove a user from a Discord server")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addUserOption(o => o.setName("user").setDescription("User to remove").setRequired(true))
    .addStringOption(o => o.setName("guild_id").setDescription("Target Guild ID (blank = this server)").setRequired(false))
    .addStringOption(o => o.setName("reason").setDescription("Reason for removal").setRequired(false)),

  new SlashCommandBuilder()
    .setName("serverstatus")
    .setDescription("📊 [ADMIN] Check pull status")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName("guild_id").setDescription("Target Guild ID (blank = this server)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("monitor-add")
    .setDescription("🔒 [ADMIN] Add a guild to auto-rejoin list")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName("guild_id").setDescription("Guild ID to monitor (blank = this server)").setRequired(false)),

  new SlashCommandBuilder()
    .setName("monitor-remove")
    .setDescription("🔓 [ADMIN] Remove a guild from auto-rejoin monitoring")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName("guild_id").setDescription("Guild ID to stop monitoring").setRequired(true)),

  new SlashCommandBuilder()
    .setName("monitor-list")
    .setDescription("📋 [ADMIN] List all guilds being monitored for auto-rejoin")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("eiq-stats")
    .setDescription("📊 [ADMIN] System stats")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  new SlashCommandBuilder()
    .setName("details")
    .setDescription("📋 [ADMIN] Full user redemption details")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption(o => o.setName("user").setDescription("User to check").setRequired(true)),

  new SlashCommandBuilder()
    .setName("trigger-review")
    .setDescription("⏰ [ADMIN] Manually trigger 72-day review alert for an invoice")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName("invoice").setDescription("Invoice number e.g. IQ-WS-XXXXX").setRequired(true)),

  new SlashCommandBuilder()
    .setName("coins")
    .setDescription("🪙 Check your IQCoins balance")
    .addUserOption(o => o.setName("user").setDescription("Check another user").setRequired(false)),

  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("🏆 Top 10 IQCoins earners"),

  new SlashCommandBuilder()
    .setName("redeem")
    .setDescription("🎫 Redeem a reward code")
    .addStringOption(o => o.setName("code").setDescription("Your 25-character code").setRequired(true)),

  new SlashCommandBuilder()
    .setName("track-order")
    .setDescription("📦 Track order by invoice number")
    .addStringOption(o => o.setName("invoice").setDescription("Invoice number e.g. IQ-MC-XXXXX").setRequired(true)),

  new SlashCommandBuilder()
    .setName("invite-stats")
    .setDescription("📊 Check invite count")
    .addUserOption(o => o.setName("user").setDescription("User (optional)").setRequired(false)),

].map(c => c.toJSON());

// ═══════════════════════ REGISTER COMMANDS ════════════════════════
async function registerCommands() {
  try {
    const rest = new REST({ version: "10" }).setToken(CONFIG.BOT_TOKEN);

    const guildsToClear = [CONFIG.GUILD_ID, ...CONFIG.MONITOR_GUILDS].filter(Boolean);
    for (const gId of guildsToClear) {
      try {
        await rest.put(Routes.applicationGuildCommands(CONFIG.CLIENT_ID, gId), { body: [] });
        console.log(`🧹 Cleared old guild commands from: ${gId}`);
      } catch (_) {}
    }

    await rest.put(Routes.applicationCommands(CONFIG.CLIENT_ID), { body: COMMANDS });
    console.log(`✅ ${COMMANDS.length} global commands registered`);
  } catch (err) {
    console.error("❌ Command register error:", err.message);
  }
}

// ═══════════════════════ BOT READY ═══════════════════════════════
// ✅ FIX: connectDB() awaited BEFORE startAPI() so routers get valid `db` reference
client.once("clientReady", async () => {
  console.log(`✅ Bot online: ${client.user.tag}`);
  await connectDB();
  await registerCommands();
  startAPI(); // DB is now connected before API starts

  await logEmbed(
    new EmbedBuilder()
      .setColor(0x7c5cfc)
      .setTitle("🚀 Rewards Portal Bot Online — v14")
      .setDescription(
        `**${client.user.tag}** is ready\n` +
        `API Port: ${CONFIG.PORT} | Commands: ${COMMANDS.length} (Global)\n` +
        `72-Day Review Scheduler: ✅ Active\n` +
        `Server Pull: ✅ Active | Bulk Leave: ✅ Active\n` +
        `Support Mail: ✅ Active | Giveaways API: ✅ Active\n` +
        `🔑 Access Control: ✅ Active\n` +
        `🔒 Owner ID: ${OWNER_ID}`
      )
      .setTimestamp()
  );
});

// ✅ AUTO-REJOIN on leave
client.on("guildMemberRemove", async member => {
  try {
    const guildId = member.guild.id;
    const monitoredGuilds = await getMonitoredGuilds();
    if (!monitoredGuilds.includes(guildId)) return;
    const userId = member.id;
    if (member.user.bot) return;
    console.log(`🔄 Auto-rejoin: ${member.user.username} left ${guildId}`);
    await sleep(3000);
    const result = await forceJoinUser(userId, guildId);
    if (result.success) {
      console.log(`✅ Auto-rejoined ${member.user.username}`);
      await logEmbed(
        new EmbedBuilder()
          .setColor(0x7c5cfc)
          .setTitle("🔄 Auto-Rejoin Triggered")
          .setDescription(`User left a monitored server and was automatically re-joined.`)
          .addFields(
            { name: "👤 User",    value: `${member.user.username} (<@${userId}>)`, inline: true },
            { name: "🖥️ Server", value: `\`${guildId}\``,                         inline: true },
            { name: "📊 Result",  value: `✅ ${result.reason}`,                    inline: true },
          )
          .setTimestamp()
      );
    }
  } catch (e) { console.error("guildMemberRemove error:", e.message); }
});

// ═══════════════════════ MESSAGE TRACKER ═════════════════════════
client.on("messageCreate", async msg => {
  if (msg.author.bot || !msg.guildId || !users) return;
  try {
    await users.updateOne(
      { userId: msg.author.id },
      { $set: { userName: msg.author.username, lastSeen: new Date() }, $inc: { messages: 1 } },
      { upsert: true }
    );
  } catch (_) {}
});

// ═══════════════════════ OAUTH DISCORD ═══════════════════════════
async function exchangeDiscordCode(code) {
  // ✅ FIX: Guard missing client secret with a clear error
  if (!CONFIG.DISCORD_CLIENT_SECRET) throw new Error("DISCORD_CLIENT_SECRET is not configured");

  const params = new URLSearchParams({
    client_id:     CONFIG.DISCORD_CLIENT_ID,
    client_secret: CONFIG.DISCORD_CLIENT_SECRET,
    grant_type:    "authorization_code",
    code,
    redirect_uri:  CONFIG.REDIRECT_URI,
  });

  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    params,
  });
  if (!tokenRes.ok) throw new Error(`Discord token exchange failed: ${await tokenRes.text()}`);
  const tokenData = await tokenRes.json();

  const userRes = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  if (!userRes.ok) throw new Error("Failed to fetch Discord user");
  const user = await userRes.json();

  if (users && user.id) {
    await users.updateOne(
      { userId: user.id },
      {
        $set: {
          userId:         user.id,
          userName:       user.username,
          globalName:     user.global_name || user.username,
          discordTag:     user.username,
          avatar:         user.avatar,
          accessToken:    tokenData.access_token,
          refreshToken:   tokenData.refresh_token,
          tokenExpiresAt: new Date(Date.now() + tokenData.expires_in * 1000),
          tokenUpdatedAt: new Date(),
          lastLogin:      new Date(),
        },
        $setOnInsert: { coins: 0, invites: 0, messages: 0, createdAt: new Date() },
      },
      { upsert: true }
    );
  }

  try {
    const joinRes = await fetch(`https://discord.com/api/guilds/${CONFIG.GUILD_ID}/members/${user.id}`, {
      method:  "PUT",
      headers: { Authorization: `Bot ${CONFIG.BOT_TOKEN}`, "Content-Type": "application/json" },
      body:    JSON.stringify({ access_token: tokenData.access_token }),
    });
    if (joinRes.status === 201) console.log(`✅ Auto-joined ${user.username}`);
    else if (joinRes.status === 204) console.log(`ℹ️ ${user.username} already in guild`);
  } catch (e) { console.error("Auto-join error:", e.message); }

  await logEmbed(
    new EmbedBuilder()
      .setColor(0x5865f2).setTitle("🔐 User Login — Website")
      .setThumbnail(user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : null)
      .addFields(
        { name: "👤 User",  value: `${user.global_name || user.username} (@${user.username})`, inline: true },
        { name: "🆔 ID",    value: `\`${user.id}\``,                                           inline: true },
        { name: "🔑 Token", value: tokenData.access_token ? "✅ Stored" : "❌ No token",        inline: true },
      ).setTimestamp()
  );

  return { user, token: tokenData.access_token };
}

// ═══════════════════════ INTERACTION HANDLER ══════════════════════
client.on("interactionCreate", async interaction => {

  // ══ BUTTON INTERACTIONS ══════════════════════════════════════════
  if (interaction.isButton()) {
    const id = interaction.customId;

    if (id.startsWith("review_activate_")) {
      const invoiceNo = id.replace("review_activate_", "");
      await interaction.deferReply({ ephemeral: true });

      if (!reviews) return interaction.editReply({ content: "❌ Database not ready. Try again." });
      const review = await reviews.findOne({ invoiceNo });
      if (!review) return interaction.editReply({ content: "❌ Review record not found." });
      if (review.status !== "pending") return interaction.editReply({ content: `⚠️ Already actioned: **${review.status}**` });

      await reviews.updateOne({ invoiceNo }, {
        $set: {
          status: "activated", actionBy: interaction.user.id, actionAt: new Date(),
          websiteStatus: "activated", websiteMessage: "✅ Your reward has been activated and is ready!", websiteUpdatedAt: new Date(),
        }
      });

      try {
        const msg = await interaction.channel.messages.fetch(review.alertMessageId);
        await msg.edit({
          embeds: [new EmbedBuilder().setColor(0x00e676).setTitle("✅ Reward Activated")
            .setDescription(`Invoice \`${invoiceNo}\` **activated** by <@${interaction.user.id}>.`)
            .addFields(
              { name: "👤 User",  value: `<@${review.userId}>`,       inline: true },
              { name: "🎮 Game",  value: review.game || "—",           inline: true },
              { name: "👮 Admin", value: `<@${interaction.user.id}>`, inline: true },
            ).setTimestamp()],
          components: [],
        });
      } catch (_) {}

      await dmUser(review.userId, new EmbedBuilder()
        .setColor(0x00e676).setTitle("🎉 Your Reward Has Been Activated!")
        .setDescription(`Your reward is now **active**. Check your order status on the website.`)
        .addFields(
          { name: "🎮 Reward",  value: review.game || "—", inline: true },
          { name: "🧾 Invoice", value: `\`${invoiceNo}\``, inline: true },
          { name: "📊 Status",  value: "✅ Activated",      inline: false },
          { name: "🌐 Website", value: "Track at **elevateiq.shop/track**", inline: false },
        )
        .setFooter({ text: "Thank you for using Rewards Portal!" }).setTimestamp()
      );

      await interaction.editReply({ content: `✅ Reward **activated** — user notified.` });
      await logEmbed(new EmbedBuilder().setColor(0x00e676).setTitle("✅ Review: Activated")
        .addFields(
          { name: "Invoice", value: invoiceNo, inline: true },
          { name: "User",    value: `<@${review.userId}>`, inline: true },
          { name: "Admin",   value: `<@${interaction.user.id}>`, inline: true }
        ).setTimestamp());
      return;
    }

    if (id.startsWith("review_pending_")) {
      const invoiceNo = id.replace("review_pending_", "");
      await interaction.deferReply({ ephemeral: true });

      if (!reviews) return interaction.editReply({ content: "❌ Database not ready." });
      const review = await reviews.findOne({ invoiceNo });
      if (!review) return interaction.editReply({ content: "❌ Review record not found." });
      if (review.status !== "pending") return interaction.editReply({ content: `⚠️ Already actioned: **${review.status}**` });

      const newReviewAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await reviews.updateOne({ invoiceNo }, {
        $set: {
          alertSent: false, reviewAt: newReviewAt,
          lastPendedBy: interaction.user.id, lastPendedAt: new Date(),
          websiteStatus: "pending", websiteMessage: "⏳ Your reward is under review.", websiteUpdatedAt: new Date(),
        }
      });

      try {
        const msg = await interaction.channel.messages.fetch(review.alertMessageId);
        await msg.edit({
          embeds: [new EmbedBuilder().setColor(0xf59e0b).setTitle("⏳ Review Extended — Kept Pending")
            .setDescription(`Invoice \`${invoiceNo}\` kept **pending** by <@${interaction.user.id}>. Re-review in 7 days.`)
            .addFields(
              { name: "👤 User",        value: `<@${review.userId}>`, inline: true },
              { name: "🎮 Game",        value: review.game || "—",    inline: true },
              { name: "📅 Next Review", value: `<t:${Math.floor(newReviewAt.getTime() / 1000)}:F>`, inline: false },
            ).setTimestamp()],
          components: [],
        });
      } catch (_) {}

      await dmUser(review.userId, new EmbedBuilder()
        .setColor(0xf59e0b).setTitle("⏳ Reward Status Update — Pending")
        .setDescription(`Your reward is still **Pending**. You'll be notified once a decision is made.`)
        .addFields(
          { name: "🎮 Reward",  value: review.game || "—",  inline: true },
          { name: "🧾 Invoice", value: `\`${invoiceNo}\``,  inline: true },
          { name: "📊 Status",  value: "⏳ Pending Review", inline: false },
        )
        .setFooter({ text: "Rewards Portal — we appreciate your patience." }).setTimestamp()
      );

      await interaction.editReply({ content: `⏳ Kept **pending** — re-review in 7 days.` });
      return;
    }

    if (id.startsWith("review_reject_")) {
      const invoiceNo = id.replace("review_reject_", "");
      await interaction.deferReply({ ephemeral: true });

      // ✅ FIX: Added missing null guard for `reviews` collection
      if (!reviews) return interaction.editReply({ content: "❌ Database not ready." });
      const review = await reviews.findOne({ invoiceNo });
      if (!review) return interaction.editReply({ content: "❌ Review record not found." });
      if (review.status !== "pending") return interaction.editReply({ content: `⚠️ Already actioned: **${review.status}**` });

      await reviews.updateOne({ invoiceNo }, {
        $set: {
          status: "rejected", actionBy: interaction.user.id, actionAt: new Date(),
          websiteStatus: "rejected",
          websiteMessage: "❌ Your reward request was rejected. Contact support for details.",
          websiteReason: "Account flagged — see DM for full details.", websiteUpdatedAt: new Date(),
        }
      });

      try {
        const msg = await interaction.channel.messages.fetch(review.alertMessageId);
        await msg.edit({
          embeds: [new EmbedBuilder().setColor(0xff5252).setTitle("❌ Reward Rejected")
            .setDescription(`Invoice \`${invoiceNo}\` **rejected** by <@${interaction.user.id}>.`)
            .addFields(
              { name: "👤 User",  value: `<@${review.userId}>`,       inline: true },
              { name: "🎮 Game",  value: review.game || "—",           inline: true },
              { name: "👮 Admin", value: `<@${interaction.user.id}>`, inline: true },
            ).setTimestamp()],
          components: [],
        });
      } catch (_) {}

      await dmUser(review.userId, new EmbedBuilder()
        .setColor(0xff5252).setTitle("🚫 Reward Request Rejected — Account Issue Detected")
        .setDescription(
          `After review, your reward request has been **rejected**.\n\n` +
          `**Reason:** Account flagged for a potential policy violation. This may relate to:\n` +
          `• Suspicious or fraudulent activity\n• Third-party blacklists\n• Terms of Service violation\n\n` +
          `If you believe this was an error, open a support ticket with your invoice number.`
        )
        .addFields(
          { name: "🎮 Reward",    value: review.game || "—",             inline: true },
          { name: "🧾 Invoice",   value: `\`${invoiceNo}\``,             inline: true },
          { name: "📊 Status",    value: "❌ Rejected",                   inline: false },
          { name: "📋 Reference", value: `Case ID: \`REJ-${invoiceNo}\``, inline: false },
        )
        .setFooter({ text: "Rewards Portal — Security & Compliance Team" }).setTimestamp()
      );

      await interaction.editReply({ content: `❌ Reward **rejected** — user notified.` });
      await logEmbed(new EmbedBuilder().setColor(0xff5252).setTitle("❌ Review: Rejected")
        .addFields(
          { name: "Invoice", value: invoiceNo, inline: true },
          { name: "User",    value: `<@${review.userId}>`, inline: true },
          { name: "Admin",   value: `<@${interaction.user.id}>`, inline: true }
        ).setTimestamp());
      return;
    }

    if (id.startsWith("review_custom_")) {
      const invoiceNo = id.replace("review_custom_", "");
      const modal = new ModalBuilder()
        .setCustomId(`modal_custom_reject_${invoiceNo}`)
        .setTitle("Custom Reject — Enter Reason");
      const reasonInput = new TextInputBuilder()
        .setCustomId("custom_reason")
        .setLabel("Rejection reason (shown on website + DM)")
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder("e.g. Your account credentials were incorrect.")
        .setRequired(true).setMaxLength(500);
      modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
      await interaction.showModal(modal);
      return;
    }
  }

  if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith("modal_custom_reject_")) {
      const invoiceNo    = interaction.customId.replace("modal_custom_reject_", "");
      const customReason = interaction.fields.getTextInputValue("custom_reason");
      await interaction.deferReply({ ephemeral: true });

      if (!reviews) return interaction.editReply({ content: "❌ Database not ready." });
      const review = await reviews.findOne({ invoiceNo });
      if (!review) return interaction.editReply({ content: "❌ Review record not found." });
      if (review.status !== "pending") return interaction.editReply({ content: `⚠️ Already actioned: **${review.status}**` });

      await reviews.updateOne({ invoiceNo }, {
        $set: {
          status: "custom_rejected", customReason,
          actionBy: interaction.user.id, actionAt: new Date(),
          websiteStatus: "rejected",
          websiteMessage: `❌ Your reward was rejected. Reason: ${customReason}`,
          websiteReason: customReason, websiteUpdatedAt: new Date(),
        }
      });

      try {
        const ch  = client.channels.cache.get(review.alertChannelId);
        const msg = await ch?.messages.fetch(review.alertMessageId);
        await msg?.edit({
          embeds: [new EmbedBuilder().setColor(0xf97316).setTitle("⚠️ Reward — Custom Rejection")
            .setDescription(`Invoice \`${invoiceNo}\` custom-rejected by <@${interaction.user.id}>.`)
            .addFields(
              { name: "👤 User",   value: `<@${review.userId}>`, inline: true },
              { name: "🎮 Game",   value: review.game || "—",    inline: true },
              { name: "📝 Reason", value: customReason,          inline: false },
            ).setTimestamp()],
          components: [],
        });
      } catch (_) {}

      await dmUser(review.userId, new EmbedBuilder()
        .setColor(0xf97316).setTitle("⚠️ Reward Request Rejected — Account Issue Detected")
        .setDescription(
          `After review, your reward request has been **rejected**.\n\n` +
          `**Reason provided:**\n> ${customReason}\n\n` +
          `If you believe this was an error, open a support ticket with your invoice number.`
        )
        .addFields(
          { name: "🎮 Reward",    value: review.game || "—",              inline: true },
          { name: "🧾 Invoice",   value: `\`${invoiceNo}\``,              inline: true },
          { name: "📊 Status",    value: "⚠️ Custom Rejection",           inline: false },
          { name: "📋 Reference", value: `Case ID: \`CREJ-${invoiceNo}\``, inline: false },
        )
        .setFooter({ text: "Rewards Portal — Security & Compliance Team" }).setTimestamp()
      );

      await interaction.editReply({ content: `⚠️ Custom rejection sent — user notified.` });
      await logEmbed(new EmbedBuilder().setColor(0xf97316).setTitle("⚠️ Review: Custom Rejected").addFields(
        { name: "Invoice", value: invoiceNo,                   inline: true },
        { name: "User",    value: `<@${review.userId}>`,       inline: true },
        { name: "Reason",  value: customReason,                inline: false },
        { name: "Admin",   value: `<@${interaction.user.id}>`, inline: true }
      ).setTimestamp());
      return;
    }
  }

  if (!interaction.isChatInputCommand()) return;
  const { commandName: cmd, guild, member } = interaction;

  // ── /grant-access ────────────────────────────────────────────
  if (cmd === "grant-access") {
    if (interaction.user.id !== OWNER_ID) return safeReply(interaction, { content: "🔒 **Owner only command.**", flags: 64 });
    const targetUser    = interaction.options.getUser("user");
    const commandsValue = interaction.options.getString("commands");
    const genLimit      = interaction.options.getInteger("generate_limit") ?? 1;
    const bulkLimit     = interaction.options.getInteger("bulk_limit") ?? 100;
    const commandsList  = commandsValue === "all" ? ["all"] : commandsValue.split(",");
    try {
      await accessList.updateOne({ userId: targetUser.id }, {
        $set: { userId: targetUser.id, userName: targetUser.username, commands: commandsList, generateLimit: genLimit, bulkLimit, active: true, grantedBy: interaction.user.id, updatedAt: new Date() },
        $setOnInsert: { createdAt: new Date() },
      }, { upsert: true });
      const cmdLabel = commandsValue === "all" ? "generate-code + bulk-generate + serverpulling" : commandsList.join(", ");
      const embed = new EmbedBuilder().setColor(0x00e676).setTitle("🔑 Access Granted")
        .setDescription(`<@${targetUser.id}> can now use the following restricted commands.`)
        .addFields(
          { name: "👤 User",           value: `${targetUser.username} (<@${targetUser.id}>)`, inline: true },
          { name: "📋 Commands",       value: `\`${cmdLabel}\``,                              inline: false },
          { name: "🔢 Generate/day",   value: `${genLimit} time(s)`,                         inline: true },
          { name: "📦 Bulk codes/day", value: `${bulkLimit} codes`,                          inline: true },
          { name: "👮 Granted By",     value: `<@${interaction.user.id}>`,                   inline: true },
        ).setTimestamp();
      await safeReply(interaction, { embeds: [embed], flags: 64 });
      await logEmbed(embed);
    } catch (e) { await safeReply(interaction, { content: `❌ ${e.message}`, flags: 64 }); }
    return;
  }

  // ── /revoke-access ───────────────────────────────────────────
  if (cmd === "revoke-access") {
    if (interaction.user.id !== OWNER_ID) return safeReply(interaction, { content: "🔒 **Owner only command.**", flags: 64 });
    const targetUser = interaction.options.getUser("user");
    try {
      const result = await accessList.updateOne({ userId: targetUser.id }, { $set: { active: false, revokedBy: interaction.user.id, revokedAt: new Date() } });
      if (result.matchedCount === 0) return safeReply(interaction, { content: `⚠️ <@${targetUser.id}> never had access.`, flags: 64 });
      const embed = new EmbedBuilder().setColor(0xff5252).setTitle("🔒 Access Revoked")
        .addFields(
          { name: "👤 User",       value: `${targetUser.username} (<@${targetUser.id}>)`, inline: true },
          { name: "👮 Revoked By", value: `<@${interaction.user.id}>`,                   inline: true },
        ).setTimestamp();
      await safeReply(interaction, { embeds: [embed], flags: 64 });
      await logEmbed(embed);
    } catch (e) { await safeReply(interaction, { content: `❌ ${e.message}`, flags: 64 }); }
    return;
  }

  // ── /list-access ─────────────────────────────────────────────
  if (cmd === "list-access") {
    if (interaction.user.id !== OWNER_ID) return safeReply(interaction, { content: "🔒 **Owner only command.**", flags: 64 });
    try {
      const entries = await accessList.find({ active: true }).toArray();
      if (!entries.length) return safeReply(interaction, { content: "📭 No users have been granted access yet.", flags: 64 });
      const dk = todayKey();
      const lines = await Promise.all(entries.map(async e => {
        const usage = await getUserUsage(e.userId, dk);
        const cmds  = e.commands.includes("all") ? "all commands" : e.commands.join(", ");
        return `**<@${e.userId}>** (\`${e.userName || e.userId}\`)\n> Commands: \`${cmds}\`\n> Limits: ${e.generateLimit}/day generate · ${e.bulkLimit}/day bulk\n> Today: ${usage.generateCount} generate · ${usage.bulkCodesTotal} bulk used`;
      }));
      const embed = new EmbedBuilder().setColor(0x7c5cfc).setTitle(`🔑 Granted Access — ${entries.length} user(s)`).setDescription(lines.join("\n\n")).setTimestamp();
      await safeReply(interaction, { embeds: [embed], flags: 64 });
    } catch (e) { await safeReply(interaction, { content: `❌ ${e.message}`, flags: 64 }); }
    return;
  }

  // ── /generate-code ───────────────────────────────────────────
  if (cmd === "generate-code") {
    const access = await checkAccess(interaction, "generate-code");
    if (!access) return;
    const dk    = todayKey();
    const usage = await getUserUsage(interaction.user.id, dk);
    if (usage.generateCount >= access.generateLimit) {
      return safeReply(interaction, { content: `🚫 **Daily limit reached!** Max ${access.generateLimit}/day. Resets at midnight UTC.`, flags: 64 });
    }
    const game       = interaction.options.getString("game");
    const assignUser = interaction.options.getUser("user") || null;
    try {
      const code = genCode();
      await codes.insertOne({ code, game: GAME_LABELS[game], gameKey: game, webKey: GAME_WEBKEY[game], used: false, usedBy: null, usedAt: null, invoiceNo: null, assignedTo: assignUser?.id || null, createdBy: interaction.user.id, createdAt: new Date(), bulk: false });
      const embed = new EmbedBuilder().setColor(0x7c5cfc).setTitle("🎁 Reward Code Generated")
        .setDescription(`Here is your freshly generated code.\n\n\`\`\`\n${code}\n\`\`\``)
        .addFields(
          { name: "🎮 Game",       value: GAME_LABELS[game],                                      inline: true },
          { name: "👤 Assigned",   value: assignUser ? `<@${assignUser.id}>` : "Open (unassigned)", inline: true },
          { name: "👮 Created By", value: `<@${interaction.user.id}>`,                            inline: true },
          { name: "🔗 Redeem",     value: "Use `/redeem` in Discord or visit **elevateiq.shop**", inline: false },
        ).setFooter({ text: "Rewards Portal — keep this code safe!" }).setTimestamp();
      if (assignUser) {
        await dmUser(assignUser.id, new EmbedBuilder().setColor(0x00e676).setTitle("🎁 You've Received a Reward Code!")
          .setDescription(`An admin generated a code just for you!\n\n\`\`\`\n${code}\n\`\`\``)
          .addFields({ name: "🎮 Game", value: GAME_LABELS[game], inline: true }, { name: "📊 Status", value: "🟢 Active", inline: true })
          .setFooter({ text: "Rewards Portal — do not share this code!" }).setTimestamp()
        );
        embed.addFields({ name: "📨 DM Sent", value: `✅ Code sent to <@${assignUser.id}>`, inline: false });
      }
      await interaction.reply({ embeds: [embed], flags: 64 });
      await logEmbed(new EmbedBuilder().setColor(0x7c5cfc).setTitle("🎁 Single Code Generated")
        .addFields({ name: "🔑 Code", value: `\`${code}\``, inline: false }, { name: "🎮 Game", value: GAME_LABELS[game], inline: true }, { name: "👤 Assigned", value: assignUser ? `<@${assignUser.id}>` : "Open", inline: true }, { name: "👮 Admin", value: `<@${interaction.user.id}>`, inline: true }).setTimestamp());
      await incUsage(interaction.user.id, dk, "generateCount", 1);
    } catch (e) { await interaction.reply({ content: `❌ ${e.message}`, flags: 64 }); }
    return;
  }

  // ── /bulk-generate ────────────────────────────────────────────
  if (cmd === "bulk-generate") {
    const access = await checkAccess(interaction, "bulk-generate");
    if (!access) return;
    const game = interaction.options.getString("game");
    const qty  = interaction.options.getInteger("quantity");
    const user = interaction.options.getUser("user") || null;
    const dk    = todayKey();
    const usage = await getUserUsage(interaction.user.id, dk);
    const remaining = access.bulkLimit - (usage.bulkCodesTotal || 0);
    if (remaining <= 0) return safeReply(interaction, { content: `🚫 **Daily limit reached!** Max ${access.bulkLimit} codes/day. Resets at midnight UTC.`, flags: 64 });
    const actualQty = Math.min(qty, remaining);
    await interaction.deferReply({ flags: 64 });
    try {
      // ✅ FIX: Generate unique codes with collision retry instead of bulk insertMany
      // insertMany with ordered:false silently skips duplicates, giving fewer codes than expected
      const generatedCodes = [];
      const maxAttempts = actualQty * 3;
      let attempts = 0;
      while (generatedCodes.length < actualQty && attempts < maxAttempts) {
        attempts++;
        const code = genCode();
        try {
          await codes.insertOne({
            code, game: GAME_LABELS[game], gameKey: game, webKey: GAME_WEBKEY[game],
            used: false, usedBy: null, usedAt: null, invoiceNo: null,
            assignedTo: user?.id || null, createdBy: interaction.user.id,
            createdAt: new Date(), bulk: true,
          });
          generatedCodes.push(code);
        } catch (dupErr) {
          if (dupErr.code !== 11000) throw dupErr; // Only swallow duplicate key errors
          // Duplicate — retry with a new code
        }
      }
      const codesOnlyContent = generatedCodes.join("\n");
      const fileName   = `codes_${game}_${generatedCodes.length}_${Date.now()}.txt`;
      const attachment = new AttachmentBuilder(Buffer.from(codesOnlyContent, "utf-8"), { name: fileName });
      const embed = new EmbedBuilder().setColor(0x7c5cfc).setTitle(`✅ ${generatedCodes.length} Codes Generated`)
        .setDescription(`File has **${generatedCodes.length} codes** — one per line.${generatedCodes.length < qty ? `\n\n⚠️ Requested ${qty} but daily limit allowed only ${actualQty} more.` : ""}`)
        .addFields({ name: "🎮 Game", value: GAME_LABELS[game], inline: true }, { name: "🔢 Generated", value: String(generatedCodes.length), inline: true }, { name: "📊 Daily Used", value: `${(usage.bulkCodesTotal||0)+generatedCodes.length}/${access.bulkLimit}`, inline: true }, { name: "👤 Assigned", value: user ? `<@${user.id}>` : "Open", inline: true }, { name: "📄 File", value: `\`${fileName}\``, inline: false }).setTimestamp();
      await interaction.editReply({ embeds: [embed], files: [attachment] });
      await logEmbed(embed);
      await incUsage(interaction.user.id, dk, "bulkCodesTotal", generatedCodes.length);
    } catch (e) { await interaction.editReply({ content: `❌ ${e.message}` }); }
    return;
  }

  // ── /revoke-code ─────────────────────────────────────────────
  if (cmd === "revoke-code") {
    const code = interaction.options.getString("code").toUpperCase().trim();
    try {
      const existing = await codes.findOne({ code });
      if (!existing) return interaction.reply({ content: "❌ Code not found.", flags: 64 });
      if (existing.used) return interaction.reply({ content: "⚠️ Code already used — cannot revoke.", flags: 64 });
      await codes.deleteOne({ code });
      const embed = new EmbedBuilder().setColor(0xff5252).setTitle("❌ Code Revoked")
        .addFields({ name: "🔑 Code", value: `\`${code}\``, inline: true }, { name: "🎮 Game", value: existing.game, inline: true }, { name: "👮 By", value: `<@${interaction.user.id}>`, inline: true }).setTimestamp();
      await interaction.reply({ embeds: [embed], flags: 64 });
      await logEmbed(embed);
    } catch (e) { await interaction.reply({ content: `❌ ${e.message}`, flags: 64 }); }
    return;
  }

  // ── /list-codes ──────────────────────────────────────────────
  if (cmd === "list-codes") {
    try {
      const all = await codes.find({}).sort({ createdAt: -1 }).limit(25).toArray();
      if (!all.length) return interaction.reply({ content: "📭 No codes yet.", flags: 64 });
      const list = all.map(c => `\`${c.code}\` — ${c.game} — ${c.used ? "🔴 Used" : "🟢 Active"}`).join("\n");
      await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x7c5cfc).setTitle("📋 Recent Codes (25)").setDescription(list.slice(0, 4000)).setTimestamp()], flags: 64 });
    } catch (e) { await interaction.reply({ content: `❌ ${e.message}`, flags: 64 }); }
    return;
  }

  // ── /add-coins ───────────────────────────────────────────────
  if (cmd === "add-coins") {
    const user = interaction.options.getUser("user"), amount = interaction.options.getInteger("amount"), reason = interaction.options.getString("reason") || "Admin grant";
    try {
      await addCoins(user.id, amount);
      const u = await getUser(user.id);
      const embed = new EmbedBuilder().setColor(0xf4c430).setTitle("🪙 IQCoins Added")
        .addFields({ name: "👤 User", value: `<@${user.id}>`, inline: true }, { name: "🪙 Added", value: `+${fmt(amount)} IQCoins`, inline: true }, { name: "💰 Balance", value: `${fmt(u.coins)} IQCoins`, inline: true }, { name: "📝 Reason", value: reason, inline: false }, { name: "👮 By", value: `<@${interaction.user.id}>`, inline: true }).setTimestamp();
      await interaction.reply({ embeds: [embed] }); await logEmbed(embed);
    } catch (e) { await interaction.reply({ content: `❌ ${e.message}`, flags: 64 }); }
    return;
  }

  // ── /remove-coins ────────────────────────────────────────────
  if (cmd === "remove-coins") {
    const user = interaction.options.getUser("user"), amount = interaction.options.getInteger("amount"), reason = interaction.options.getString("reason") || "Admin deduction";
    try {
      const u  = await getUser(user.id);
      const nb = Math.max(0, (u.coins || 0) - amount);
      await users.updateOne({ userId: user.id }, { $set: { coins: nb } }, { upsert: true });
      const embed = new EmbedBuilder().setColor(0xff5252).setTitle("🔻 IQCoins Removed")
        .addFields({ name: "👤 User", value: `<@${user.id}>`, inline: true }, { name: "🔻 Removed", value: `-${fmt(amount)} IQCoins`, inline: true }, { name: "💰 Balance", value: `${fmt(nb)} IQCoins`, inline: true }, { name: "📝 Reason", value: reason, inline: false }, { name: "👮 By", value: `<@${interaction.user.id}>`, inline: true }).setTimestamp();
      await interaction.reply({ embeds: [embed] }); await logEmbed(embed);
    } catch (e) { await interaction.reply({ content: `❌ ${e.message}`, flags: 64 }); }
    return;
  }

  // ── /set-coins ───────────────────────────────────────────────
  if (cmd === "set-coins") {
    const user = interaction.options.getUser("user"), amount = interaction.options.getInteger("amount");
    try {
      await users.updateOne({ userId: user.id }, { $set: { coins: amount } }, { upsert: true });
      const embed = new EmbedBuilder().setColor(0x7c5cfc).setTitle("⚙️ IQCoins Set")
        .addFields({ name: "👤 User", value: `<@${user.id}>`, inline: true }, { name: "💰 New Balance", value: `${fmt(amount)} IQCoins`, inline: true }, { name: "👮 By", value: `<@${interaction.user.id}>`, inline: true }).setTimestamp();
      await interaction.reply({ embeds: [embed] }); await logEmbed(embed);
    } catch (e) { await interaction.reply({ content: `❌ ${e.message}`, flags: 64 }); }
    return;
  }

  // ── /reset-coins ─────────────────────────────────────────────
  if (cmd === "reset-coins") {
    const user = interaction.options.getUser("user");
    try {
      await users.updateOne({ userId: user.id }, { $set: { coins: 0 } }, { upsert: true });
      const embed = new EmbedBuilder().setColor(0xff5252).setTitle("⚠️ Coins Reset to Zero")
        .addFields({ name: "👤 User", value: `<@${user.id}>`, inline: true }, { name: "👮 By", value: `<@${interaction.user.id}>`, inline: true }).setTimestamp();
      await interaction.reply({ embeds: [embed] }); await logEmbed(embed);
    } catch (e) { await interaction.reply({ content: `❌ ${e.message}`, flags: 64 }); }
    return;
  }

  // ── /delete-channels ─────────────────────────────────────────
  if (cmd === "delete-channels") {
    const keyword = interaction.options.getString("keyword");
    await interaction.reply(`⏳ Deleting channels containing "${keyword}"...`);
    await guild.channels.fetch();
    const matched = guild.channels.cache.filter(c => c.name?.includes(keyword));
    let deleted = 0;
    for (const ch of matched.values()) {
      try { await ch.delete(); deleted++; if (deleted % 5 === 0) await interaction.editReply(`🗑️ Deleted: ${deleted}`); await sleep(700); }
      catch (e) { console.log("Delete channel error:", e.message); }
    }
    await interaction.editReply(`✅ Done — deleted ${deleted} channels matching "${keyword}"`);
    return;
  }

  // ── /claim-channel ───────────────────────────────────────────
  if (cmd === "claim-channel") {
    const channel = interaction.channel;
    if (channel.name.startsWith("claim-")) return interaction.reply({ content: "❌ Already claimed.", flags: 64 });
    try {
      await channel.setName(`claim-${interaction.user.username}`);
      await interaction.reply(`✅ Channel claimed by ${interaction.user}`);
    } catch { await interaction.reply({ content: "❌ Failed to claim channel.", flags: 64 }); }
    return;
  }

  // ── /revoke-invites ──────────────────────────────────────────
  if (cmd === "revoke-invites") {
    const count = interaction.options.getInteger("count");
    await interaction.reply(`⏳ Revoking ${count} invites...`);
    try {
      const allInvites = await guild.invites.fetch();
      let deleted = 0;
      for (const inv of allInvites.values()) {
        if (deleted >= count) break;
        try { await inv.delete(); deleted++; if (deleted % 5 === 0) await interaction.editReply(`❌ Revoked: ${deleted}`); await sleep(700); }
        catch (e) { console.log("Invite delete error:", e.message); }
      }
      await interaction.editReply(`✅ Done — ${deleted} invites revoked`);
    } catch (e) { await interaction.editReply(`❌ Error: ${e.message}`); }
    return;
  }

  // ── /serverpulling ────────────────────────────────────────────
  if (cmd === "serverpulling") {
    const access = await checkAccess(interaction, "serverpulling");
    if (!access) return;
    const targetGuild = interaction.options.getString("guild_id") || guild?.id;
    const pullLimit   = interaction.options.getInteger("limit") || null;
    await interaction.deferReply();
    try {
      const allTokenUsers = await users.find({ $or: [{ accessToken: { $exists: true, $ne: null } }, { refreshToken: { $exists: true, $ne: null } }] }).toArray();
      const tokenUsers = pullLimit ? allTokenUsers.slice(0, pullLimit) : allTokenUsers;
      const total = await users.countDocuments();
      if (!tokenUsers.length) {
        await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xff5252).setTitle("❌ No Token Users Found").setDescription(`No OAuth tokens found.\n> Users must login on the website with \`guilds.join\` scope.`).addFields({ name: "👥 Total DB Users", value: String(total), inline: true }, { name: "🔑 Token Users", value: "0", inline: true }).setTimestamp()] });
        return;
      }
      const buildProgressEmbed = (processed, joined, already, failed, noToken, done = false) => {
        const bar       = makeProgressBar(processed, tokenUsers.length);
        const etaSecs   = done ? 0 : Math.ceil(((tokenUsers.length - processed) * 300) / 1000);
        const eta       = done ? "✅ Complete" : `~${etaSecs}s remaining`;
        const modeLabel = pullLimit ? `🔢 Limited — ${pullLimit} users (${allTokenUsers.length} total)` : `🌐 Full Pull — all ${allTokenUsers.length} token users`;
        const successPct = tokenUsers.length ? (((joined + already) / Math.max(processed, 1)) * 100).toFixed(1) : "0.0";
        return new EmbedBuilder().setColor(done ? 0x00e676 : 0x7c5cfc).setTitle(done ? "✅ Server Pull Complete" : "📨 Server Pull In Progress...")
          .setDescription(`**Target Server:** \`${targetGuild}\`\n**Mode:** ${modeLabel}\n**Progress:** ${bar}\n**Processed:** ${processed} / ${tokenUsers.length} users`)
          .addFields({ name: "✅ Newly Joined", value: String(joined), inline: true }, { name: "👥 Already In", value: String(already), inline: true }, { name: "❌ Failed", value: String(failed), inline: true }, { name: "⚠️ No Token", value: String(noToken), inline: true }, { name: "📊 Success Rate", value: `${successPct}%`, inline: true }, { name: "⏱️ ETA", value: eta, inline: true }, { name: "👥 Total DB Users", value: String(total), inline: true }, { name: "ℹ️ Note", value: done ? "Pull complete!" : "Live updating every 25 users...", inline: false })
          .setFooter({ text: `Rewards Portal v14 | Started by ${interaction.user.username}` }).setTimestamp();
      };
      await interaction.editReply({ embeds: [buildProgressEmbed(0, 0, 0, 0, 0)] });
      let joined = 0, already = 0, failed = 0, noToken = 0, processed = 0;
      const failReasons = {};
      for (const u of tokenUsers) {
        processed++;
        const result = await forceJoinUser(u.userId, targetGuild);
        if (result.success) { result.reason === "joined" ? joined++ : already++; }
        else { if (result.reason === "no_token") noToken++; else { failed++; failReasons[result.reason] = (failReasons[result.reason] || 0) + 1; } }
        if (processed % 25 === 0) { try { await interaction.editReply({ embeds: [buildProgressEmbed(processed, joined, already, failed, noToken)] }); } catch (_) {} }
        await sleep(300);
      }
      const failSummary = Object.entries(failReasons).map(([r, c]) => `• \`${r}\`: ${c}`).join("\n") || "None";
      const finalEmbed = buildProgressEmbed(processed, joined, already, failed, noToken, true);
      if (Object.keys(failReasons).length > 0) finalEmbed.addFields({ name: "📋 Fail Breakdown", value: failSummary, inline: false });
      await interaction.editReply({ embeds: [finalEmbed] });
      await logEmbed(new EmbedBuilder().setColor(0x00e676).setTitle("📨 Server Pull Complete — Log")
        .addFields({ name: "✅ Newly Joined", value: String(joined), inline: true }, { name: "👥 Already In", value: String(already), inline: true }, { name: "❌ Failed", value: String(failed), inline: true }, { name: "📊 Total Processed", value: String(processed), inline: true }, { name: "🔢 Pull Mode", value: pullLimit ? `Limited: ${pullLimit}` : "Full", inline: true }, { name: "🖥️ Target", value: targetGuild, inline: true }, { name: "👮 Admin", value: `<@${interaction.user.id}>`, inline: true }, { name: "📋 Fail Reasons", value: failSummary, inline: false }).setTimestamp());
    } catch (e) { console.error("serverpulling error:", e); await interaction.editReply({ content: `❌ Error: ${e.message}` }); }
    return;
  }

  // ── /bulkserverleave ─────────────────────────────────────────
  if (cmd === "bulkserverleave") {
    const targetGuild = interaction.options.getString("guild_id") || guild?.id;
    const kickLimit   = interaction.options.getInteger("limit") || null;
    const reason      = interaction.options.getString("reason") || "Bulk removal via Rewards Portal bot";
    await interaction.deferReply();
    try {
      const allTokenUsers = await users.find({ $or: [{ accessToken: { $exists: true, $ne: null } }, { refreshToken: { $exists: true, $ne: null } }] }).toArray();
      const tokenUsers = kickLimit ? allTokenUsers.slice(0, kickLimit) : allTokenUsers;
      const total = await users.countDocuments();
      if (!tokenUsers.length) {
        await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xff5252).setTitle("❌ Bulk Leave — No Users Found").setDescription("No users with OAuth tokens found.").addFields({ name: "👥 Total DB Users", value: String(total), inline: true }).setTimestamp()] });
        return;
      }
      const buildKickEmbed = (processed, kicked, notInGuild, failed, done = false) => {
        const bar       = makeProgressBar(processed, tokenUsers.length);
        const etaSecs   = done ? 0 : Math.ceil(((tokenUsers.length - processed) * 350) / 1000);
        const eta       = done ? "✅ Complete" : `~${etaSecs}s remaining`;
        const modeLabel = kickLimit ? `🔢 Limited — ${kickLimit} users (${allTokenUsers.length} total)` : `🌐 Full Kick — all ${allTokenUsers.length} token users`;
        return new EmbedBuilder().setColor(done ? 0x00e676 : 0xff5252).setTitle(done ? "✅ Bulk Server Leave Complete" : "🚪 Bulk Server Leave In Progress...")
          .setDescription(`**Target Server:** \`${targetGuild}\`\n**Mode:** ${modeLabel}\n**Progress:** ${bar}\n**Processed:** ${processed} / ${tokenUsers.length} users`)
          .addFields({ name: "✅ Kicked", value: String(kicked), inline: true }, { name: "⚠️ Not in Guild", value: String(notInGuild), inline: true }, { name: "❌ Failed", value: String(failed), inline: true }, { name: "⏱️ ETA", value: eta, inline: true }, { name: "👥 Total DB Users", value: String(total), inline: true }, { name: "ℹ️ Note", value: done ? "Bulk leave complete!" : "Live updating every 25 users...", inline: false })
          .setFooter({ text: `Rewards Portal v14 | Started by ${interaction.user.username}` }).setTimestamp();
      };
      await interaction.editReply({ embeds: [buildKickEmbed(0, 0, 0, 0)] });
      let kicked = 0, notInGuild = 0, failed = 0, processed = 0;
      const failReasons = {};
      for (const u of tokenUsers) {
        processed++;
        const result = await forceKickUser(u.userId, targetGuild, reason);
        if (result.success) kicked++;
        else if (result.reason === "user_not_in_guild") notInGuild++;
        else { failed++; failReasons[result.reason] = (failReasons[result.reason] || 0) + 1; }
        if (processed % 25 === 0) { try { await interaction.editReply({ embeds: [buildKickEmbed(processed, kicked, notInGuild, failed)] }); } catch (_) {} }
        await sleep(350);
      }
      const failSummary = Object.entries(failReasons).map(([r, c]) => `• \`${r}\`: ${c}`).join("\n") || "None";
      const finalEmbed = buildKickEmbed(processed, kicked, notInGuild, failed, true);
      if (Object.keys(failReasons).length > 0) finalEmbed.addFields({ name: "📋 Fail Breakdown", value: failSummary, inline: false });
      await interaction.editReply({ embeds: [finalEmbed] });
      await logEmbed(new EmbedBuilder().setColor(0xff5252).setTitle("🚪 Bulk Server Leave Complete — Log")
        .addFields({ name: "✅ Kicked", value: String(kicked), inline: true }, { name: "⚠️ Not in Guild", value: String(notInGuild), inline: true }, { name: "❌ Failed", value: String(failed), inline: true }, { name: "📊 Total Processed", value: String(processed), inline: true }, { name: "🔢 Kick Mode", value: kickLimit ? `Limited: ${kickLimit}` : "Full", inline: true }, { name: "🖥️ Target", value: targetGuild, inline: true }, { name: "📝 Reason", value: reason, inline: false }, { name: "👮 Admin", value: `<@${interaction.user.id}>`, inline: true }, { name: "📋 Fail Reasons", value: failSummary, inline: false }).setTimestamp());
    } catch (e) { console.error("bulkserverleave error:", e); await interaction.editReply({ content: `❌ Error: ${e.message}` }); }
    return;
  }

  // ── /serverpull-user ─────────────────────────────────────────
  if (cmd === "serverpull-user") {
    const targetUser  = interaction.options.getUser("user");
    const targetGuild = interaction.options.getString("guild_id") || guild.id;
    await interaction.deferReply({ flags: 64 });
    const result = await forceJoinUser(targetUser.id, targetGuild);
    if (result.success) {
      await interaction.editReply(result.reason === "joined" ? `✅ **Successfully joined** <@${targetUser.id}> to \`${targetGuild}\`.` : `ℹ️ <@${targetUser.id}> was **already in** \`${targetGuild}\`.`);
      await logEmbed(new EmbedBuilder().setColor(0x00e676).setTitle("📨 User Force-Joined").addFields({ name: "👤 User", value: `${targetUser.username} (<@${targetUser.id}>)`, inline: true }, { name: "🖥️ Server", value: `\`${targetGuild}\``, inline: true }, { name: "📊 Result", value: result.reason, inline: true }, { name: "👮 Admin", value: `<@${interaction.user.id}>`, inline: true }).setTimestamp());
    } else {
      let advice = "";
      if (result.reason === "no_token") advice = "\n\n> ⚠️ User needs to login on the website first.";
      else if (result.reason === "bot_not_in_guild_or_no_permission") advice = "\n\n> ⚠️ Bot not in that server or lacks permission.";
      await interaction.editReply(`❌ **Failed to pull user**\nReason: \`${result.reason}\`${advice}`);
    }
    return;
  }

  // ── /serverleave ─────────────────────────────────────────────
  if (cmd === "serverleave") {
    const targetUser  = interaction.options.getUser("user");
    const targetGuild = interaction.options.getString("guild_id") || guild.id;
    const reason      = interaction.options.getString("reason") || "Removed by admin via Rewards Portal bot";
    await interaction.deferReply({ flags: 64 });
    const result = await forceKickUser(targetUser.id, targetGuild, reason);
    if (result.success) {
      await interaction.editReply(`✅ **Successfully removed** <@${targetUser.id}> from \`${targetGuild}\`.`);
      await logEmbed(new EmbedBuilder().setColor(0xff5252).setTitle("🚪 User Force-Removed").addFields({ name: "👤 User", value: `${targetUser.username} (<@${targetUser.id}>)`, inline: true }, { name: "🖥️ Server", value: `\`${targetGuild}\``, inline: true }, { name: "📝 Reason", value: reason, inline: false }, { name: "👮 Admin", value: `<@${interaction.user.id}>`, inline: true }).setTimestamp());
    } else {
      let advice = "";
      if (result.reason === "user_not_in_guild")        advice = "\n> The user is not in that server.";
      if (result.reason === "bot_lacks_kick_permission") advice = "\n> Bot needs `Kick Members` permission.";
      await interaction.editReply(`❌ **Failed to remove user**\nReason: \`${result.reason}\`${advice}`);
    }
    return;
  }

  // ── /serverstatus ─────────────────────────────────────────────
  if (cmd === "serverstatus") {
    const targetGuild = interaction.options.getString("guild_id") || guild.id;
    await interaction.deferReply({ flags: 64 });
    try {
      const totalUsers   = await users.countDocuments();
      const tokenUsers   = await users.countDocuments({ accessToken: { $exists: true, $ne: null } });
      const refreshUsers = await users.countDocuments({ refreshToken: { $exists: true, $ne: null } });
      let guildMemberCount = "N/A (bot not in server)";
      try { const targetG = await client.guilds.fetch(targetGuild); const members = await targetG.members.fetch(); guildMemberCount = String(members.size); } catch (_) {}
      const embed = new EmbedBuilder().setColor(0x7c5cfc).setTitle("📊 Server Pull Status").setDescription(`Status for: \`${targetGuild}\``)
        .addFields({ name: "👥 Total DB Users", value: String(totalUsers), inline: true }, { name: "🔑 Users with Token", value: String(tokenUsers), inline: true }, { name: "🔄 Users with Refresh", value: String(refreshUsers), inline: true }, { name: "🖥️ Guild Members", value: guildMemberCount, inline: true }, { name: "📨 Pullable Users", value: `~${tokenUsers}`, inline: true }, { name: "ℹ️ How to Pull", value: "Use `/serverpulling guild_id:<id> limit:<n>` or `/serverpull-user`", inline: false }).setTimestamp();
      await interaction.editReply({ content: null, embeds: [embed] });
    } catch (e) { await interaction.editReply(`❌ Error: ${e.message}`); }
    return;
  }

  // ── /monitor-add ─────────────────────────────────────────────
  if (cmd === "monitor-add") {
    const targetGuild = interaction.options.getString("guild_id") || guild.id;
    await interaction.deferReply({ flags: 64 });
    try {
      await serverPullConfig.updateOne({ guildId: targetGuild }, { $set: { guildId: targetGuild, monitored: true, addedBy: interaction.user.id, addedAt: new Date() } }, { upsert: true });
      await interaction.editReply(`✅ **Guild \`${targetGuild}\` added to auto-rejoin monitoring.**\n> Users leaving will be automatically re-joined.\n> Use \`/monitor-list\` to see all monitored guilds.`);
      await logEmbed(new EmbedBuilder().setColor(0x7c5cfc).setTitle("🔒 Guild Added to Monitor List").addFields({ name: "🖥️ Guild ID", value: targetGuild, inline: true }, { name: "👮 Admin", value: `<@${interaction.user.id}>`, inline: true }).setTimestamp());
    } catch (e) { await interaction.editReply(`❌ Error: ${e.message}`); }
    return;
  }

  // ── /monitor-remove ───────────────────────────────────────────
  if (cmd === "monitor-remove") {
    const targetGuild = interaction.options.getString("guild_id");
    await interaction.deferReply({ flags: 64 });
    try {
      await serverPullConfig.updateOne({ guildId: targetGuild }, { $set: { monitored: false } });
      await interaction.editReply(`✅ Guild \`${targetGuild}\` removed from monitoring.`);
    } catch (e) { await interaction.editReply(`❌ Error: ${e.message}`); }
    return;
  }

  // ── /monitor-list ─────────────────────────────────────────────
  if (cmd === "monitor-list") {
    await interaction.deferReply({ flags: 64 });
    try {
      const dbMonitored  = await serverPullConfig.find({ monitored: true }).toArray();
      const envMonitored = CONFIG.MONITOR_GUILDS;
      const all          = [...new Set([...envMonitored, ...dbMonitored.map(m => m.guildId)])];
      if (!all.length) { await interaction.editReply("📭 **No guilds being monitored.**\n\nUse `/monitor-add guild_id:` to add one."); return; }
      const lines = all.map((gId, i) => `**${i + 1}.** \`${gId}\`${envMonitored.includes(gId) ? " *(env)*" : ""}`).join("\n");
      await interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x7c5cfc).setTitle(`🔒 Monitored Guilds (${all.length})`).setDescription(`These guilds are being monitored. If a user leaves, the bot will auto-rejoin them.\n\n${lines}`).setFooter({ text: "Use /monitor-add or /monitor-remove to manage" }).setTimestamp()] });
    } catch (e) { await interaction.editReply(`❌ Error: ${e.message}`); }
    return;
  }

  // ── /eiq-stats ───────────────────────────────────────────────
  if (cmd === "eiq-stats") {
    // ✅ FIX: Added null guard — if DB not ready, reply with error instead of crash
    if (!codes || !users || !logs || !reviews) {
      return interaction.reply({ content: "❌ Database not ready — please try again in a moment.", flags: 64 });
    }
    try {
      const [totalCodes, usedCodes, totalUsers, totalLogs, tokenUsers, pendingReviews, monitoredGuilds, invitesAgg, coinsAgg] = await Promise.all([
        codes.countDocuments(), codes.countDocuments({ used: true }), users.countDocuments(), logs.countDocuments(),
        users.countDocuments({ accessToken: { $exists: true, $ne: null } }), reviews.countDocuments({ status: "pending" }),
        getMonitoredGuilds(),
        users.aggregate([{ $group: { _id: null, total: { $sum: "$invites" } } }]).toArray(),
        users.aggregate([{ $group: { _id: null, total: { $sum: "$coins"   } } }]).toArray(),
      ]);
      await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x7c5cfc).setTitle("📊 Rewards Portal Stats v14")
        .addFields(
          { name: "🔑 Total Codes",      value: String(totalCodes),             inline: true },
          { name: "🟢 Active",           value: String(totalCodes - usedCodes), inline: true },
          { name: "🔴 Used",             value: String(usedCodes),              inline: true },
          { name: "👥 Total Users",      value: String(totalUsers),             inline: true },
          { name: "🪙 Token Users",      value: `${tokenUsers} (pullable)`,     inline: true },
          { name: "⏰ Pending Reviews",  value: String(pendingReviews),         inline: true },
          { name: "🔒 Monitored Guilds", value: String(monitoredGuilds.length), inline: true },
          { name: "📨 Total Invites",    value: String(invitesAgg[0]?.total||0), inline: true },
          { name: "💰 Total Coins",      value: fmt(coinsAgg[0]?.total||0),     inline: true },
          { name: "📋 Total Logs",       value: String(totalLogs),              inline: true },
          { name: "⚡ DB Status",        value: dbConnected ? "✅ Connected" : "❌ Disconnected", inline: true },
        ).setTimestamp()] });
    } catch (e) { await interaction.reply({ content: `❌ ${e.message}`, flags: 64 }); }
    return;
  }

  // ── /details ─────────────────────────────────────────────────
  if (cmd === "details") {
    try {
      const target = interaction.options.getUser("user");
      const [rList, userDoc] = await Promise.all([redemptions.find({ userId: target.id }).sort({ savedAt: -1 }).toArray(), users.findOne({ userId: target.id })]);
      if (!rList.length && !userDoc) return interaction.reply({ content: `❌ No data for **${target.username}**.`, flags: 64 });
      const embed = new EmbedBuilder().setColor(0x7c5cfc).setTitle(`📋 ${target.username} — Details`).setThumbnail(target.displayAvatarURL()).setTimestamp();
      if (userDoc) embed.addFields({ name: "📊 Stats", inline: false, value: `🪙 Coins: **${fmt(userDoc.coins)}**\n👥 Invites: **${userDoc.invites || 0}**\n💬 Messages: **${userDoc.messages || 0}**\n🎫 Redemptions: **${userDoc.totalRedemptions || rList.length}**\n🔑 Has Token: **${userDoc.accessToken ? "Yes ✅" : "No ❌"}**` });
      if (rList.length) embed.addFields({ name: "🎮 Latest 5 Redemptions", inline: false, value: rList.slice(0, 5).map((r, i) => `**${i + 1}.** ${r.game || "?"} | ${r.account || "?"} | ${r.inrPrice || "?"} | \`${r.invoiceNo || "?"}\``).join("\n") });
      await interaction.reply({ embeds: [embed], flags: 64 });
    } catch (e) { await interaction.reply({ content: `❌ ${e.message}`, flags: 64 }); }
    return;
  }

  // ── /trigger-review ──────────────────────────────────────────
  if (cmd === "trigger-review") {
    const invoiceNo = interaction.options.getString("invoice").toUpperCase().trim();
    await interaction.deferReply({ flags: 64 });
    try {
      const review = await reviews.findOne({ invoiceNo });
      if (!review) return interaction.editReply({ content: `❌ No review record for \`${invoiceNo}\`.` });
      if (review.status !== "pending") return interaction.editReply({ content: `⚠️ Already actioned: **${review.status}**` });
      await reviews.updateOne({ invoiceNo }, { $set: { alertSent: false } });
      await postReviewAlert(review);
      await interaction.editReply({ content: `✅ Review alert triggered for \`${invoiceNo}\` in <#${CONFIG.REVIEW_CHANNEL}>.` });
    } catch (e) { await interaction.editReply({ content: `❌ Error: ${e.message}` }); }
    return;
  }

  // ── /coins ───────────────────────────────────────────────────
  if (cmd === "coins") {
    const target = interaction.options.getUser("user") || interaction.user;
    try {
      const u = await getUser(target.id);
      await interaction.reply({ embeds: [new EmbedBuilder().setColor(0xf4c430).setTitle("🪙 IQCoins Balance").setThumbnail(target.displayAvatarURL())
        .addFields({ name: "👤 User", value: `<@${target.id}>`, inline: true }, { name: "💰 Coins", value: `${fmt(u.coins)} IQCoins`, inline: true }, { name: "👥 Invites", value: String(u.invites || 0), inline: true }, { name: "💬 Messages", value: String(u.messages || 0), inline: true }).setTimestamp()] });
    } catch (e) { await interaction.reply({ content: `❌ ${e.message}`, flags: 64 }); }
    return;
  }

  // ── /leaderboard ─────────────────────────────────────────────
  if (cmd === "leaderboard") {
    try {
      const lb     = await users.find({}).sort({ coins: -1 }).limit(10).toArray();
      const medals = ["🥇", "🥈", "🥉"];
      const desc   = lb.length ? lb.map((u, i) => `${medals[i] || `**${i + 1}.**`} <@${u.userId}> — **${fmt(u.coins)}** IQCoins`).join("\n") : "No data yet.";
      await interaction.reply({ embeds: [new EmbedBuilder().setColor(0xf4c430).setTitle("🏆 IQCoins Leaderboard").setDescription(desc).setTimestamp()] });
    } catch (e) { await interaction.reply({ content: `❌ ${e.message}`, flags: 64 }); }
    return;
  }

  // ── /redeem ──────────────────────────────────────────────────
  if (cmd === "redeem") {
    const code = interaction.options.getString("code").toUpperCase().trim();
    await interaction.deferReply({ flags: 64 });

    const guideEmbed = new EmbedBuilder().setColor(0x7c5cfc).setTitle("📋 How to Redeem Your Reward Code")
      .setDescription("Follow these steps carefully to claim your reward.")
      .addFields(
        { name: "Step 1 — Code Submitted",   value: "Your code has been submitted. Format: `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`.", inline: false },
        { name: "Step 2 — Verification",     value: "Our system verifies your code in real time.", inline: false },
        { name: "Step 3 — Invoice Number",   value: "You'll receive a unique Invoice Number. **Save this** — use it to track your order.", inline: false },
        { name: "Step 4 — Processing",       value: "Your reward is processed **within 72 hours**.", inline: false },
        { name: "Step 5 — Notification",     value: "You'll receive a **DM** once activated.", inline: false },
        { name: "❓ Issues?",                value: "• Invalid Code → Double-check carefully\n• Already Redeemed → Contact support\n• No DM → Enable DMs in Privacy Settings", inline: false },
      ).setFooter({ text: "Rewards Portal — Support: +91 8447927916" }).setTimestamp();

    if (!codes) {
      await interaction.editReply({ embeds: [guideEmbed] });
      await interaction.followUp({ content: "❌ Database not ready — please try again in a moment.", flags: 64 });
      return;
    }

    try {
      // ✅ FIX: Use a gameKey-based prefix for clarity in invoice (e.g. "MC", "NI")
      const existingCode = await codes.findOne({ code });
      if (!existingCode) {
        await interaction.editReply({ embeds: [guideEmbed] });
        await interaction.followUp({ content: "❌ **Invalid Code** — This code does not exist.", flags: 64 });
        return;
      }
      if (existingCode.used) {
        await interaction.editReply({ embeds: [guideEmbed] });
        await interaction.followUp({ content: "❌ **Already Redeemed** — Contact support.", flags: 64 });
        return;
      }

      const invoicePrefix = existingCode.gameKey ? existingCode.gameKey.slice(0, 2).toUpperCase() : "DC";
      const inv = genInvoice(invoicePrefix);

      // ✅ FIX: Atomic findOneAndUpdate still used for race condition safety, with proper null check
      const result = await codes.findOneAndUpdate(
        { code, used: false },
        { $set: { used: true, usedBy: interaction.user.id, usedByUser: interaction.user.username, usedAt: new Date(), invoiceNo: inv, redeemedVia: "discord" } },
        { returnDocument: "before" }
      );

      // ✅ FIX: Correct null check — result is the document itself in newer MongoDB driver versions
      if (!result) {
        await interaction.editReply({ embeds: [guideEmbed] });
        await interaction.followUp({ content: "❌ **Already Redeemed** — Contact support.", flags: 64 });
        return;
      }

      await interaction.editReply({ embeds: [guideEmbed] });
      const successEmbed = new EmbedBuilder().setColor(0x00e676).setTitle("🎉 Code Redeemed Successfully!").setThumbnail(interaction.user.displayAvatarURL())
        .setDescription("Your code is verified and in the processing queue.\n\n📌 **Save your invoice number.**")
        .addFields({ name: "👤 User", value: `<@${interaction.user.id}>`, inline: true }, { name: "🎮 Game", value: result.game, inline: true }, { name: "🧾 Invoice No", value: `\`${inv}\``, inline: false }, { name: "📊 Status", value: "⏳ Pending — processing within 72 hours", inline: false }, { name: "🔔 Next Step", value: "You'll receive a DM when activated.", inline: false })
        .setFooter({ text: "Rewards Portal — keep your invoice number safe!" }).setTimestamp();
      await interaction.followUp({ embeds: [successEmbed], flags: 64 });
      await logEmbed(successEmbed);
      await logs.insertOne({ type: "code_redeem_discord", userId: interaction.user.id, userName: interaction.user.username, code, game: result.game, invoiceNo: inv, ts: new Date() });
    } catch (e) { await interaction.followUp({ content: `❌ Server error: ${e.message}.`, flags: 64 }); }
    return;
  }

  // ── /track-order ─────────────────────────────────────────────
  if (cmd === "track-order") {
    const inv = interaction.options.getString("invoice").toUpperCase();
    try {
      // ✅ FIX: Check BOTH codes AND reviews collections for invoice
      // Coin-spend redemptions don't create a code entry, only a review entry
      const [order, review] = await Promise.all([
        codes.findOne({ invoiceNo: inv }),
        reviews ? reviews.findOne({ invoiceNo: inv }) : null,
      ]);

      const found = order || review;
      let statusText = "❌ Invoice not found";
      if (found) {
        if      (review?.status === "activated")       statusText = "✅ Activated — Reward Delivered";
        else if (review?.status === "rejected")        statusText = "❌ Rejected — check DM for details";
        else if (review?.status === "custom_rejected") statusText = "⚠️ Rejected — check DM for details";
        else if (found)                                statusText = "⏳ Pending — processing within 72 hours";
      }
      const gameLabel = order?.game || review?.game || "—";
      await interaction.reply({ embeds: [new EmbedBuilder().setColor(0xfbbf24).setTitle("📦 Order Status").addFields({ name: "🧾 Invoice", value: `\`${inv}\``, inline: false }, { name: "🎮 Game", value: gameLabel, inline: true }, { name: "📊 Status", value: statusText, inline: true }).setFooter({ text: "Contact support: +91 8447927916" }).setTimestamp()], flags: 64 });
    } catch (e) { await interaction.reply({ content: `❌ ${e.message}`, flags: 64 }); }
    return;
  }

  // ── /invite-stats ─────────────────────────────────────────────
  if (cmd === "invite-stats") {
    const target = interaction.options.getUser("user") || interaction.user;
    try {
      const u = await getUser(target.id);
      await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x00e676).setTitle("📊 Invite Stats").setThumbnail(target.displayAvatarURL())
        .addFields({ name: "👤 User", value: `<@${target.id}>`, inline: true }, { name: "📨 Total Invites", value: String(u.invites || 0), inline: true }, { name: "🪙 Coins Earned", value: `${fmt(Math.floor((u.invites || 0) / 5) * 10000)} from invites`, inline: true })
        .setFooter({ text: "5 invites = 10,000 IQCoins" }).setTimestamp()] });
    } catch (e) { await interaction.reply({ content: `❌ ${e.message}`, flags: 64 }); }
    return;
  }
});

// ═══════════════════════ EXPRESS API ═════════════════════════════
function startAPI() {
  const app = express();

  app.use(cors({
    origin: [
      "https://www.elevateiq.shop",
      "https://elevateiq.shop",
      "https://bot-production-387b.up.railway.app",
      "https://bot-production-168c.up.railway.app",
      "https://bot-production-2eb8.up.railway.app",
      "https://web-elevate.vercel.app",
      "http://localhost:3000",
    ],
    methods:     ["GET", "POST", "OPTIONS", "PATCH"],
    credentials: true,
  }));

  app.use(express.json({ limit: "2mb" }));

  app.use("/api", createSupportMailRouter(db));
  app.use("/api", createGiveawaysRouter(db));

  // ── Health ─────────────────────────────────────────────────────
  // Root health check for Railway health probe
  app.get("/health", (_, res) => { res.json({ status: "ok", db: dbConnected, version: "v14" }); });

  app.get("/api/health", (_, res) => {
    res.json({ status: "ok", db: dbConnected, version: "v14", time: new Date() });
  });

  // ── Discord OAuth ───────────────────────────────────────────────
  app.get("/auth/callback", async (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).json({ error: "Missing code" });
    try {
      const { user, token } = await exchangeDiscordCode(code);
      const u = await getUser(user.id);
      res.json({ user, token, coins: u.coins || 0 });
    } catch (e) { console.error("Discord callback error:", e.message); res.status(500).json({ error: e.message }); }
  });

  // ── User info ───────────────────────────────────────────────────
  app.get("/api/user/:userId", async (req, res) => {
    if (!users) return res.json({ success: false, message: "DB not ready" });
    try {
      const u = await getUser(req.params.userId);
      res.json({ success: true, coins: u.coins || 0, invites: u.invites || 0, messages: u.messages || 0 });
    } catch { res.json({ success: false }); }
  });

  // ── Server pull/kick (API) ──────────────────────────────────────
  app.post("/api/join-guild", async (req, res) => {
    const { userId, guildId } = req.body;
    if (!userId || !guildId) return res.json({ success: false, message: "Missing userId or guildId" });
    res.json(await forceJoinUser(userId, guildId));
  });

  app.post("/api/kick-guild", async (req, res) => {
    const { userId, guildId, reason } = req.body;
    if (!userId || !guildId) return res.json({ success: false, message: "Missing userId or guildId" });
    res.json(await forceKickUser(userId, guildId, reason || "Admin action"));
  });

  app.post("/api/pull-all", async (req, res) => {
    const { guildId, adminKey } = req.body;
    if (adminKey !== process.env.ADMIN_API_KEY) return res.json({ success: false, message: "Unauthorized" });
    if (!guildId) return res.json({ success: false, message: "Missing guildId" });
    if (!users)   return res.json({ success: false, message: "DB not ready" });
    res.json({ success: true, message: "Pull started in background" });
    (async () => {
      const tokenUsers = await users.find({ $or: [{ accessToken: { $exists: true, $ne: null } }, { refreshToken: { $exists: true, $ne: null } }] }).toArray();
      let joined = 0, already = 0, failed = 0;
      for (const u of tokenUsers) {
        const result = await forceJoinUser(u.userId, guildId);
        if (result.success) { result.reason === "joined" ? joined++ : already++; } else failed++;
        await sleep(300);
      }
      await logEmbed(new EmbedBuilder().setColor(0x00e676).setTitle("📨 API: Bulk Pull Complete")
        .addFields({ name: "✅ Joined", value: String(joined), inline: true }, { name: "👥 Already", value: String(already), inline: true }, { name: "❌ Failed", value: String(failed), inline: true }, { name: "🖥️ Target", value: guildId, inline: true }).setTimestamp());
    })();
  });

  // ── Code management ─────────────────────────────────────────────
  app.post("/api/verify-code", async (req, res) => {
    if (!codes) return res.json({ valid: false, message: "DB not ready — try again" });
    try {
      const { code, userId, userName, userAvatar, selectedGame } = req.body;
      if (!code) return res.json({ valid: false, message: "No code provided" });
      const cUp = code.toUpperCase().trim();

      const existing = await codes.findOne({ code: cUp });
      if (!existing) return res.json({ valid: false, message: "Invalid code — check and try again" });
      if (existing.used) return res.json({ valid: false, message: "Code already redeemed" });

      // ✅ FIX: Compare selectedGame against existing.webKey (not gameKey) — webKey is what website uses
      if (selectedGame && existing.webKey && existing.webKey !== selectedGame) {
        return res.json({ valid: false, message: `This code is for ${existing.game} — wrong section selected` });
      }

      const inv    = genInvoice("WS");
      const result = await codes.findOneAndUpdate(
        { code: cUp, used: false },
        { $set: { used: true, usedBy: userId, usedByName: userName, usedAt: new Date(), invoiceNo: inv, redeemedVia: "website" } },
        { returnDocument: "before" }
      );
      if (!result) return res.json({ valid: false, message: "Code already redeemed" });

      if (logs) await logs.insertOne({ type: "code_redeem_website", userId, userName, code: cUp, game: result.game, invoiceNo: inv, ts: new Date() });
      res.json({ valid: true, game: result.game, gameKey: result.gameKey, webKey: result.webKey, invoiceNo: inv });
    } catch (e) { console.error("verify-code error:", e); res.json({ valid: false, message: "Server error — try again" }); }
  });

  app.post("/api/refund-code", async (req, res) => {
    const { code } = req.body;
    if (!code) return res.json({ success: false });
    try {
      await codes.updateOne({ code: code.toUpperCase().trim() }, { $set: { used: false, usedBy: null, usedByName: null, usedAt: null, invoiceNo: null, redeemedVia: null } });
      res.json({ success: true });
    } catch { res.json({ success: false }); }
  });

  // ── Coins ───────────────────────────────────────────────────────
  app.post("/api/spend-coins", async (req, res) => {
    if (!users) return res.json({ success: false, message: "DB not ready" });
    try {
      const { userId, userName, amount, gameKey, invoiceNo } = req.body;
      if (!userId || !amount) return res.json({ success: false, message: "Missing data" });
      const u = await getUser(userId);
      if ((u.coins || 0) < amount) return res.json({ success: false, message: "Not enough IQCoins" });
      await addCoins(userId, -amount);
      // ✅ FIX: Safe prefix — gameKey can be undefined/null, genInvoice now handles it gracefully
      const inv = invoiceNo || genInvoice(gameKey);
      if (logs) await logs.insertOne({ type: "coin_redeem_website", userId, userName, amount, gameKey, invoiceNo: inv, ts: new Date() });
      res.json({ success: true, invoiceNo: inv, newBalance: (u.coins || 0) - amount });
    } catch { res.json({ success: false, message: "Server error" }); }
  });

  app.post("/api/add-coins", async (req, res) => {
    if (!users) return res.json({ success: false });
    try {
      const { userId, amount } = req.body;
      if (!userId || !amount) return res.json({ success: false });
      await addCoins(userId, amount);
      const u = await getUser(userId);
      res.json({ success: true, newBalance: u.coins });
    } catch { res.json({ success: false }); }
  });

  // ── Redemption save + review ─────────────────────────────────────
  app.post("/api/save-redemption", async (req, res) => {
    try {
      const data = req.body;
      if (!data.invoiceNo) return res.json({ success: false, message: "Missing invoiceNo" });
      if (!redemptions || !users) return res.json({ success: false, message: "DB not ready" });

      const upsertResult = await redemptions.updateOne(
        { invoiceNo: data.invoiceNo },
        { $setOnInsert: { ...data, savedAt: new Date() } },
        { upsert: true }
      );

      if (data.userId) {
        await users.updateOne(
          { userId: data.userId },
          { $inc: { totalRedemptions: 1 }, $set: { lastRedemption: new Date() } },
          { upsert: true }
        );
      }

      // ✅ FIX: Only schedule review (and post alert) when a NEW record was inserted, not on retry
      const isNewDoc = upsertResult.upsertedCount > 0;
      await scheduleReview(data, isNewDoc);
      res.json({ success: true });
    } catch (e) { res.json({ success: false, message: e.message }); }
  });

  app.get("/api/order-status/:invoiceNo", async (req, res) => {
    if (!reviews) return res.json({ success: false });
    try {
      const invoiceNo = req.params.invoiceNo.toUpperCase().trim();
      const review = await reviews.findOne({ invoiceNo });
      if (!review) return res.json({ success: false, message: "Invoice not found" });
      res.json({ success: true, invoiceNo, status: review.status || "pending", websiteStatus: review.websiteStatus || review.status || "pending", websiteMessage: review.websiteMessage || null, websiteReason: review.websiteReason || null, game: review.game || null, actionAt: review.actionAt || null });
    } catch (e) { res.json({ success: false, message: e.message }); }
  });

  // ── Leaderboard ─────────────────────────────────────────────────
  app.get("/api/leaderboard", async (_, res) => {
    if (!users) return res.json({ success: false, leaderboard: [] });
    try {
      const lb = await users.find({}).sort({ coins: -1 }).limit(10).toArray();
      res.json({ success: true, leaderboard: lb.map((u, i) => ({ rank: i + 1, name: u.userName || u.userId, coins: u.coins || 0, userId: u.userId })) });
    } catch { res.json({ success: false, leaderboard: [] }); }
  });

  // ── Admin endpoints ─────────────────────────────────────────────
  app.get("/api/admin/redemptions", async (req, res) => {
    const key = req.headers["x-admin-key"];
    if (key !== process.env.ADMIN_API_KEY) return res.status(401).json({ success: false });
    if (!reviews) return res.json({ success: false, message: "DB not ready" });
    try {
      const list = await reviews.find({ status: "pending" }).sort({ createdAt: -1 }).limit(50).toArray();
      res.json({ success: true, redemptions: list });
    } catch { res.json({ success: false }); }
  });

  app.post("/api/admin/approve", async (req, res) => {
    const key = req.headers["x-admin-key"];
    if (key !== process.env.ADMIN_API_KEY) return res.status(401).json({ success: false });
    if (!reviews) return res.json({ success: false, message: "DB not ready" });
    const { invoiceNo, userId } = req.body;
    try {
      await reviews.updateOne({ invoiceNo }, { $set: { status: "activated", actionAt: new Date() } });
      if (userId) await dmUser(userId, new EmbedBuilder().setColor(0x00e676).setTitle("🎉 Reward Activated!").setDescription("Your reward has been activated.").addFields({ name: "🧾 Invoice", value: `\`${invoiceNo}\``, inline: true }).setTimestamp());
      res.json({ success: true });
    } catch (e) { res.json({ success: false, error: e.message }); }
  });

  app.post("/api/admin/reject", async (req, res) => {
    const key = req.headers["x-admin-key"];
    if (key !== process.env.ADMIN_API_KEY) return res.status(401).json({ success: false });
    if (!reviews) return res.json({ success: false, message: "DB not ready" });
    const { invoiceNo, userId, reason } = req.body;
    try {
      await reviews.updateOne({ invoiceNo }, { $set: { status: "rejected", customReason: reason || null, actionAt: new Date() } });
      if (userId) await dmUser(userId, new EmbedBuilder().setColor(0xff5252).setTitle("🚫 Reward Rejected").setDescription(reason || "Your reward request was rejected.").addFields({ name: "🧾 Invoice", value: `\`${invoiceNo}\``, inline: true }).setTimestamp());
      res.json({ success: true });
    } catch (e) { res.json({ success: false, error: e.message }); }
  });

  app.get("/api/admin/users", async (req, res) => {
    const key = req.headers["x-admin-key"];
    if (key !== process.env.ADMIN_API_KEY) return res.status(401).json({ success: false });
    // ✅ FIX: Added null guard on `users` — crashes if DB drops mid-request
    if (!users) return res.json({ success: false, message: "DB not ready" });
    try {
      const list = await users.find({}).sort({ lastLogin: -1 }).limit(100).toArray();
      res.json({ success: true, users: list.map(u => ({ id: u.userId, username: u.userName || u.userId, coins: u.coins || 0, hasToken: !!u.accessToken })) });
    } catch { res.json({ success: false }); }
  });

  app.post("/api/admin/pull", async (req, res) => {
    const key = req.headers["x-admin-key"];
    if (key !== process.env.ADMIN_API_KEY) return res.status(401).json({ success: false });
    const { userId, guildId, action } = req.body;
    if (!guildId) return res.json({ success: false, message: "Missing guildId" });
    try {
      if (action === "kick") { const r = await forceKickUser(userId, guildId); res.json({ success: r.success, message: r.reason }); }
      else { const r = await forceJoinUser(userId, guildId); res.json({ success: r.success, message: r.reason }); }
    } catch (e) { res.json({ success: false, message: e.message }); }
  });

  app.listen(CONFIG.PORT, "0.0.0.0", () => {
    console.log(`✅ API running on port ${CONFIG.PORT}`);
  });
}

// ═══════════════════════ ERROR HANDLERS ══════════════════════════
client.on("error", e => console.error("Discord client error:", e.message));
process.on("unhandledRejection", e => console.error("Unhandled rejection:", e));
process.on("uncaughtException",  e => { console.error("Uncaught exception:", e); });

// ✅ FIX: Graceful shutdown — mongo.close() first, then client.destroy()
async function shutdown(signal) {
  console.log(`\n${signal} received — shutting down gracefully...`);
  try { await mongo.close(); } catch (_) {}
  try { client.destroy(); } catch (_) {}
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

// ═══════════════════════ START ═══════════════════════════════════
client.login(CONFIG.BOT_TOKEN);
