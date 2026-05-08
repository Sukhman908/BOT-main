// middleware/adminAuth.js
// Replaces the inline `adminKey !== "admin2026"` pattern you have everywhere.
// Usage: router.get("/route", requireAdmin, handler)

export function requireAdmin(req, res, next) {
  const key =
    req.headers["x-admin-key"] ||
    req.headers["authorization"]?.replace("Bearer ", "");

  if (!key || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  next();
}
