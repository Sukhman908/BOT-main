// models/ticket.js
// Not mongoose — you're using raw MongoClient, so this is just
// the shape definition + helper functions for consistency.

export const TICKET_STATUS = {
  OPEN:       "open",
  IN_PROGRESS: "in_progress",
  RESOLVED:   "resolved",
  CLOSED:     "closed",
};

export const TICKET_PRIORITY = {
  LOW:    "low",
  MEDIUM: "medium",
  HIGH:   "high",
  URGENT: "urgent",
};

/**
 * Generates a human-readable ticket ID.
 * e.g. TKT-20240426-A3F9
 */
export function genTicketId() {
  const date   = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `TKT-${date}-${suffix}`;
}

/**
 * Returns the base shape of a new ticket document.
 * All fields are explicit — no surprises when you query MongoDB.
 */
export function buildTicket({ userId, userName, userAvatar, subject, message, category, priority }) {
  return {
    ticketId:   genTicketId(),
    userId:     userId     || null,
    userName:   userName   || "Anonymous",
    userAvatar: userAvatar || null,
    subject:    subject.trim(),
    category:   category   || "general",
    priority:   priority   || TICKET_PRIORITY.MEDIUM,
    status:     TICKET_STATUS.OPEN,
    messages: [
      {
        from:      "user",
        senderId:  userId || null,
        senderName: userName || "Anonymous",
        content:   message.trim(),
        sentAt:    new Date(),
      },
    ],
    assignedTo:  null,
    resolvedAt:  null,
    closedAt:    null,
    createdAt:   new Date(),
    updatedAt:   new Date(),
  };
}

/**
 * Returns the base shape of a reply to append into ticket.messages[].
 */
export function buildReply({ from, senderId, senderName, content }) {
  return {
    from,          // "user" | "admin"
    senderId,
    senderName,
    content: content.trim(),
    sentAt:  new Date(),
  };
}
