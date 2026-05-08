// routes/giveaways.js
// Mount this in your main file as:
//   import { createGiveawaysRouter } from "./routes/giveaways.js";
//   app.use("/api", createGiveawaysRouter(db));
//
// This gives you:
//   PUBLIC  GET    /api/giveaways                        — list active giveaways
//   PUBLIC  GET    /api/giveaways/:giveawayId            — get single giveaway
//   PUBLIC  POST   /api/giveaways/:giveawayId/enter      — user enters a giveaway
//   ADMIN   POST   /api/admin/giveaways                  — create a giveaway
//   ADMIN   POST   /api/admin/giveaways/:giveawayId/end  — end & pick winners
//   ADMIN   POST   /api/admin/giveaways/:giveawayId/reroll — reroll winners
//   ADMIN   DELETE /api/admin/giveaways/:giveawayId      — delete/cancel giveaway

import { Router } from "express";
import { requireAdmin } from "../middleware/adminAuth.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeId() {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

function pickWinners(entries, count) {
  const pool = [...entries];
  const winners = [];
  while (winners.length < count && pool.length > 0) {
    const idx = Math.floor(Math.random() * pool.length);
    winners.push(pool.splice(idx, 1)[0]);
  }
  return winners;
}

// ─── factory ──────────────────────────────────────────────────────────────────

