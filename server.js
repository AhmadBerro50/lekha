/**
 * Lekha Game Server
 * WebSocket server for real-time multiplayer card game
 * Supports: Room management, game sync, spectators, voice chat
 */

const WebSocket = require('ws');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

// Server configuration
const PORT = process.env.PORT || 8080;

// Create HTTP server for health checks (needed for UptimeRobot)
const httpServer = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            uptime: process.uptime(),
            rooms: rooms.size,
            players: players.size,
            timestamp: Date.now()
        }));
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

// Message types (must match Unity NetworkMessageType enum)
const MessageType = {
    // Connection
    Ping: 'Ping',
    Pong: 'Pong',
    Connected: 'Connected',
    Disconnected: 'Disconnected',
    Error: 'Error',
    Reconnect: 'Reconnect',
    ReconnectSuccess: 'ReconnectSuccess',

    // Lobby
    CreateRoom: 'CreateRoom',
    JoinRoom: 'JoinRoom',
    JoinRoomByCode: 'JoinRoomByCode',
    LeaveRoom: 'LeaveRoom',
    RoomList: 'RoomList',
    RoomJoined: 'RoomJoined',
    RoomUpdated: 'RoomUpdated',
    PlayerJoined: 'PlayerJoined',
    PlayerLeft: 'PlayerLeft',
    PlayerDisconnected: 'PlayerDisconnected',
    PlayerReconnected: 'PlayerReconnected',
    SelectPosition: 'SelectPosition',
    DeselectPosition: 'DeselectPosition',
    PositionSelected: 'PositionSelected',
    SetReady: 'SetReady',
    StartGame: 'StartGame',
    GameStarted: 'GameStarted',

    // Gameplay
    CardDealt: 'CardDealt',
    PassCards: 'PassCards',
    CardPlayed: 'CardPlayed',
    TrickWon: 'TrickWon',
    RoundEnd: 'RoundEnd',
    GameOver: 'GameOver',
    GameState: 'GameState',
    BotReplaced: 'BotReplaced',

    // Turn authority
    TurnUpdate: 'TurnUpdate',
    TurnTimeout: 'TurnTimeout',

    // Social
    EmojiReaction: 'EmojiReaction',

    // Spectator
    SpectateRoom: 'SpectateRoom',
    StopSpectating: 'StopSpectating',
    SpectatorJoined: 'SpectatorJoined',
    SpectatorLeft: 'SpectatorLeft',
    LiveGames: 'LiveGames'
};

// Player positions
const PlayerPosition = {
    South: 'South',
    West: 'West',
    North: 'North',
    East: 'East'
};

// Data structures
class Player {
    constructor(ws, id, name, avatarData = null) {
        this.ws = ws;
        this.id = id;
        this.name = name;
        this.avatarData = avatarData;
        this.isReady = false;
        this.isHost = false;
        this.position = null;
        this.roomId = null;
        this.isMuted = false;
        this.isSpectator = false;
    }

    toJSON() {
        return {
            PlayerId: this.id,
            DisplayName: this.name,
            AvatarData: this.avatarData,
            IsReady: this.isReady,
            IsHost: this.isHost,
            AssignedPosition: this.position,
            IsMuted: this.isMuted
        };
    }
}

// Reconnection timeout in milliseconds (3 minutes - allows for exponential backoff reconnection)
const RECONNECT_TIMEOUT = 180 * 1000;

// Grace period before broadcasting disconnect to other players (absorbs brief network blips)
const DISCONNECT_GRACE_MS = 10 * 1000;

class GameRoom {
    constructor(id, name, hostId) {
        this.id = id;
        this.name = name;
        this.hostId = hostId;
        this.players = new Map(); // playerId -> Player
        this.spectators = new Map(); // spectators
        this.disconnectedPlayers = new Map(); // playerId -> { player, disconnectTime, timeout }
        this.maxPlayers = 4;
        this.gameInProgress = false;
        this.gameState = null;
        this.createdAt = Date.now();
        // Pass card buffering - hold cards until all players submit
        this.pendingPassCards = new Map(); // position -> { Type, Data, SenderId }
        this.passCardTimeout = null; // Safety timeout for pass phase
        this.botReplacedPositions = new Set(); // positions replaced by bots after disconnect timeout
        // Turn authority
        this.currentTurn = null;      // Current position that should play (e.g., 'South')
        this.trickCardCount = 0;       // Cards played in current trick (0-4)
        this.turnTimeout = null;       // 30s timeout for current turn
        this.trickWonTimeout = null;   // 10s timeout waiting for TrickWon after 4 cards played
        this.turnOrder = ['South', 'East', 'North', 'West']; // Clockwise order
    }

    // Turn authority helpers
    getNextPosition(position) {
        const idx = this.turnOrder.indexOf(position);
        if (idx === -1) return this.turnOrder[0];
        return this.turnOrder[(idx + 1) % this.turnOrder.length];
    }

    advanceTurn() {
        if (!this.currentTurn) return;
        this.currentTurn = this.getNextPosition(this.currentTurn);
        this.clearTurnTimeout();
        this.startTurnTimeout();
        // Broadcast TurnUpdate to all players and spectators
        this.broadcastToAll({
            Type: MessageType.TurnUpdate,
            Data: JSON.stringify({ Position: this.currentTurn })
        });
    }

