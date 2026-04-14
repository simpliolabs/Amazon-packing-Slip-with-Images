#!/bin/bash
# =============================================================
# FBM Packing Slip Portal — Nginx + SSL Setup
# Run AFTER deploy.sh, with your domain ready
# Usage: bash setup-nginx.sh portal.theceo.store
# =============================================================

set -e

DOMAIN=$1

if [ -z "$DOMAIN" ]; then
  echo "Usage: bash setup-nginx.sh your-domain.com"
  exit 1
fi

echo ""
echo "Setting up Nginx for: $DOMAIN"
echo ""

# Write Nginx config
cat > /etc/nginx/sites-available/portal << EOF
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

# Enable site
ln -sf /etc/nginx/sites-available/portal /etc/nginx/sites-enabled/
nginx -t
systemctl restart nginx

echo "Nginx configured. Getting SSL certificate..."

# Get SSL certificate
certbot --nginx -d $DOMAIN --non-interactive --agree-tos -m bills@theceocreative.com

echo ""
echo "================================================"
echo "  ✅ Done! Your app is live at: https://$DOMAIN"
echo "================================================"
echo ""