export function createGiveawaysRouter(db) {
  const router     = Router();
  const giveaways  = db.collection("giveaways");

  // Indexes — safe to run multiple times
  async function ensureIndexes() {
    await Promise.all([
      giveaways.createIndex({ giveawayId: 1 }, { unique: true }),
      giveaways.createIndex({ status: 1 }),
      giveaways.createIndex({ endsAt: 1 }),
      giveaways.createIndex({ createdAt: -1 }),
    ]);
  }
  ensureIndexes().catch(e => console.error("giveaways index error:", e.message));

  // ═══════════════════════════════════════════════════════════════
  // PUBLIC — GET /api/giveaways
  // Returns all active (and recently ended) giveaways.
  // ═══════════════════════════════════════════════════════════════
  router.get("/giveaways", async (req, res) => {
    try {
      const { status = "active" } = req.query;
      const filter = {};
      if (status !== "all") filter.status = status;

      const list = await giveaways
        .find(filter, { projection: { entries: 0 } }) // hide entry list from public
        .sort({ createdAt: -1 })
        .limit(50)
        .toArray();

      res.json({ success: true, giveaways: list });
    } catch (e) {
      console.error("GET /api/giveaways error:", e.message);
      res.status(500).json({ success: false, message: "Server error." });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // PUBLIC — GET /api/giveaways/:giveawayId
  // Returns a single giveaway (entry list hidden).
  // ═══════════════════════════════════════════════════════════════
  router.get("/giveaways/:giveawayId", async (req, res) => {
    try {
      const doc = await giveaways.findOne(
        { giveawayId: req.params.giveawayId },
        { projection: { entries: 0 } }
      );
      if (!doc) return res.status(404).json({ success: false, message: "Giveaway not found." });
      res.json({ success: true, giveaway: doc });
    } catch (e) {
      console.error("GET /api/giveaways/:id error:", e.message);
      res.status(500).json({ success: false, message: "Server error." });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // PUBLIC — POST /api/giveaways/:giveawayId/enter
  // Body: { userId, userName, userAvatar }
  // Adds user to entries if not already entered.
  // ═══════════════════════════════════════════════════════════════
  router.post("/giveaways/:giveawayId/enter", async (req, res) => {
    const { userId, userName, userAvatar } = req.body;

    if (!userId?.trim())   return res.status(400).json({ success: false, message: "userId is required." });
    if (!userName?.trim()) return res.status(400).json({ success: false, message: "userName is required." });

    try {
      const doc = await giveaways.findOne({ giveawayId: req.params.giveawayId });
      if (!doc)                    return res.status(404).json({ success: false, message: "Giveaway not found." });
      if (doc.status !== "active") return res.status(400).json({ success: false, message: "This giveaway is no longer active." });
      if (doc.endsAt && new Date() > new Date(doc.endsAt)) {
        return res.status(400).json({ success: false, message: "This giveaway has already ended." });
      }

      const alreadyIn = (doc.entries || []).some(e => e.userId === userId.trim());
      if (alreadyIn) return res.status(409).json({ success: false, message: "You have already entered this giveaway." });

      const entry = {
        userId:     userId.trim(),
        userName:   userName.trim(),
        userAvatar: userAvatar?.trim() || null,
        enteredAt:  new Date(),
      };

      await giveaways.updateOne(
        { giveawayId: req.params.giveawayId },
        { $push: { entries: entry }, $inc: { entryCount: 1 } }
      );

      res.json({ success: true, message: "You have been entered into the giveaway! Good luck 🎉" });
    } catch (e) {
      console.error("POST /api/giveaways/:id/enter error:", e.message);
      res.status(500).json({ success: false, message: "Server error." });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // ADMIN — POST /api/admin/giveaways
  // Body: { prize, description, winnerCount, endsAt, createdBy }
  // Creates a new giveaway.
  // ═══════════════════════════════════════════════════════════════
  router.post("/admin/giveaways", requireAdmin, async (req, res) => {
    const { prize, description, winnerCount = 1, endsAt, createdBy } = req.body;

    if (!prize?.trim()) return res.status(400).json({ success: false, message: "Prize is required." });
    if (prize.trim().length > 300) return res.status(400).json({ success: false, message: "Prize too long (max 300 chars)." });

    const winners = parseInt(winnerCount);
    if (isNaN(winners) || winners < 1 || winners > 100) {
      return res.status(400).json({ success: false, message: "winnerCount must be between 1 and 100." });
    }

    let endsAtDate = null;
    if (endsAt) {
      endsAtDate = new Date(endsAt);
      if (isNaN(endsAtDate.getTime())) return res.status(400).json({ success: false, message: "Invalid endsAt date." });
      if (endsAtDate <= new Date())    return res.status(400).json({ success: false, message: "endsAt must be in the future." });
    }

    try {
      const giveaway = {
        giveawayId:  makeId(),
        prize:       prize.trim(),
        description: description?.trim() || null,
        winnerCount: winners,
        endsAt:      endsAtDate,
        status:      "active",
        entries:     [],
        entryCount:  0,
        winners:     [],
        createdBy:   createdBy?.trim() || null,
        createdAt:   new Date(),
        updatedAt:   new Date(),
      };

      await giveaways.insertOne(giveaway);
      const { entries: _e, ...publicGiveaway } = giveaway;
      res.status(201).json({ success: true, message: "Giveaway created!", giveaway: publicGiveaway });
    } catch (e) {
      console.error("POST /api/admin/giveaways error:", e.message);
      res.status(500).json({ success: false, message: "Server error." });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // ADMIN — POST /api/admin/giveaways/:giveawayId/end
  // Ends the giveaway and picks random winners.
  // ═══════════════════════════════════════════════════════════════
  router.post("/admin/giveaways/:giveawayId/end", requireAdmin, async (req, res) => {
    try {
      const doc = await giveaways.findOne({ giveawayId: req.params.giveawayId });
      if (!doc)                    return res.status(404).json({ success: false, message: "Giveaway not found." });
      if (doc.status === "ended")  return res.status(400).json({ success: false, message: "Giveaway already ended." });
      if (doc.status === "cancelled") return res.status(400).json({ success: false, message: "Giveaway was cancelled." });

      const wonBy = pickWinners(doc.entries || [], doc.winnerCount);

      await giveaways.updateOne(
        { giveawayId: req.params.giveawayId },
        { $set: { status: "ended", winners: wonBy, endedAt: new Date(), updatedAt: new Date() } }
      );

      res.json({
        success: true,
        message: wonBy.length > 0
          ? `Giveaway ended! ${wonBy.length} winner(s) selected.`
          : "Giveaway ended — no entries to pick from.",
        winners: wonBy,
      });
    } catch (e) {
      console.error("POST /api/admin/giveaways/:id/end error:", e.message);
      res.status(500).json({ success: false, message: "Server error." });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // ADMIN — POST /api/admin/giveaways/:giveawayId/reroll
  // Rerolls winners for an already-ended giveaway.
  // ═══════════════════════════════════════════════════════════════
  router.post("/admin/giveaways/:giveawayId/reroll", requireAdmin, async (req, res) => {
    try {
      const doc = await giveaways.findOne({ giveawayId: req.params.giveawayId });
      if (!doc)                   return res.status(404).json({ success: false, message: "Giveaway not found." });
      if (doc.status !== "ended") return res.status(400).json({ success: false, message: "Only ended giveaways can be rerolled." });

      const wonBy = pickWinners(doc.entries || [], doc.winnerCount);

      await giveaways.updateOne(
        { giveawayId: req.params.giveawayId },
        { $set: { winners: wonBy, rerolledAt: new Date(), updatedAt: new Date() } }
      );

      res.json({
        success: true,
        message: `Rerolled! ${wonBy.length} new winner(s) selected.`,
        winners: wonBy,
      });
    } catch (e) {
      console.error("POST /api/admin/giveaways/:id/reroll error:", e.message);
      res.status(500).json({ success: false, message: "Server error." });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // ADMIN — DELETE /api/admin/giveaways/:giveawayId
  // Cancels (soft-deletes) a giveaway.
  // ═══════════════════════════════════════════════════════════════
  router.delete("/admin/giveaways/:giveawayId", requireAdmin, async (req, res) => {
    try {
      const doc = await giveaways.findOne({ giveawayId: req.params.giveawayId });
      if (!doc) return res.status(404).json({ success: false, message: "Giveaway not found." });

      await giveaways.updateOne(
        { giveawayId: req.params.giveawayId },
        { $set: { status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() } }
      );

      res.json({ success: true, message: "Giveaway cancelled." });
    } catch (e) {
      console.error("DELETE /api/admin/giveaways/:id error:", e.message);
      res.status(500).json({ success: false, message: "Server error." });
    }
  });

  return router;
}