    startTurnTimeout() {
        this.clearTurnTimeout();
        this.turnTimeout = setTimeout(() => {
            if (this.currentTurn) {
                console.log(`⏰ Turn timeout for ${this.currentTurn} in room ${this.name}`);
                this.broadcastToAll({
                    Type: MessageType.TurnTimeout,
                    Data: JSON.stringify({ Position: this.currentTurn })
                });

                // Check if the timed-out position has a connected player
                let hasConnectedPlayer = false;
                for (const p of this.players.values()) {
                    if (p.position === this.currentTurn) {
                        hasConnectedPlayer = true;
                        break;
                    }
                }

                if (!hasConnectedPlayer) {
                    // No connected player at this position — auto-advance to prevent infinite timeout loop
                    console.log(`⏰ No connected player at ${this.currentTurn}, auto-advancing turn in room ${this.name}`);
                    this.trickCardCount++;
                    if (this.trickCardCount < 4) {
                        this.advanceTurn();
                    } else {
                        // Trick would be complete but no TrickWon will come — reset for safety
                        this.clearTurnTimeout();
                        this.currentTurn = null;
                        console.log(`⏰ Trick auto-completed with disconnected player, waiting for TrickWon in room ${this.name}`);
                        this.startTrickWonTimeout();
                    }
                }
                // If player IS connected but laggy, don't advance — let the client play
            }
        }, 30000); // 30 seconds
    }

    clearTurnTimeout() {
        if (this.turnTimeout) {
            clearTimeout(this.turnTimeout);
            this.turnTimeout = null;
        }
    }

    startTrickWonTimeout() {
        this.clearTrickWonTimeout();
        this.trickWonTimeout = setTimeout(() => {
            if (this.currentTurn !== null) return; // TrickWon already arrived and set currentTurn

            console.log(`⏰ TrickWon timeout in room ${this.name} — TrickWon never arrived after 10s`);

            // Check if the host is still connected
            let hostConnected = false;
            for (const p of this.players.values()) {
                if (p.id === this.hostId) {
                    hostConnected = true;
                    break;
                }
            }

            if (hostConnected) {
                // Host is connected but TrickWon was lost — ask them to resend
                console.log(`⏰ Host is connected, requesting TrickWon resend in room ${this.name}`);
                for (const p of this.players.values()) {
                    if (p.id === this.hostId) {
                        send(p.ws, {
                            Type: MessageType.Error,
                            Data: 'TrickWon timeout — please resend TrickWon'
                        });
                        break;
                    }
                }
            } else {
                // Host disconnected — broadcast TurnTimeout so clients can handle recovery
                console.log(`⏰ Host disconnected, broadcasting TurnTimeout for trick recovery in room ${this.name}`);
                this.broadcastToAll({
                    Type: MessageType.TurnTimeout,
                    Data: JSON.stringify({ Position: 'TrickWonMissing', Reason: 'HostDisconnected' })
                });
            }
        }, 10000); // 10 seconds
    }

    clearTrickWonTimeout() {
        if (this.trickWonTimeout) {
            clearTimeout(this.trickWonTimeout);
            this.trickWonTimeout = null;
        }
    }

    resetTurnTracking() {
        this.currentTurn = null;
        this.trickCardCount = 0;
        this.clearTurnTimeout();
        this.clearTrickWonTimeout();
    }

    addPlayer(player) {
        if (this.players.size >= this.maxPlayers) {
            return false;
        }

        // Player joins in the waiting area (no position assigned)
        player.position = null;
        player.roomId = this.id;
        player.isHost = this.players.size === 0;
        this.players.set(player.id, player);

        return true;
    }

    removePlayer(playerId) {
        const player = this.players.get(playerId);
        if (!player) return null;

        this.players.delete(playerId);
        player.roomId = null;
        player.position = null;
        player.isReady = false;

        // Transfer host if needed
        if (player.isHost && this.players.size > 0) {
            const newHost = this.players.values().next().value;
            newHost.isHost = true;
            this.hostId = newHost.id;
        }

        return player;
    }

    // Mark a player as disconnected (during a game) - they can still reconnect
    markPlayerDisconnected(playerId) {
        const player = this.players.get(playerId);
        if (!player) return null;

        // Store disconnected player info (preserve their position, ready state etc.)
        const disconnectInfo = {
            playerId: player.id,
            name: player.name,
            avatarData: player.avatarData,
            position: player.position,
            isHost: player.isHost,
            isReady: player.isReady,
            disconnectTime: Date.now(),
            timeout: null,
            graceTimeout: null  // Short-grace timer before notifying other players
        };

        this.disconnectedPlayers.set(playerId, disconnectInfo);
        this.players.delete(playerId);

        console.log(`⏳ Player ${player.name} marked as disconnected, waiting for reconnect...`);

        return disconnectInfo;
    }

    // Reconnect a player
    reconnectPlayer(ws, playerId) {
        const disconnectInfo = this.disconnectedPlayers.get(playerId);
        if (!disconnectInfo) return null;

        // Clear both the grace timeout and the bot-replacement timeout
        if (disconnectInfo.graceTimeout) {
            clearTimeout(disconnectInfo.graceTimeout);
            disconnectInfo.graceTimeout = null;
        }
        if (disconnectInfo.timeout) {
            clearTimeout(disconnectInfo.timeout);
        }

        // Recreate the player with their original state
        const player = new Player(ws, playerId, disconnectInfo.name, disconnectInfo.avatarData);
        player.position = disconnectInfo.position;
        // Use actual room hostId — host may have been transferred during disconnect
        player.isHost = (playerId === this.hostId);
        player.isReady = disconnectInfo.isReady;
        player.roomId = this.id;

        this.players.set(playerId, player);
        this.disconnectedPlayers.delete(playerId);

        console.log(`🔄 Player ${player.name} reconnected to room ${this.name}`);

        return player;
    }

    // Check if a player can reconnect to this room
    canReconnect(playerId) {
        if (!this.disconnectedPlayers.has(playerId)) return false;
        // Block reconnection if position was already replaced by bot
        const info = this.disconnectedPlayers.get(playerId);
        return !this.botReplacedPositions.has(info.position);
    }

    // Get count of active + disconnected players (for display purposes)
    getTotalPlayerCount() {
        return this.players.size + this.disconnectedPlayers.size;
    }

