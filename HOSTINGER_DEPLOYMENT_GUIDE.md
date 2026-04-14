# Hostinger VPS Deployment Guide
**FBM Packing Slip Portal**

This guide provides step-by-step instructions to deploy the Next.js 16 application to a Hostinger Virtual Private Server (VPS) running Ubuntu.

## Prerequisites

1. A Hostinger VPS running **Ubuntu 22.04** or newer.
2. A domain name or subdomain (e.g., `portal.theceo.store`) pointed to your VPS IP address.
3. SSH access to your VPS.

---

## Step 1: Initial Server Setup

SSH into your Hostinger VPS:
```bash
ssh root@your_vps_ip
```

Update the system and install required packages:
```bash
apt update && apt upgrade -y
apt install curl git nginx certbot python3-certbot-nginx -y
```

Install Node.js (v20) and npm:
```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
```

Install PM2 (Process Manager) globally:
```bash
npm install -g pm2
```

---

## Step 2: Clone the Repository

Navigate to the web root directory and clone your GitHub repository:
```bash
cd /var/www
git clone https://github.com/simpliolabs/Amazon-packing-Slip-with-Images.git portal
cd portal
```

Install the project dependencies:
```bash
npm install
```

---

## Step 3: Configure Environment Variables

Create the production environment file:
```bash
cp .env.example .env.local
nano .env.local
```

Fill in all the required variables. You must provide the actual values for:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `AMAZON_CLIENT_ID` (Once approved)
- `AMAZON_CLIENT_SECRET` (Once approved)
- `AMAZON_REFRESH_TOKEN` (Will be populated automatically after OAuth flow)
- `AMAZON_MARKETPLACE_ID` (ATVPDKIKX0DER)
- `AMAZON_MERCHANT_TOKEN` (A9YU5DSRQQWDU)
- `AMAZON_REGION` (us-east-1)
- `AMAZON_ENDPOINT` (https://sellingpartnerapi-na.amazon.com)
- `NEXT_PUBLIC_APP_URL` (e.g., https://portal.theceo.store)
- `APP_SECRET` (Generate a random 32-char string)
- `CRON_SECRET` (Generate a random 24-char string)

Save and exit the editor (`Ctrl+X`, then `Y`, then `Enter`).

---

## Step 4: Build the Application

Run the Next.js production build:
```bash
npm run build
```

---

## Step 5: Start with PM2

The repository includes an `ecosystem.config.js` file pre-configured for this app.

Start the application using PM2:
```bash
pm2 start ecosystem.config.js
```

Save the PM2 process list and configure it to start on boot:
```bash
pm2 save
pm2 startup
```
*(Run the command that PM2 outputs after running `pm2 startup`)*

---

## Step 6: Configure Nginx (Reverse Proxy)

Create a new Nginx configuration file for your domain:
```bash
nano /etc/nginx/sites-available/portal
```

Paste the following configuration, replacing `portal.theceo.store` with your actual domain:

```nginx
server {
    listen 80;
    server_name portal.theceo.store;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        
        # Real IP headers
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable the site and restart Nginx:
```bash
ln -s /etc/nginx/sites-available/portal /etc/nginx/sites-enabled/
nginx -t
systemctl restart nginx
```

---

## Step 7: Secure with SSL (HTTPS)

Run Certbot to automatically obtain and configure an SSL certificate from Let's Encrypt:
```bash
certbot --nginx -d portal.theceo.store
```
Follow the prompts to complete the SSL setup. Certbot will automatically modify your Nginx configuration to redirect HTTP traffic to HTTPS.

---

## Step 8: Set Up the Cron Job

The application includes a background sync job that needs to be triggered periodically. We'll use the system `cron` to hit the API endpoint.

Open the crontab editor:
```bash
crontab -e
```

Add the following line to trigger the sync every 30 minutes. Replace `your_cron_secret_here` with the exact value of `CRON_SECRET` from your `.env.local` file, and update the URL:

```bash
*/30 * * * * curl -X POST -H "x-cron-secret: your_cron_secret_here" https://portal.theceo.store/api/sync > /dev/null 2>&1
```

---

## Deployment Complete!

Your FBM Packing Slip Portal is now live. 
1. Navigate to your domain (e.g., `https://portal.theceo.store`).
2. Log in using the admin account you set up (`bills@theceocreative.com`).
3. Verify the connection to Amazon in the **Settings** page once your Developer Account is approved.
