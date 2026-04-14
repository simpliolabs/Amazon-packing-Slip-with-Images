#!/bin/bash
# =============================================================
# FBM Packing Slip Portal — One-Click Deploy Script
# Run this ONCE on a fresh Hostinger VPS (Ubuntu 24.04)
# =============================================================

set -e  # Stop on any error

echo ""
echo "================================================"
echo "  FBM Packing Slip Portal — Deploying..."
echo "================================================"
echo ""

# --- Step 1: Install system packages ---
echo "[1/7] Installing system packages..."
apt-get update -y -q
apt-get install -y -q curl git nginx certbot python3-certbot-nginx

# --- Step 2: Install Node.js 20 ---
echo "[2/7] Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
apt-get install -y -q nodejs

# --- Step 3: Install PM2 ---
echo "[3/7] Installing PM2 process manager..."
npm install -g pm2 --quiet

# --- Step 4: Clone the repo ---
echo "[4/7] Downloading app from GitHub..."
mkdir -p /var/www
cd /var/www
if [ -d "portal" ]; then
  echo "  → Folder already exists, pulling latest..."
  cd portal && git pull
else
  git clone https://github.com/simpliolabs/Amazon-packing-Slip-with-Images.git portal
  cd portal
fi

# --- Step 5: Install dependencies ---
echo "[5/7] Installing app dependencies (this takes ~1 minute)..."
npm install --quiet

# --- Step 6: Check for .env.local ---
echo "[6/7] Checking environment variables..."
if [ ! -f ".env.local" ]; then
  cp .env.example .env.local
  echo ""
  echo "  ⚠️  ACTION REQUIRED: Edit /var/www/portal/.env.local"
  echo "  Fill in your Supabase and Amazon credentials."
  echo "  Then run: npm run build && pm2 start ecosystem.config.js && pm2 save"
  echo ""
  exit 0
fi

# --- Step 7: Build and start ---
echo "[7/7] Building and starting the app..."
npm run build
pm2 start ecosystem.config.js
pm2 save
pm2 startup | tail -1 | bash || true

echo ""
echo "================================================"
echo "  ✅ App is running on http://localhost:3000"
echo "  Next: Set up Nginx + SSL (see guide below)"
echo "================================================"
echo ""
