// Simple shared-secret auth: the app sends this key on every request
// via the x-api-key header. Not enterprise-grade auth, but keeps random
// internet traffic off your database — appropriate for a personal app.
module.exports = function requireApiKey(req, res, next) {
  const key = req.headers["x-api-key"];
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  next();
};
