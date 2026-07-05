const pThrottleModule = require('p-throttle');
const pThrottle = pThrottleModule.default || pThrottleModule;

function buildThrottle(maxRequestsPerMinute) {
  const limit = Math.max(1, Math.floor(maxRequestsPerMinute));
  const interval = Math.ceil(60000 / limit);
  return pThrottle({limit: 1, interval});
}

function applyRateLimitBuffer(rateLimitPerMinute) {
  return Math.max(1, Math.floor(rateLimitPerMinute * 0.95));
}

function getTotalRateLimitPerMinute(config) {
  const defaultRateLimit = config.rateLimitPerMinute || 50;
  let totalRateLimit = 0;

  if (Array.isArray(config.apiKeys) && config.apiKeys.length > 0) {
    for (const entry of config.apiKeys) {
      if (typeof entry === 'string') {
        totalRateLimit += applyRateLimitBuffer(defaultRateLimit);
      } else if (entry && typeof entry === 'object') {
        totalRateLimit += applyRateLimitBuffer(entry.rateLimitPerMinute || defaultRateLimit);
      }
    }
  }

  if (Array.isArray(config.serviceAccounts) && config.serviceAccounts.length > 0) {
    for (const entry of config.serviceAccounts) {
      if (typeof entry === 'string') {
        totalRateLimit += applyRateLimitBuffer(defaultRateLimit);
      } else if (entry && typeof entry === 'object') {
        totalRateLimit += applyRateLimitBuffer(entry.rateLimitPerMinute || defaultRateLimit);
      }
    }
  }

  if (totalRateLimit === 0) {
    totalRateLimit = applyRateLimitBuffer(defaultRateLimit);
  }

  return Math.max(1, totalRateLimit);
}

module.exports = {buildThrottle, applyRateLimitBuffer, getTotalRateLimitPerMinute};
