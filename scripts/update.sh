#!/bin/bash
# =============================================================
# FBM Packing Slip Portal — One-Click Update Script
# Run this every time Manus pushes new code to GitHub
# =============================================================

set -e

echo ""
echo "================================================"
echo "  Pulling latest code from GitHub..."
echo "================================================"

cd /var/www/portal

git pull origin main

echo "Installing any new dependencies..."
npm install --quiet

echo "Building the app..."
npm run build

echo "Restarting the app..."
pm2 restart all

echo ""
echo "================================================"
echo "  ✅ Update complete! App is live."
echo "================================================"
echo ""
