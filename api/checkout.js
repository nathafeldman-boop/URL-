/* Fonction serverless Vercel : GET /api/checkout → redirection Stripe Checkout */

const { createCheckout } = require("../lib/checkout");

module.exports = async (req, res) => {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const { status, redirectUrl, body } = await createCheckout(`${proto}://${host}`);
  if (redirectUrl) {
    res.statusCode = status;
    res.setHeader("Location", redirectUrl);
    return res.end();
  }
  return res.status(status).json(body);
};