    addSpectator(player) {
        player.isSpectator = true;
        player.roomId = this.id;
        this.spectators.set(player.id, player);
        return true;
    }

    removeSpectator(playerId) {
        const spectator = this.spectators.get(playerId);
        if (spectator) {
            spectator.isSpectator = false;
            spectator.roomId = null;
            this.spectators.delete(playerId);
        }
        return spectator;
    }

    canStart() {
        // Need exactly 4 players with 4 DISTINCT positions, all ready
        if (this.players.size < 4) return false;
        const positions = new Set();
        for (const player of this.players.values()) {
            if (player.position === null) continue;
            if (!player.isReady) return false;
            positions.add(player.position);
        }
        return positions.size === 4;
    }

    toJSON() {
        // Include disconnected players in the player list with a flag
        const allPlayers = Array.from(this.players.values()).map(p => p.toJSON());

        // Add disconnected players with IsDisconnected flag
        for (const [playerId, info] of this.disconnectedPlayers) {
            allPlayers.push({
                PlayerId: info.playerId,
                DisplayName: info.name,
                AvatarData: info.avatarData,
                IsReady: info.isReady,
                IsHost: info.isHost,
                AssignedPosition: info.position,
                IsMuted: false,
                IsDisconnected: true,
                DisconnectTime: info.disconnectTime
            });
        }

        return {
            RoomId: this.id,
            RoomName: this.name,
            Players: allPlayers,
            MaxPlayers: this.maxPlayers,
            IsPrivate: false, // Always public
            GameInProgress: this.gameInProgress,
            CanStart: this.canStart(),
            SpectatorCount: this.spectators.size,
            DisconnectedCount: this.disconnectedPlayers.size
        };
    }

    // Broadcast to all players in room
    broadcast(message, excludeId = null) {
        const msgString = JSON.stringify(message);
        for (const player of this.players.values()) {
            if (player.id !== excludeId && player.ws.readyState === WebSocket.OPEN) {
                player.ws.send(msgString);
            }
        }
    }

    // Broadcast to all spectators
    broadcastToSpectators(message) {
        const msgString = JSON.stringify(message);
        for (const spectator of this.spectators.values()) {
            if (spectator.ws.readyState === WebSocket.OPEN) {
                spectator.ws.send(msgString);
            }
        }
    }

    // Broadcast to everyone (players + spectators)
    broadcastToAll(message, excludeId = null) {
        this.broadcast(message, excludeId);
        this.broadcastToSpectators(message);
    }
}

// Server state
const players = new Map(); // oddzielna mapa ws -> Player
const rooms = new Map(); // roomId -> GameRoom

// Create WebSocket server attached to HTTP server
const wss = new WebSocket.Server({ server: httpServer });

// Start HTTP server
httpServer.listen(PORT, () => {
    console.log(`🎴 Lekha Game Server v2.1 (emoji+online count) starting on port ${PORT}...`);
    console.log(`✅ Server is running on port ${PORT}`);
    console.log(`🔗 HTTP: http://localhost:${PORT}/health`);
    console.log(`🔗 WebSocket: ws://localhost:${PORT}`);
    console.log(`📡 Waiting for connections...`);
});

wss.on('connection', (ws) => {
    const playerId = uuidv4();
    console.log(`🔗 New connection: ${playerId}`);

    // Create temporary player
    const player = new Player(ws, playerId, 'Player');
    players.set(ws, player);

    // Send connected message with online player count
    send(ws, {
        Type: MessageType.Connected,
        Data: JSON.stringify({ PlayerId: playerId, OnlineCount: players.size })
    });

    // Broadcast updated online count to all other connected players
    broadcastOnlineCount();

    // Handle messages
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            handleMessage(ws, message);
        } catch (err) {
            console.error('Error parsing message:', err);
            sendError(ws, 'Invalid message format');
        }
    });

    // Handle disconnect
    ws.on('close', () => {
        handleDisconnect(ws);
    });

    ws.on('error', (err) => {
        console.error(`WebSocket error for ${playerId}:`, err);
    });
});

// Send message to client
function send(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
    }
}

// Send error to client
function sendError(ws, error) {
    send(ws, { Type: MessageType.Error, Data: error });
}

// Handle incoming messages
function handleMessage(ws, message) {
    const player = players.get(ws);
    if (!player) return;

    const { Type, Data, SenderId } = message;

    // Debug: log all incoming message types
    console.log(`📩 Received message type: "${Type}" (length: ${Type?.length})`);

    switch (Type) {
        case MessageType.Ping:
            send(ws, { Type: MessageType.Pong, Data: Date.now().toString() });
            break;

        case MessageType.Connected:
            // Client sending profile info
            try {
                const profileData = JSON.parse(Data);
                player.name = profileData.DisplayName || 'Player';
                player.avatarData = profileData.AvatarData;
                console.log(`👤 Player registered: ${player.name} (${player.id})`);

                // If player is already in a room, broadcast updated info to all players
                if (player.roomId) {
                    const room = rooms.get(player.roomId);
                    if (room) {
                        room.broadcast({
                            Type: MessageType.RoomUpdated,
                            Data: JSON.stringify(room.toJSON())
                        });
                    }
                }
            } catch (e) {
                console.error('Error parsing profile data:', e);
            }
            break;

        case MessageType.RoomList:
            sendRoomList(ws);
            break;

        case MessageType.LiveGames:
            sendLiveGames(ws);
            break;

        case MessageType.CreateRoom:
            handleCreateRoom(ws, player, Data);
            break;

        case MessageType.JoinRoom:
            handleJoinRoom(ws, player, Data);
            break;

        case MessageType.LeaveRoom:
            handleLeaveRoom(ws, player);
            break;

        case MessageType.SetReady:
            handleSetReady(ws, player, Data);
            break;

        case MessageType.SelectPosition:
            handleSelectPosition(ws, player, Data);
            break;

        case MessageType.DeselectPosition:
            handleDeselectPosition(ws, player, Data);
            break;

        case MessageType.StartGame:
            handleStartGame(ws, player);
            break;

        case MessageType.SpectateRoom:
            handleSpectateRoom(ws, player, Data);
            break;

        case MessageType.StopSpectating:
            handleStopSpectating(ws, player);
            break;

        case MessageType.Reconnect:
            handleReconnect(ws, player, Data);
            break;

        // Game actions - relay to room
        case MessageType.CardDealt:
        case MessageType.PassCards:
        case MessageType.CardPlayed:
        case MessageType.TrickWon:
        case MessageType.RoundEnd:
        case MessageType.GameOver:
        case MessageType.GameState:
            handleGameAction(ws, player, Type, Data);
            break;

        // Emoji relay - broadcast to all other players in room
        case MessageType.EmojiReaction:
            handleEmojiReaction(ws, player, Data);
            break;

        default:
            console.log(`Unknown message type: ${Type}`);
    }
}

