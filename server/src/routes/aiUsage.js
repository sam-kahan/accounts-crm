import { Router } from 'express';
import { asyncHandler, HttpError } from '../lib/http.js';
import { todayISO } from '../lib/dates.js';
import { config } from '../config.js';
import { usageFor, PRICES, WEB_SEARCH_DOLLARS } from '../services/aiUsage.js';

// Admin → AI usage: what the AI has cost, by month, feature and day.
const router = Router();

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const month = String(req.query.month || todayISO().slice(0, 7));
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, 'month must be YYYY-MM');
    res.json({
      month,
      model: config.anthropic.model,
      prices: PRICES,
      web_search_dollars: WEB_SEARCH_DOLLARS,
      ...(await usageFor(month)),
    });
  }),
);

export default router;
