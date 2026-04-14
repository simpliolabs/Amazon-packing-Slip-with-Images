# Amazon FBM Packing Slip Portal — TheCEO.Store

This is a production-ready, internal web application for managing Amazon FBM orders and generating custom-branded packing slips with product images.

Built with Next.js 15 (App Router), Supabase, Tailwind CSS, and `@react-pdf/renderer`.

---

## 1. Supabase Setup

Your Supabase project (`piyuvsntqqulmooslhcc`) is already fully configured. The schema, RLS policies, and storage buckets were applied during the build.

### How to invite the first Admin user:
1. Go to your Supabase Dashboard: [https://supabase.com/dashboard/project/piyuvsntqqulmooslhcc/auth/users](https://supabase.com/dashboard/project/piyuvsntqqulmooslhcc/auth/users)
2. Click **Add User** → **Invite User**.
3. Enter your email address.
4. Check your inbox for the magic link, click it, and set your password.
5. Go back to the Supabase Dashboard, open the SQL Editor, and run this command to make yourself an admin:
   ```sql
   update public.user_profiles set role = 'admin' where email = 'your-email@theceo.store';
   ```
6. You can now log into the portal and invite other users (Packers or Admins) directly from the **Users** tab.

---

## 2. Amazon Developer App Registration

To connect the portal to your Amazon Seller Central account, you need to create a Private SP-API App.

1. Log into **Amazon Seller Central**.
2. Go to **Partner Network** → **Develop Apps**.
3. Click **Add new app client**.
4. Fill in the details:
   - **App Name:** FBM Packing Slip Portal
   - **API Type:** SP-API
   - **Roles:** Select `Direct-to-Consumer Shipping` and `Product Listing` (needed for images).
   - **OAuth Login URI:** `https://your-domain.com/api/amazon/connect`
   - **OAuth Redirect URI:** `https://your-domain.com/api/amazon/callback`
5. Submit the app for approval.
6. Once approved, click **View** under the LWA credentials column to get your **Client ID** and **Client Secret**.

---

## 3. Hostinger VPS Deployment

This app is designed to be deployed on your Hostinger VPS using Node.js and PM2.

### Step 1: Clone the repository
SSH into your Hostinger VPS and clone this repository:
```bash
cd /var/www
git clone https://github.com/simpliolabs/Amazon-packing-Slip-with-Images.git fbm-packing-slip
cd fbm-packing-slip
```

### Step 2: Install dependencies and build
```bash
npm install
npm run build
```

### Step 3: Configure Environment Variables
Copy the example environment file and fill in your production values:
```bash
cp .env.example .env.local
nano .env.local
```

Make sure you fill in:
- `NEXT_PUBLIC_SUPABASE_URL` and keys
- `AMAZON_CLIENT_ID` and `AMAZON_CLIENT_SECRET` (from step 2)
- `NEXT_PUBLIC_APP_URL` (your production domain, e.g., `https://portal.theceo.store`)
- `APP_SECRET` and `CRON_SECRET` (generate random 32-character strings)

### Step 4: Start the app with PM2
We've included an `ecosystem.config.js` file that starts both the Next.js web server and the background cron job for the 30-minute sync.

```bash
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup
```

### Step 5: Connect Amazon Account
1. Log into the portal as your Admin user.
2. Go to the **Settings** page.
3. Click **Connect Amazon**.
4. You will be redirected to Amazon to authorize the app.
5. Once authorized, you will be redirected back, and the `refresh_token` will be securely saved in the database.
6. The background cron job will now automatically sync orders every 30 minutes.

---

## 4. Tech Stack & Architecture

- **Frontend & API:** Next.js 15 (App Router), React 19
- **Styling:** Tailwind CSS v4, Lucide Icons
- **Database & Auth:** Supabase (PostgreSQL + GoTrue)
- **PDF Generation:** `@react-pdf/renderer` (Client-side generation to save server memory)
- **Amazon API:** SP-API v2026-01-01 (Orders) & v2022-04-01 (Catalog Items for images)
- **Background Jobs:** `node-cron` managed by PM2

### Security Features
- **Row Level Security (RLS):** All Supabase tables are protected by RLS.
- **Role-Based Access Control (RBAC):** Admin and Packer roles enforced at the database and API levels.
- **Secure Token Storage:** Amazon Refresh Tokens are stored in the `app_settings` table, only accessible by the service role.
- **No Public Routes:** All routes except `/login` are protected by Next.js Middleware.