function sendRoomList(ws) {
    const availableRooms = [];

    for (const room of rooms.values()) {
        // Only list rooms that have at least 1 active player, aren't in-game, and have space
        if (!room.gameInProgress && room.players.size > 0 && room.players.size < 4) {
            availableRooms.push(room.toJSON());
        }
    }

    send(ws, {
        Type: MessageType.RoomList,
        Data: JSON.stringify(availableRooms)
    });
}

function sendLiveGames(ws) {
    const liveGames = [];
    for (const room of rooms.values()) {
        if (room.gameInProgress) {
            liveGames.push({
                RoomId: room.id,
                RoomName: room.name,
                Players: Array.from(room.players.values()).map(p => ({
                    DisplayName: p.name,
                    Position: p.position
                })),
                SpectatorCount: room.spectators.size
            });
        }
    }

    send(ws, {
        Type: MessageType.LiveGames,
        Data: JSON.stringify(liveGames)
    });
}

function handleCreateRoom(ws, player, data) {
    try {
        const roomData = JSON.parse(data);
        const roomId = uuidv4();
        const roomName = roomData.RoomName || `${player.name}'s Room`;

        console.log(`📝 Creating room: "${roomName}" by ${player.name}`);

        const room = new GameRoom(roomId, roomName, player.id);

        if (room.addPlayer(player)) {
            rooms.set(roomId, room);
            console.log(`🏠 Room created: ${roomName} (${roomId}) by ${player.name}`);

            send(ws, {
                Type: MessageType.RoomJoined,
                Data: JSON.stringify(room.toJSON())
            });
        } else {
            sendError(ws, 'Failed to create room');
        }
    } catch (e) {
        console.error('Error creating room:', e);
        sendError(ws, 'Failed to create room');
    }
}

