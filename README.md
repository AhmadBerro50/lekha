# Lekha Game Server

WebSocket game server for the Lekha card game. Handles multiplayer rooms, game state sync, spectating, and voice chat relay.

## Features

- Room creation (public/private with code)
- Player matchmaking (4 players per game)
- Real-time game state synchronization
- Spectator mode for live games
- Voice chat relay
- Automatic room cleanup
- Health endpoint for uptime monitoring

## Local Development

```bash
# Install dependencies
npm install

# Run server
npm start

# Or with auto-reload (Node 18+)
npm run dev
```

Server runs on `ws://localhost:8080`
Health check: `http://localhost:8080/health`

## Deploy to Glitch (Free, No Credit Card)

### Step 1: Create Glitch Account
1. Go to [glitch.com](https://glitch.com)
2. Sign up with GitHub, Google, or email (no credit card needed)

### Step 2: Create New Project
1. Click "New Project" button
2. Select "glitch-hello-node" (basic Node.js template)

### Step 3: Import Server Files
1. Click on "Assets" in the left sidebar
2. Delete all existing files except `package.json`
3. Click "New File" and create `server.js`
4. Copy the contents from this project's `server.js`
5. Update `package.json` with this project's dependencies

Or use the Terminal in Glitch:
```bash
# In Glitch terminal
rm -rf *
wget -O server.js https://raw.githubusercontent.com/YOUR_REPO/main/Server/server.js
wget -O package.json https://raw.githubusercontent.com/YOUR_REPO/main/Server/package.json
refresh
```

### Step 4: Get Your Server URL
1. Click "Share" button at top
2. Copy the "Live Site" URL (e.g., `https://your-project-name.glitch.me`)
3. Your WebSocket URL is: `wss://your-project-name.glitch.me`

### Step 5: Keep Server Awake with UptimeRobot
Glitch free tier sleeps after 5 minutes of inactivity. Use UptimeRobot to keep it awake:

1. Go to [uptimerobot.com](https://uptimerobot.com) and create free account
2. Click "Add New Monitor"
3. Configure:
   - Monitor Type: **HTTP(s)**
   - Friendly Name: `Lekha Server`
   - URL: `https://your-project-name.glitch.me/health`
   - Monitoring Interval: **5 minutes**
4. Click "Create Monitor"

Now UptimeRobot will ping your server every 5 minutes, keeping it awake 24/7.

## Unity Configuration

In Unity, find the NetworkManager in your scene and:
1. Set `Use Local Server` to `false`
2. Set `Server Url` to your Glitch URL (use `wss://` prefix)

Example: `wss://lekha-game-server.glitch.me`

## Message Types

| Type | Description |
|------|-------------|
| `CreateRoom` | Create a new game room |
| `JoinRoom` | Join by room ID |
| `JoinRoomByCode` | Join private room by 6-letter code |
| `LeaveRoom` | Leave current room |
| `SetReady` | Toggle ready status |
| `StartGame` | Start game (host only) |
| `SpectateRoom` | Watch a live game |
| `LiveGames` | Get list of games in progress |
| `VoiceData` | Audio data for voice chat |

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Health check (JSON status) |
| `GET /health` | Health check (JSON status) |
| `ws://` | WebSocket connection |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 8080 | Server port |

## Testing

Test locally with wscat:
```bash
npm install -g wscat
wscat -c ws://localhost:8080
```

Then send:
```json
{"Type":"RoomList"}
```

Test health endpoint:
```bash
curl http://localhost:8080/health
```
