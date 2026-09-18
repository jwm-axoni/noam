// Vitest setupFile: runs before any test module imports `config`, so the Polar
// webhook secret + product ids are captured by config at import time and the
// real PolarBillingProvider can verify signatures in tests.
//
// It deliberately does NOT set POLAR_ACCESS_TOKEN. `billingEnabled()` reads that
// live from the environment, so billing stays OFF for every suite by default
// (no free-tier limits enforced anywhere); the billing test file turns it on
// per-test and every other suite is unaffected.
process.env.POLAR_WEBHOOK_SECRET ||= "test-polar-webhook-secret";
process.env.POLAR_PRODUCT_MONTHLY_ID ||= "prod_monthly_test";
process.env.POLAR_PRODUCT_YEARLY_ID ||= "prod_yearly_test";
