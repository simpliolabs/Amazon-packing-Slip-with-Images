/**
 * PM2 Ecosystem Config — Hostinger VPS Deployment
 * Usage: pm2 start ecosystem.config.js --env production
 */

module.exports = {
  apps: [
    {
      name: 'fbm-packing-slip',
      script: 'node_modules/.bin/next',
      args: 'start',
      cwd: '/var/www/fbm-packing-slip',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      error_file: '/var/log/fbm-packing-slip/error.log',
      out_file: '/var/log/fbm-packing-slip/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
    {
      // Background cron job — triggers sync every 30 minutes
      name: 'fbm-cron',
      script: 'scripts/cron.js',
      cwd: '/var/www/fbm-packing-slip',
      instances: 1,
      autorestart: true,
      watch: false,
      env_production: {
        NODE_ENV: 'production',
      },
      error_file: '/var/log/fbm-packing-slip/cron-error.log',
      out_file: '/var/log/fbm-packing-slip/cron-out.log',
    },
  ],
}
