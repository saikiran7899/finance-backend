const express = require("express");
const router = express.Router();

// GOOGLE_MAPS_API_KEY must be set in your Render environment variables.
// Add it in Render dashboard → your service → Environment → Add variable.
const PLACES_KEY = process.env.GOOGLE_MAPS_API_KEY;

/**
 * GET /api/places/autocomplete?input=Parvatha
 * Proxies to Google Places Autocomplete REST API.
 * Calling from the server avoids any client-side key restrictions and
 * means the key never ships inside the mobile app bundle.
 */
router.get("/places/autocomplete", async (req, res) => {
  const { input } = req.query;
  if (!input || input.trim().length < 2) {
    return res.json({ predictions: [] });
  }
  if (!PLACES_KEY) {
    return res.status(500).json({ error: "GOOGLE_MAPS_API_KEY not configured on server" });
  }
  try {
    const url = `https://maps.googleapis.com/maps/api/place/autocomplete/json?input=${encodeURIComponent(input.trim())}&key=${PLACES_KEY}&language=en&components=country:in`;
    const response = await fetch(url);
    const data = await response.json();
    // Forward the raw Google response — the mobile app reads data.predictions
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message, predictions: [] });
  }
});

/**
 * GET /api/places/details?place_id=ChIJ...
 * Proxies to Google Place Details to get lat/lng for a selected prediction.
 */
router.get("/places/details", async (req, res) => {
  const { place_id } = req.query;
  if (!place_id) return res.status(400).json({ error: "place_id required" });
  if (!PLACES_KEY) {
    return res.status(500).json({ error: "GOOGLE_MAPS_API_KEY not configured on server" });
  }
  try {
    // Include 'url' in fields — Google returns the canonical maps.google.com/?cid=... link
    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(place_id)}&fields=name,geometry,formatted_address,url&key=${PLACES_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
