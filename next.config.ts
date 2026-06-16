import type { NextConfig } from 'next'

// Build-info baked at build time so /api/health can report exactly which commit is LIVE.
// This kills the recurring "is it actually deployed?" guessing (2026-06-16: a failed Coolify
// layer-export served the old build for hours with no way to tell). BUILD_TIME always works;
// BUILD_SHA is best-effort (git may be absent in the nixpacks build image → 'unknown', harmless).
const BUILD_TIME = new Date().toISOString()
let BUILD_SHA = process.env.SOURCE_COMMIT || process.env.COOLIFY_GIT_COMMIT_SHA || 'unknown'
if (BUILD_SHA === 'unknown') {
  try { BUILD_SHA = require('child_process').execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'unknown' } catch { /* git unavailable at build → stays 'unknown' */ }
}

const nextConfig: NextConfig = {
  env: { BUILD_TIME, BUILD_SHA },

  // Allow images from Amazon CDN and Supabase Storage
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'm.media-amazon.com',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: 'images-na.ssl-images-amazon.com',
        pathname: '/**',
      },
      {
        protocol: 'https',
        hostname: '*.supabase.co',
        pathname: '/storage/v1/object/public/**',
      },
      {
        protocol: 'https',
        hostname: 'piyuvsntqqulmooslhcc.supabase.co',
        pathname: '/**',
      },
    ],
  },

  // Security headers (DPP compliance)
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob: https://m.media-amazon.com https://images-na.ssl-images-amazon.com https://*.supabase.co",
              "font-src 'self' data:",
              "connect-src 'self' https://*.supabase.co",
              "frame-ancestors 'none'",
            ].join('; '),
          },
        ],
      },
    ]
  },

  // Required for @react-pdf/renderer
  webpack: (config) => {
    config.resolve.alias.canvas = false
    return config
  },
  // Silence turbopack warning
  turbopack: {},

  // Standard build (no standalone) — Nixpacks handles Next.js natively
}

export default nextConfig