function handleJoinRoom(ws, player, data) {
    try {
        // If player is already in a room, leave it first
        if (player.roomId) {
            handleLeaveRoom(ws, player);
        }

        const roomId = typeof data === 'string' ? data.replace(/"/g, '') : data;
        const room = rooms.get(roomId);

        if (!room) {
            sendError(ws, 'Room not found');
            return;
        }

        if (room.gameInProgress) {
            sendError(ws, 'Game already in progress');
            return;
        }

        if (room.addPlayer(player)) {
            console.log(`👋 ${player.name} joined room: ${room.name}`);

            // Notify the new player
            send(ws, {
                Type: MessageType.RoomJoined,
                Data: JSON.stringify(room.toJSON(true))
            });

            // Notify other players
            room.broadcast({
                Type: MessageType.PlayerJoined,
                Data: JSON.stringify(player.toJSON()),
                SenderId: player.id
            }, player.id);

            // Send room update to all
            room.broadcast({
                Type: MessageType.RoomUpdated,
                Data: JSON.stringify(room.toJSON(true))
            });
        } else {
            sendError(ws, 'Room is full');
        }
    } catch (e) {
        console.error('Error joining room:', e);
        sendError(ws, 'Failed to join room');
    }
}

function handleLeaveRoom(ws, player) {
    if (!player.roomId) return;

    const room = rooms.get(player.roomId);
    if (!room) return;

    if (player.isSpectator) {
        room.removeSpectator(player.id);
        room.broadcastToAll({
            Type: MessageType.SpectatorLeft,
            Data: JSON.stringify({ PlayerId: player.id, Name: player.name })
        });
    } else {
        room.removePlayer(player.id);
        console.log(`👋 ${player.name} left room: ${room.name}`);

        // Notify remaining players
        room.broadcast({
            Type: MessageType.PlayerLeft,
            Data: JSON.stringify({ PlayerId: player.id, Name: player.name })
        });

        room.broadcast({
            Type: MessageType.RoomUpdated,
            Data: JSON.stringify(room.toJSON(true))
        });
    }

    // Clean up empty rooms
    if (room.players.size === 0 && room.spectators.size === 0 && room.disconnectedPlayers.size === 0) {
        // Clear any pending disconnect timeouts
        for (const [, info] of room.disconnectedPlayers) {
            if (info.timeout) clearTimeout(info.timeout);
        }
        rooms.delete(room.id);
        console.log(`🗑️ Room deleted: ${room.name}`);
    }
}

function handleSetReady(ws, player, data) {
    if (!player.roomId) return;

    const room = rooms.get(player.roomId);
    if (!room) return;

    player.isReady = data === 'true' || data === true;
    console.log(`✋ ${player.name} is ${player.isReady ? 'ready' : 'not ready'}`);

    room.broadcast({
        Type: MessageType.RoomUpdated,
        Data: JSON.stringify(room.toJSON(true))
    });
}

function handleSelectPosition(ws, player, data) {
    if (!player.roomId) return;

    const room = rooms.get(player.roomId);
    if (!room) return;

    // Block position changes during game
    if (room.gameInProgress) {
        sendError(ws, 'Cannot change position during game');
        return;
    }

    // Parse the requested position (North, South, East, West)
    const requestedPosition = data;
    const validPositions = ['North', 'South', 'East', 'West'];

    if (!validPositions.includes(requestedPosition)) {
        sendError(ws, 'Invalid position');
        return;
    }

    // Check if position is already taken by another player
    let occupyingPlayer = null;
    for (const p of room.players.values()) {
        if (p.position === requestedPosition && p.id !== player.id) {
            occupyingPlayer = p;
            break;
        }
    }

    const oldPosition = player.position;

    if (occupyingPlayer) {
        // Swap: occupying player gets requester's old position (or null if requester was in waiting)
        const occupyingOldPosition = occupyingPlayer.position;
        occupyingPlayer.position = oldPosition; // could be null (waiting area)
        occupyingPlayer.isReady = false;
        player.position = requestedPosition;
        player.isReady = false;

        console.log(`📍 ${player.name} swapped with ${occupyingPlayer.name}: ${player.name} → ${requestedPosition}, ${occupyingPlayer.name} → ${oldPosition || 'waiting'}`);

        // Notify about the occupying player's position change
        room.broadcast({
            Type: MessageType.PositionSelected,
            Data: JSON.stringify({
                PlayerId: occupyingPlayer.id,
                Position: occupyingPlayer.position,
                OldPosition: occupyingOldPosition
            })
        });
    } else {
        // Position is free, just assign
        player.position = requestedPosition;
        console.log(`📍 ${player.name} selected position: ${requestedPosition}${oldPosition ? ' (was ' + oldPosition + ')' : ''}`);
    }

    // Notify all players about the requester's position change
    room.broadcast({
        Type: MessageType.PositionSelected,
        Data: JSON.stringify({
            PlayerId: player.id,
            Position: requestedPosition,
            OldPosition: oldPosition
        })
    });

    room.broadcast({
        Type: MessageType.RoomUpdated,
        Data: JSON.stringify(room.toJSON(true))
    });
}

function handleDeselectPosition(ws, player, data) {
    if (!player.roomId) return;
    const room = rooms.get(player.roomId);
    if (!room || room.gameInProgress) return;

    const oldPosition = player.position;
    player.position = null;
    player.isReady = false;

    console.log(`📍 ${player.name} deselected position (was ${oldPosition || 'waiting'})`);

    room.broadcast({
        Type: MessageType.PositionSelected,
        Data: JSON.stringify({ PlayerId: player.id, Position: null, OldPosition: oldPosition })
    });
    room.broadcast({
        Type: MessageType.RoomUpdated,
        Data: JSON.stringify(room.toJSON(true))
    });
}

function handleStartGame(ws, player) {
    if (!player.roomId) return;

    const room = rooms.get(player.roomId);
    if (!room) return;

    if (player.id !== room.hostId) {
        sendError(ws, 'Only host can start the game');
        return;
    }

    if (!room.canStart()) {
        sendError(ws, 'Not all players are ready');
        return;
    }

    room.pendingPassCards.clear();
    room.resetTurnTracking();
    room.gameInProgress = true;
    console.log(`🎮 Game started in room: ${room.name}`);

    room.broadcastToAll({
        Type: MessageType.GameStarted,
        Data: JSON.stringify({ RoomId: room.id })
    });
}

function handleSpectateRoom(ws, player, data) {
    try {
        const roomId = typeof data === 'string' ? data.replace(/"/g, '') : data;
        const room = rooms.get(roomId);

        if (!room) {
            sendError(ws, 'Room not found');
            return;
        }

        if (!room.gameInProgress) {
            sendError(ws, 'No game in progress to spectate');
            return;
        }

        room.addSpectator(player);
        console.log(`👁️ ${player.name} is spectating: ${room.name}`);

        // Send current game state to spectator
        send(ws, {
            Type: MessageType.RoomJoined,
            Data: JSON.stringify(room.toJSON(true))
        });

        // Send GameStarted so client transitions from lobby to game view
        send(ws, {
            Type: MessageType.GameStarted,
            Data: JSON.stringify({ RoomId: room.id })
        });

        if (room.gameState) {
            send(ws, {
                Type: MessageType.GameState,
                Data: room.gameState
            });
        }

        // Notify room
        room.broadcastToAll({
            Type: MessageType.SpectatorJoined,
            Data: JSON.stringify({ PlayerId: player.id, Name: player.name })
        }, player.id);

    } catch (e) {
        console.error('Error spectating room:', e);
        sendError(ws, 'Failed to spectate');
    }
}

function handleStopSpectating(ws, player) {
    handleLeaveRoom(ws, player);
}

function handleEmojiReaction(ws, player, data) {
    console.log(`😀 Emoji reaction from ${player.name} (${player.id}), roomId: ${player.roomId}, data: ${data}`);
    if (!player.roomId) {
        console.log(`😀 Emoji rejected: player has no roomId`);
        return;
    }
    const room = rooms.get(player.roomId);
    if (!room) {
        console.log(`😀 Emoji rejected: room not found for ${player.roomId}`);
        return;
    }

    // Relay emoji to all other players in the room
    const message = JSON.stringify({
        Type: MessageType.EmojiReaction,
        Data: data
    });

    let sent = 0;
    for (const [id, p] of room.players) {
        if (id !== player.id && p.ws.readyState === 1) {
            p.ws.send(message);
            sent++;
        }
    }
    console.log(`😀 Emoji relayed to ${sent}/${room.players.size - 1} other players in room`);
}

function handleGameAction(ws, player, type, data) {
    if (!player.roomId) return;

    const room = rooms.get(player.roomId);
    if (!room) return;

    // Ignore game actions when no game is in progress (except GameState for spectators)
    if (!room.gameInProgress && type !== MessageType.GameOver && type !== MessageType.GameState) {
        console.log(`⚠️ Ignoring ${type} - no game in progress in room ${room.name}`);
        return;
    }

    // Reject actions from disconnected players — only connected players can submit
    if (!room.players.has(player.id)) {
        console.log(`⚠️ Ignoring ${type} from disconnected player ${player.name}`);
        return;
    }

    // Validate host-only messages
    const hostOnlyTypes = [MessageType.CardDealt, MessageType.TrickWon, MessageType.RoundEnd, MessageType.GameOver];
    if (hostOnlyTypes.includes(type) && player.id !== room.hostId) {
        console.log(`⚠️ Rejecting ${type} from non-host ${player.name}`);
        return;
    }

    // Store game state if it's a state sync
    if (type === MessageType.GameState) {
        room.gameState = data;
    }

    // Handle game over - reset room for next game
    if (type === MessageType.GameOver) {
        room.gameInProgress = false;
        room.pendingPassCards.clear();
        if (room.passCardTimeout) { clearTimeout(room.passCardTimeout); room.passCardTimeout = null; }
        room.botReplacedPositions.clear();
        room.resetTurnTracking();
        // Cancel any pending disconnect timers before clearing to avoid ghost timeouts
        for (const [, info] of room.disconnectedPlayers) {
            if (info.graceTimeout) clearTimeout(info.graceTimeout);
            if (info.timeout) clearTimeout(info.timeout);
        }
        room.disconnectedPlayers.clear();
        // Reset all player ready states so they must re-ready for next game
        for (const p of room.players.values()) {
            p.isReady = false;
        }
        console.log(`🏁 Game over in room: ${room.name} - ready states reset`);
        // Broadcast updated room state so all clients see the lobby
        room.broadcastToAll({
            Type: MessageType.RoomUpdated,
            Data: JSON.stringify(room.toJSON(true))
        });
    }

    // Special handling for PassCards - buffer until all 4 positions submit
    if (type === MessageType.PassCards) {
        // Key by FromPosition (not player.id) so host can submit for disconnected players
        const validPositions = ['North', 'South', 'East', 'West'];
        let fromPos = null;
        try {
            const parsed = JSON.parse(data);
            if (parsed.FromPosition && validPositions.includes(parsed.FromPosition)) {
                fromPos = parsed.FromPosition;
            }
        } catch(e) { /* parse failed */ }

        // Reject pass cards without a valid FromPosition
        if (!fromPos) {
            console.log(`⚠️ Rejecting PassCards from ${player.name} - missing or invalid FromPosition`);
            return;
        }

        // Validate that the sender is submitting for their own position
        const senderPosition = player.position;
        if (senderPosition && fromPos && senderPosition !== fromPos) {
            // Only allow if sender is host (host submits for bots)
            if (player.id !== room.hostId) {
                console.log(`⚠️ PassCards from ${player.name}: position mismatch (player=${senderPosition}, from=${fromPos}), rejecting`);
                return;
            }
        }

        // Dedup: reject if this position already submitted
        if (room.pendingPassCards.has(fromPos)) {
            console.log(`⚠️ Duplicate pass from ${fromPos}, ignoring`);
            return;
        }

        room.pendingPassCards.set(fromPos, {
            Type: type,
            Data: data,
            SenderId: player.id
        });

        // Always need 4 pass submissions
        const totalExpected = 4;
        console.log(`📨 Pass cards buffered from ${fromPos} (${room.pendingPassCards.size}/${totalExpected})`);

        // Start a safety timeout on first pass submission
        if (room.pendingPassCards.size === 1 && !room.passCardTimeout) {
            room.passCardTimeout = setTimeout(() => {
                if (room.pendingPassCards.size > 0 && room.pendingPassCards.size < totalExpected) {
                    console.log(`⚠️ Pass card timeout in room ${room.name} — discarding ${room.pendingPassCards.size}/${totalExpected} partial passes`);
                    // Don't broadcast partial passes — they'll break game state
                    // Just clear them and let the client-side timeout handle recovery
                    room.pendingPassCards.clear();
                }
                room.passCardTimeout = null;
            }, 25000); // 25 second timeout
        }

        if (room.pendingPassCards.size >= totalExpected) {
            // Clear timeout
            if (room.passCardTimeout) { clearTimeout(room.passCardTimeout); room.passCardTimeout = null; }

            console.log(`✅ All ${totalExpected} positions passed - releasing cards`);
            for (const [key, msg] of room.pendingPassCards) {
                room.broadcastToAll({
                    Type: msg.Type,
                    Data: msg.Data,
                    SenderId: msg.SenderId
                });
            }
            room.pendingPassCards.clear();
        }
        return; // Don't relay immediately
    }

    // === Turn authority: CardDealt ===
    if (type === MessageType.CardDealt) {
        try {
            const cardDealtData = JSON.parse(data);
            const startingPosition = cardDealtData.StartingPosition;
            const validPositions = ['South', 'East', 'North', 'West'];
            if (startingPosition && validPositions.includes(startingPosition)) {
                room.currentTurn = startingPosition;
                room.trickCardCount = 0;
                room.clearTurnTimeout();
                // Don't start turn timeout yet — pass phase happens first
                // Turn timeout starts when first trick begins (after TrickWon or first CardPlayed)
                console.log(`🎯 Turn authority: starting position set to ${startingPosition} in room ${room.name}`);
            }
        } catch (e) {
            console.error('Error parsing CardDealt data for turn tracking:', e);
        }
    }

    // === Turn authority: CardPlayed ===
    if (type === MessageType.CardPlayed) {
        try {
            const cardPlayedData = JSON.parse(data);
            const playedPosition = cardPlayedData.Position;
            const validPositions = ['South', 'East', 'North', 'West'];

            if (room.currentTurn && playedPosition && validPositions.includes(playedPosition)) {
                // Validate it's the correct player's turn
                if (playedPosition !== room.currentTurn) {
                    // Allow host to play for the CURRENT turn position (bot replacement)
                    if (player.id === room.hostId) {
                        console.log(`🤖 Host playing for ${playedPosition} (current turn: ${room.currentTurn}) - allowed`);
                        // Force the played position to match current turn for proper advancement
                        // (host submits CardPlayed with the bot's position which should be currentTurn)
                    } else {
                        console.log(`⚠️ Turn violation: ${playedPosition} played but it's ${room.currentTurn}'s turn in room ${room.name} (sender: ${player.name})`);
                        sendError(ws, `Not your turn. Current turn: ${room.currentTurn}`);
                        return; // REJECT - don't relay
                    }
                }

                room.trickCardCount++;
                console.log(`🃏 Card played by ${playedPosition}, trick card count: ${room.trickCardCount}/4 in room ${room.name}`);

                if (room.trickCardCount < 4) {
                    // Advance to next player's turn
                    room.currentTurn = room.getNextPosition(playedPosition);
                    room.clearTurnTimeout();
                    room.startTurnTimeout();
                    // Broadcast TurnUpdate
                    room.broadcastToAll({
                        Type: MessageType.TurnUpdate,
                        Data: JSON.stringify({ Position: room.currentTurn })
                    });
                } else {
                    // Trick complete — wait for TrickWon from host
                    room.clearTurnTimeout();
                    room.currentTurn = null; // Temporarily null until TrickWon arrives
                    room.startTrickWonTimeout(); // 10s safety timeout in case TrickWon is lost
                    console.log(`🃏 Trick complete (4 cards played), waiting for TrickWon in room ${room.name}`);
                }
            }
        } catch (e) {
            console.error('Error parsing CardPlayed data for turn tracking:', e);
            // Don't block relay on parse error — fall through to relay
        }
    }

    // === Turn authority: TrickWon ===
    if (type === MessageType.TrickWon) {
        try {
            const trickWonData = JSON.parse(data);
            const winnerPosition = trickWonData.WinnerPosition;
            const validPositions = ['South', 'East', 'North', 'West'];

            if (winnerPosition && validPositions.includes(winnerPosition)) {
                room.currentTurn = winnerPosition;
                room.trickCardCount = 0;
                room.clearTurnTimeout();
                room.clearTrickWonTimeout(); // TrickWon arrived, cancel safety timeout
                room.startTurnTimeout();
                console.log(`🏆 Trick won by ${winnerPosition}, they lead next in room ${room.name}`);
                // Broadcast TurnUpdate
                room.broadcastToAll({
                    Type: MessageType.TurnUpdate,
                    Data: JSON.stringify({ Position: room.currentTurn })
                });
            }
        } catch (e) {
            console.error('Error parsing TrickWon data for turn tracking:', e);
        }
    }

    // === Turn authority: RoundEnd — reset turn tracking for next round ===
    if (type === MessageType.RoundEnd) {
        room.resetTurnTracking();
        console.log(`🔄 Round ended, turn tracking reset in room ${room.name}`);
    }

    // Relay to all players and spectators (except sender)
    room.broadcastToAll({
        Type: type,
        Data: data,
        SenderId: player.id
    }, player.id);
}

function handleReconnect(ws, player, data) {
    try {
        const reconnectData = JSON.parse(data);
        const oldPlayerId = reconnectData.PlayerId;
        const roomId = reconnectData.RoomId;

        console.log(`🔄 Reconnect attempt: ${oldPlayerId} to room ${roomId}`);

        const room = rooms.get(roomId);
        if (!room) {
            sendError(ws, 'Room no longer exists');
            return;
        }

        if (!room.canReconnect(oldPlayerId)) {
            sendError(ws, 'Cannot reconnect - session expired or not found');
            return;
        }

        // Reconnect the player
        const reconnectedPlayer = room.reconnectPlayer(ws, oldPlayerId);
        if (!reconnectedPlayer) {
            sendError(ws, 'Reconnection failed');
            return;
        }

        // Update our players map with the new ws -> player mapping
        players.delete(ws);  // Remove the temporary player
        players.set(ws, reconnectedPlayer);

        console.log(`✅ ${reconnectedPlayer.name} successfully reconnected!`);

        // Send success to the reconnected player
        send(ws, {
            Type: MessageType.ReconnectSuccess,
            Data: JSON.stringify({
                Room: room.toJSON(),
                GameState: room.gameState
            })
        });

        // Send current turn info to reconnecting player
        if (room.currentTurn) {
            send(ws, {
                Type: MessageType.TurnUpdate,
                Data: JSON.stringify({ Position: room.currentTurn })
            });
        }

        // Notify other players
        room.broadcast({
            Type: MessageType.PlayerReconnected,
            Data: JSON.stringify(reconnectedPlayer.toJSON()),
            SenderId: reconnectedPlayer.id
        }, reconnectedPlayer.id);

        // Send room update to all
        room.broadcastToAll({
            Type: MessageType.RoomUpdated,
            Data: JSON.stringify(room.toJSON())
        });

    } catch (e) {
        console.error('Error handling reconnect:', e);
        sendError(ws, 'Reconnection failed');
    }
}

function handleDisconnect(ws) {
    const player = players.get(ws);
    if (!player) return;

    console.log(`❌ Disconnected: ${player.name} (${player.id})`);

    // Check if player is in a room with a game in progress
    if (player.roomId) {
        const room = rooms.get(player.roomId);

        if (room && room.gameInProgress && !player.isSpectator) {
            // Game in progress - mark as disconnected, allow reconnection
            const disconnectInfo = room.markPlayerDisconnected(player.id);

            if (disconnectInfo) {
                // Short grace period before notifying other players — absorbs brief network blips.
                // If the player reconnects within DISCONNECT_GRACE_MS, no one ever sees a disconnect.
                disconnectInfo.graceTimeout = setTimeout(() => {
                    // Player hasn't come back — now tell everyone
                    if (!room.disconnectedPlayers.has(player.id)) return; // Already reconnected

                    // Immediately transfer host role if the disconnected player was the host.
                    // This lets the new host take over game logic within the grace period instead of
                    // waiting the full RECONNECT_TIMEOUT (3 minutes).
                    if (disconnectInfo.isHost && room.players.size > 0) {
                        const newHost = room.players.values().next().value;
                        newHost.isHost = true;
                        room.hostId = newHost.id;
                        disconnectInfo.isHost = false; // Prevent double-transfer in bot-replacement timeout
                        console.log(`👑 Host transferred immediately to ${newHost.name} (disconnected host grace expired)`);
                    }

                    console.log(`📢 Grace period expired for ${player.name}, notifying room`);

                    room.broadcast({
                        Type: MessageType.PlayerDisconnected,
                        Data: JSON.stringify({
                            PlayerId: player.id,
                            Name: player.name,
                            Position: disconnectInfo.position,
                            ReconnectTimeout: RECONNECT_TIMEOUT
                        })
                    });

                    room.broadcast({
                        Type: MessageType.RoomUpdated,
                        Data: JSON.stringify(room.toJSON())
                    });

                    // Start bot-replacement countdown from now
                    disconnectInfo.timeout = setTimeout(() => {
                        if (!rooms.has(room.id)) return; // Room was deleted
                        if (room.disconnectedPlayers.has(player.id)) {
                            const dcInfo = room.disconnectedPlayers.get(player.id);
                            console.log(`🤖 Reconnect timeout for ${player.name}, replacing with bot at ${dcInfo.position}`);
                            room.disconnectedPlayers.delete(player.id);
                            room.botReplacedPositions.add(dcInfo.position);

                            // If disconnected player was host, transfer host to next connected player
                            if (dcInfo.isHost && room.players.size > 0) {
                                const newHost = room.players.values().next().value;
                                newHost.isHost = true;
                                room.hostId = newHost.id;
                                console.log(`👑 Host transferred to ${newHost.name}`);
                            }

                            room.broadcast({
                                Type: MessageType.BotReplaced,
                                Data: JSON.stringify({ PlayerId: player.id, Name: player.name, Position: dcInfo.position })
                            });

                            room.broadcast({
                                Type: MessageType.RoomUpdated,
                                Data: JSON.stringify(room.toJSON())
                            });

                            if (room.players.size === 0 && room.disconnectedPlayers.size === 0 && room.spectators.size === 0) {
                                rooms.delete(room.id);
                                console.log(`🗑️ Room deleted (all players left): ${room.name}`);
                            }
                        }
                    }, RECONNECT_TIMEOUT);
                }, DISCONNECT_GRACE_MS);

                // If all players have disconnected, clear turn tracking to prevent ghost timeouts
                if (room.players.size === 0) {
                    console.log(`⏰ All players disconnected from room ${room.name}, clearing turn tracking`);
                    room.resetTurnTracking();
                }

                // Don't delete from players map immediately - they might reconnect
                players.delete(ws);
                broadcastOnlineCount();
                return;
            }
        }

        // No game in progress or is spectator - normal leave
        handleLeaveRoom(ws, player);
    }

    players.delete(ws);
    broadcastOnlineCount();
}

function broadcastOnlineCount() {
    const count = players.size;
    console.log(`📊 Broadcasting online count: ${count} to ${players.size} players`);
    const message = JSON.stringify({
        Type: 'OnlineCount',
        Data: JSON.stringify({ Count: count })
    });
    let sent = 0;
    for (const [ws] of players) {
        if (ws.readyState === 1) {
            ws.send(message);
            sent++;
        }
    }
    console.log(`📊 Online count sent to ${sent}/${players.size} players`);
}

// Periodic cleanup of stale rooms
setInterval(() => {
    const now = Date.now();
    const staleTimeout = 10 * 60 * 1000; // 10 minutes for empty rooms
    const abandonedTimeout = 5 * 60 * 1000; // 5 minutes for rooms with only disconnected players

    for (const [roomId, room] of rooms) {
        const hasActivePlayers = room.players.size > 0;
        const hasDisconnected = room.disconnectedPlayers.size > 0;
        const age = now - room.createdAt;

        // Clean up rooms with NO active players (only disconnected or empty)
        if (!hasActivePlayers) {
            const shouldDelete = (!hasDisconnected && age > staleTimeout) ||  // Empty for 10 min
                                 (hasDisconnected && age > abandonedTimeout); // All disconnected for 5 min

            if (shouldDelete) {
                // Clear any pending timeouts
                for (const [, info] of room.disconnectedPlayers) {
                    if (info.timeout) clearTimeout(info.timeout);
                    if (info.graceTimeout) clearTimeout(info.graceTimeout);
                }
                room.disconnectedPlayers.clear();
                rooms.delete(roomId);
                console.log(`🧹 Cleaned up stale room: ${room.name} (players: ${room.players.size}, disconnected: ${hasDisconnected ? 'yes' : 'no'}, age: ${Math.round(age/1000)}s)`);
            }
        }
    }
}, 30000); // Check every 30 seconds

// Heartbeat to detect dead connections
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
    });
});

console.log('🎴 Lekha Server initialized');
