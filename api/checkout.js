/* Fonction serverless Vercel : GET /api/checkout?plan=mensuel|annuel → redirection Stripe Checkout */

const { createCheckout } = require("../lib/checkout");
const { logEvent } = require("../lib/events");

module.exports = async (req, res) => {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const plan = new URL(req.url, `${proto}://${host}`).searchParams.get("plan") || "mensuel";
  const { status, redirectUrl, body } = await createCheckout(`${proto}://${host}`, plan);
  if (redirectUrl) {
    logEvent("checkout_click", { plan });
    res.statusCode = status;
    res.setHeader("Location", redirectUrl);
    return res.end();
  }
  return res.status(status).json(body);
};
