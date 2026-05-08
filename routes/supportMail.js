// routes/supportMail.js
// Mount this in your main file as:
//   import supportMailRouter from "./routes/supportMail.js";
//   app.use("/api", supportMailRouter);
//
// This gives you:
//   PUBLIC  POST   /api/support-mail              — user creates a ticket
//   PUBLIC  GET    /api/support-mail/:ticketId    — user checks their ticket
//   PUBLIC  POST   /api/support-mail/:ticketId/reply — user replies to their ticket
//   ADMIN   GET    /api/admin/support-mail        — list all tickets (with filters)
//   ADMIN   GET    /api/admin/support-mail/:ticketId  — single ticket detail
//   ADMIN   POST   /api/admin/support-mail/:ticketId/reply — admin replies
//   ADMIN   PATCH  /api/admin/support-mail/:ticketId/status — change status
//   ADMIN   PATCH  /api/admin/support-mail/:ticketId/assign — assign to admin

import { Router }                         from "express";
import { requireAdmin }                   from "../middleware/adminAuth.js";
import { buildTicket, buildReply,
         TICKET_STATUS, TICKET_PRIORITY } from "../models/ticket.js";

// ─── db reference ──────────────────────────────────────────────────────────
// We pass `db` in via a factory function so the router doesn't import
// the MongoClient directly — keeps it compatible with your existing setup.
export function createSupportMailRouter(db) {
  const router  = Router();
  const tickets = db.collection("support_tickets");

  // Run once when server starts — safe to call multiple times (idempotent).
  async function ensureIndexes() {
    await Promise.all([
      tickets.createIndex({ ticketId: 1 },  { unique: true }),
      tickets.createIndex({ userId:   1 }),
      tickets.createIndex({ status:   1 }),
      tickets.createIndex({ priority: 1 }),
      tickets.createIndex({ createdAt: -1 }),
    ]);
  }
  ensureIndexes().catch(e => console.error("support_tickets index error:", e.message));

  // ═══════════════════════════════════════════════════════════════
  // PUBLIC — POST /api/support-mail
  // User submits a new support ticket.
  // Body: { userId, userName, userAvatar, subject, message, category, priority }
  // ═══════════════════════════════════════════════════════════════
  router.post("/support-mail", async (req, res) => {
    const { userId, userName, userAvatar, subject, message, category, priority } = req.body;

    // ── validation ──────────────────────────────────────────────
    if (!subject?.trim()) return res.status(400).json({ success: false, message: "Subject is required." });
    if (!message?.trim()) return res.status(400).json({ success: false, message: "Message is required." });
    if (subject.trim().length < 5)  return res.status(400).json({ success: false, message: "Subject too short (min 5 chars)." });
    if (message.trim().length < 10) return res.status(400).json({ success: false, message: "Message too short (min 10 chars)." });
    if (subject.trim().length > 200) return res.status(400).json({ success: false, message: "Subject too long (max 200 chars)." });
    if (message.trim().length > 5000) return res.status(400).json({ success: false, message: "Message too long (max 5000 chars)." });

    const validCategories = ["general", "billing", "technical", "account", "reward", "other"];
    const validPriorities = Object.values(TICKET_PRIORITY);
    if (category  && !validCategories.includes(category))  return res.status(400).json({ success: false, message: "Invalid category." });
    if (priority  && !validPriorities.includes(priority))  return res.status(400).json({ success: false, message: "Invalid priority." });

    try {
      const ticket = buildTicket({ userId, userName, userAvatar, subject, message, category, priority });
      await tickets.insertOne(ticket);

      // Optional: notify admin Discord channel here if you want
      // await logEmbed(...)  — import logEmbed or pass it in

      return res.status(201).json({
        success:  true,
        ticketId: ticket.ticketId,
        message:  "Ticket created successfully. Use your ticket ID to track progress.",
      });
    } catch (e) {
      console.error("support-mail create error:", e.message);
      return res.status(500).json({ success: false, message: "Server error. Please try again." });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // PUBLIC — GET /api/support-mail/:ticketId
  // User checks their own ticket status + messages.
  // Optionally pass ?userId= to verify ownership.
  // ═══════════════════════════════════════════════════════════════
  router.get("/support-mail/:ticketId", async (req, res) => {
    const { ticketId } = req.params;
    const { userId }   = req.query; // optional ownership check

    try {
      const ticket = await tickets.findOne({ ticketId: ticketId.toUpperCase() });
      if (!ticket) return res.status(404).json({ success: false, message: "Ticket not found." });

      // If userId is provided, verify ownership (don't expose other users' tickets)
      if (userId && ticket.userId && ticket.userId !== userId) {
        return res.status(403).json({ success: false, message: "Access denied." });
      }

      return res.json({
        success:   true,
        ticketId:  ticket.ticketId,
        subject:   ticket.subject,
        category:  ticket.category,
        priority:  ticket.priority,
        status:    ticket.status,
        messages:  ticket.messages,
        createdAt: ticket.createdAt,
        updatedAt: ticket.updatedAt,
      });
    } catch (e) {
      console.error("support-mail get error:", e.message);
      return res.status(500).json({ success: false, message: "Server error." });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // PUBLIC — POST /api/support-mail/:ticketId/reply
  // User adds a reply to their own ticket.
  // Body: { userId, userName, message }
  // ═══════════════════════════════════════════════════════════════
  router.post("/support-mail/:ticketId/reply", async (req, res) => {
    const { ticketId }             = req.params;
    const { userId, userName, message } = req.body;

    if (!message?.trim()) return res.status(400).json({ success: false, message: "Reply message is required." });
    if (message.trim().length > 5000) return res.status(400).json({ success: false, message: "Message too long." });

    try {
      const ticket = await tickets.findOne({ ticketId: ticketId.toUpperCase() });
      if (!ticket) return res.status(404).json({ success: false, message: "Ticket not found." });
      if (ticket.status === TICKET_STATUS.CLOSED) {
        return res.status(400).json({ success: false, message: "This ticket is closed. Please open a new ticket." });
      }

      const reply = buildReply({ from: "user", senderId: userId, senderName: userName, content: message });
      await tickets.updateOne(
        { ticketId: ticketId.toUpperCase() },
        {
          $push: { messages: reply },
          $set:  {
            status:    TICKET_STATUS.OPEN, // reopens if it was resolved
            updatedAt: new Date(),
          },
        }
      );

      return res.json({ success: true, message: "Reply sent." });
    } catch (e) {
      console.error("support-mail user reply error:", e.message);
      return res.status(500).json({ success: false, message: "Server error." });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // ADMIN — GET /api/admin/support-mail
  // List all tickets with optional filters.
  // Query params: status, priority, category, userId, page, limit
  // Headers: x-admin-key
  // ═══════════════════════════════════════════════════════════════
  router.get("/admin/support-mail", requireAdmin, async (req, res) => {
    const {
      status,
      priority,
      category,
      userId,
      page  = "1",
      limit = "20",
    } = req.query;

    const filter = {};
    if (status)   filter.status   = status;
    if (priority) filter.priority = priority;
    if (category) filter.category = category;
    if (userId)   filter.userId   = userId;

    const pageNum  = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip     = (pageNum - 1) * limitNum;

    try {
      const [ticketList, total] = await Promise.all([
        tickets
          .find(filter)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limitNum)
          .toArray(),
        tickets.countDocuments(filter),
      ]);

      // Strip full message thread from list view — only return the first message preview
      const list = ticketList.map(t => ({
        ticketId:    t.ticketId,
        subject:     t.subject,
        category:    t.category,
        priority:    t.priority,
        status:      t.status,
        userId:      t.userId,
        userName:    t.userName,
        userAvatar:  t.userAvatar,
        assignedTo:  t.assignedTo,
        messageCount: t.messages?.length || 0,
        lastMessage: t.messages?.at(-1)?.content?.slice(0, 100) || "",
        createdAt:   t.createdAt,
        updatedAt:   t.updatedAt,
      }));

      return res.json({
        success: true,
        total,
        page:    pageNum,
        pages:   Math.ceil(total / limitNum),
        tickets: list,
      });
    } catch (e) {
      console.error("admin support-mail list error:", e.message);
      return res.status(500).json({ success: false, message: "Server error." });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // ADMIN — GET /api/admin/support-mail/:ticketId
  // Full ticket detail with all messages.
  // ═══════════════════════════════════════════════════════════════
  router.get("/admin/support-mail/:ticketId", requireAdmin, async (req, res) => {
    try {
      const ticket = await tickets.findOne({ ticketId: req.params.ticketId.toUpperCase() });
      if (!ticket) return res.status(404).json({ success: false, message: "Ticket not found." });
      return res.json({ success: true, ticket });
    } catch (e) {
      console.error("admin support-mail detail error:", e.message);
      return res.status(500).json({ success: false, message: "Server error." });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // ADMIN — POST /api/admin/support-mail/:ticketId/reply
  // Admin sends a reply. Automatically marks ticket as in_progress.
  // Body: { adminId, adminName, message }
  // ═══════════════════════════════════════════════════════════════
  router.post("/admin/support-mail/:ticketId/reply", requireAdmin, async (req, res) => {
    const { ticketId }                  = req.params;
    const { adminId, adminName, message } = req.body;

    if (!message?.trim()) return res.status(400).json({ success: false, message: "Reply message is required." });
    if (message.trim().length > 5000) return res.status(400).json({ success: false, message: "Message too long." });

    try {
      const ticket = await tickets.findOne({ ticketId: ticketId.toUpperCase() });
      if (!ticket) return res.status(404).json({ success: false, message: "Ticket not found." });
      if (ticket.status === TICKET_STATUS.CLOSED) {
        return res.status(400).json({ success: false, message: "Cannot reply to a closed ticket." });
      }

      const reply = buildReply({ from: "admin", senderId: adminId, senderName: adminName || "Support Team", content: message });

      await tickets.updateOne(
        { ticketId: ticketId.toUpperCase() },
        {
          $push: { messages: reply },
          $set: {
            status:    TICKET_STATUS.IN_PROGRESS,
            updatedAt: new Date(),
          },
        }
      );

      // Optional: DM the user via Discord bot if they have a userId
      // if (ticket.userId) { await dmUser(ticket.userId, embed); }

      return res.json({ success: true, message: "Reply sent." });
    } catch (e) {
      console.error("admin support-mail reply error:", e.message);
      return res.status(500).json({ success: false, message: "Server error." });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // ADMIN — PATCH /api/admin/support-mail/:ticketId/status
  // Change ticket status: open | in_progress | resolved | closed
  // Body: { status }
  // ═══════════════════════════════════════════════════════════════
  router.patch("/admin/support-mail/:ticketId/status", requireAdmin, async (req, res) => {
    const { status } = req.body;
    const validStatuses = Object.values(TICKET_STATUS);

    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: `Invalid status. Use: ${validStatuses.join(", ")}` });
    }

    try {
      const setFields = { status, updatedAt: new Date() };
      if (status === TICKET_STATUS.RESOLVED) setFields.resolvedAt = new Date();
      if (status === TICKET_STATUS.CLOSED)   setFields.closedAt   = new Date();

      const result = await tickets.updateOne(
        { ticketId: req.params.ticketId.toUpperCase() },
        { $set: setFields }
      );

      if (result.matchedCount === 0) return res.status(404).json({ success: false, message: "Ticket not found." });
      return res.json({ success: true, message: `Status updated to '${status}'.` });
    } catch (e) {
      console.error("admin support-mail status error:", e.message);
      return res.status(500).json({ success: false, message: "Server error." });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // ADMIN — PATCH /api/admin/support-mail/:ticketId/assign
  // Assign ticket to an admin.
  // Body: { adminId, adminName }
  // ═══════════════════════════════════════════════════════════════
  router.patch("/admin/support-mail/:ticketId/assign", requireAdmin, async (req, res) => {
    const { adminId, adminName } = req.body;
    if (!adminId) return res.status(400).json({ success: false, message: "adminId is required." });

    try {
      const result = await tickets.updateOne(
        { ticketId: req.params.ticketId.toUpperCase() },
        { $set: { assignedTo: { adminId, adminName: adminName || adminId }, updatedAt: new Date() } }
      );

      if (result.matchedCount === 0) return res.status(404).json({ success: false, message: "Ticket not found." });
      return res.json({ success: true, message: `Ticket assigned to ${adminName || adminId}.` });
    } catch (e) {
      console.error("admin support-mail assign error:", e.message);
      return res.status(500).json({ success: false, message: "Server error." });
    }
  });

  return router;
}
