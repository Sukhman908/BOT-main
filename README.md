# Rewards Portal Bot

A Discord bot for managing rewards, coins, redemptions, and user tracking with MongoDB integration and Express API.

## Features

- 🎫 **Redemption System** - User-requested redemptions with review workflow
- 💰 **Coin System** - Award, track, and spend coins
- 🏆 **Giveaways** - Create and manage giveaways
- 📧 **Support Mail** - Email integration for support tickets
- 🔐 **Admin Controls** - Admin panel with authentication
- 📊 **User Tracking** - Track messages, invites, and activity
- 🤖 **Auto-Rejoin** - Automatically rejoin monitored servers

## Setup

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Then edit `.env` with:
- **BOT_TOKEN**: Discord bot token (get from [Discord Developer Portal](https://discord.com/developers/applications))
- **CLIENT_ID**: Your Discord application ID
- **GUILD_ID**: Your main Discord server ID
- **DISCORD_CLIENT_ID** & **DISCORD_CLIENT_SECRET**: OAuth credentials
- **MONGO_URI**: MongoDB connection string
- **ADMIN_API_KEY**: Strong random key for admin API authentication
- Other channel IDs and configuration values

### 3. Discord Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create/select your application
3. Go to **Bot** → Copy token → Add to `.env` as `BOT_TOKEN`
4. Go to **OAuth2** → Add redirect URL: `https://yourdomain.com/auth/callback`
5. Go to **OAuth2** → Client Secret → Copy → Add to `.env` as `DISCORD_CLIENT_SECRET`
6. Enable required **Intents** (Message Content, Guild Members, etc.)

### 4. MongoDB

- Create a MongoDB cluster (free tier at [mongodb.com](https://mongodb.com))
- Get connection string
- Add to `.env` as `MONGO_URI`

### 5. Run the Bot

```bash
npm start
```

For development with auto-reload:
```bash
npm run dev
```

## API Endpoints

- `GET /health` - Health check
- `GET /api/health` - API health check
- `GET /api/user/:userId` - Get user data
- `POST /api/save-redemption` - Save redemption request
- `POST /api/admin/*` - Admin endpoints (requires ADMIN_API_KEY)
- `/api/support/*` - Support mail routes
- `/api/giveaways/*` - Giveaway routes

## Deployment

### Railway (Recommended)

1. Push to GitHub
2. Connect repo to [Railway](https://railway.app)
3. Set environment variables in Railway dashboard
4. Deploy

### Environment Variables for Production

Set these in your deployment platform:
```
BOT_TOKEN=<your_token>
CLIENT_ID=<your_client_id>
GUILD_ID=<your_guild_id>
LOG_CHANNEL=<channel_id>
REVIEW_CHANNEL_ID=<channel_id>
DISCORD_CLIENT_ID=<client_id>
DISCORD_CLIENT_SECRET=<secret>
REDIRECT_URI=https://yourdomain.com/auth/callback
MONGO_URI=<mongodb_connection>
ADMIN_API_KEY=<strong_random_key>
MONITOR_GUILDS=<guild_id1,guild_id2>
PORT=3000
```

## Directory Structure

```
├── rewards-bot.js          # Main bot file
├── package.json            # Dependencies
├── .env.example            # Environment template
├── api/                    # API endpoints
├── middleware/             # Authentication middleware
├── models/                 # Database models
└── routes/                 # API routes
```

## License

© 2026 NITIN. All rights reserved.

Proprietary - Do not share without permission.

**Author:** NITIN  
**Instagram:** [@nitin_209_](https://instagram.com/nitin_209_)
