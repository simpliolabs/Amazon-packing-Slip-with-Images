import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
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

  // Required for @react-pdf/renderer
  webpack: (config) => {
    config.resolve.alias.canvas = false
    return config
  },
  // Silence turbopack warning
  turbopack: {},

  // Output standalone for Hostinger VPS deployment
  output: 'standalone',
}

export default nextConfig
