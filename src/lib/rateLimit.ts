/**
 * Simple in-memory rate limiter for API routes.
 * Limits requests per IP address within a sliding window.
 */

const rateLimitMap = new Map<string, { count: number; resetTime: number }>()

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now()
  for (const [key, value] of rateLimitMap.entries()) {
    if (now > value.resetTime) {
      rateLimitMap.delete(key)
    }
  }
}, 5 * 60 * 1000)

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetInSeconds: number
}

/**
 * Check if a request is allowed under the rate limit.
 * @param identifier - Unique identifier (e.g., IP address or user ID)
 * @param maxRequests - Maximum number of requests allowed in the window
 * @param windowMs - Time window in milliseconds
 */
export function checkRateLimit(
  identifier: string,
  maxRequests: number = 10,
  windowMs: number = 60 * 1000
): RateLimitResult {
  const now = Date.now()
  const entry = rateLimitMap.get(identifier)

  if (!entry || now > entry.resetTime) {
    // New window
    rateLimitMap.set(identifier, { count: 1, resetTime: now + windowMs })
    return { allowed: true, remaining: maxRequests - 1, resetInSeconds: Math.ceil(windowMs / 1000) }
  }

  if (entry.count >= maxRequests) {
    const resetInSeconds = Math.ceil((entry.resetTime - now) / 1000)
    return { allowed: false, remaining: 0, resetInSeconds }
  }

  entry.count++
  const resetInSeconds = Math.ceil((entry.resetTime - now) / 1000)
  return { allowed: true, remaining: maxRequests - entry.count, resetInSeconds }
}
