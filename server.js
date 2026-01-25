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

    // Voice
    VoiceData: 'VoiceData',
    MutePlayer: 'MutePlayer',
    UnmutePlayer: 'UnmutePlayer',

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

class GameRoom {
    constructor(id, name, hostId, isPrivate = false) {
        this.id = id;
        this.name = name;
        this.hostId = hostId;
        this.isPrivate = isPrivate;
        this.roomCode = this.generateRoomCode();
        this.players = new Map(); // playerId -> Player
        this.spectators = new Map(); // oddziela spectators
        this.maxPlayers = 4;
        this.gameInProgress = false;
        this.gameState = null;
        this.createdAt = Date.now();
    }

    generateRoomCode() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let code = '';
        for (let i = 0; i < 6; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return code;
    }

    addPlayer(player) {
        if (this.players.size >= this.maxPlayers) {
            return false;
        }

        // Assign position
        const positions = [PlayerPosition.South, PlayerPosition.West, PlayerPosition.North, PlayerPosition.East];
        const takenPositions = Array.from(this.players.values()).map(p => p.position);
        const availablePosition = positions.find(p => !takenPositions.includes(p));

        if (!availablePosition) {
            return false;
        }

        player.position = availablePosition;
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
        if (this.players.size !== 4) return false;
        for (const player of this.players.values()) {
            if (!player.isReady) return false;
        }
        return true;
    }

    toJSON(includeCode = false) {
        const data = {
            RoomId: this.id,
            RoomName: this.name,
            Players: Array.from(this.players.values()).map(p => p.toJSON()),
            MaxPlayers: this.maxPlayers,
            IsPrivate: this.isPrivate,
            GameInProgress: this.gameInProgress,
            CanStart: this.canStart(),
            SpectatorCount: this.spectators.size
        };

        if (includeCode || !this.isPrivate) {
            data.RoomCode = this.roomCode;
        }

        return data;
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
    console.log(`🎴 Lekha Game Server starting on port ${PORT}...`);
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

    // Send connected message
    send(ws, {
        Type: MessageType.Connected,
        Data: JSON.stringify({ PlayerId: playerId })
    });

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

        case MessageType.JoinRoomByCode:
            handleJoinRoomByCode(ws, player, Data);
            break;

        case MessageType.LeaveRoom:
            handleLeaveRoom(ws, player);
            break;

        case MessageType.SetReady:
            handleSetReady(ws, player, Data);
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

        // Voice data - relay to room
        case MessageType.VoiceData:
            handleVoiceData(ws, player, Data);
            break;

        case MessageType.MutePlayer:
        case MessageType.UnmutePlayer:
            // Just acknowledge, client handles local muting
            break;

        default:
            console.log(`Unknown message type: ${Type}`);
    }
}

function sendRoomList(ws) {
    const publicRooms = [];
    for (const room of rooms.values()) {
        if (!room.isPrivate && !room.gameInProgress && room.players.size < 4) {
            publicRooms.push(room.toJSON());
        }
    }

    send(ws, {
        Type: MessageType.RoomList,
        Data: JSON.stringify(publicRooms)
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
        const isPrivate = roomData.IsPrivate || false;

        const room = new GameRoom(roomId, roomName, player.id, isPrivate);

        if (room.addPlayer(player)) {
            rooms.set(roomId, room);
            console.log(`🏠 Room created: ${roomName} (${roomId}) by ${player.name}`);

            send(ws, {
                Type: MessageType.RoomJoined,
                Data: JSON.stringify(room.toJSON(true))
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

function handleJoinRoomByCode(ws, player, data) {
    try {
        const code = (typeof data === 'string' ? data.replace(/"/g, '') : data).toUpperCase();

        let targetRoom = null;
        for (const room of rooms.values()) {
            if (room.roomCode === code) {
                targetRoom = room;
                break;
            }
        }

        if (!targetRoom) {
            sendError(ws, 'Invalid room code');
            return;
        }

        handleJoinRoom(ws, player, targetRoom.id);
    } catch (e) {
        console.error('Error joining by code:', e);
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
    if (room.players.size === 0 && room.spectators.size === 0) {
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

function handleGameAction(ws, player, type, data) {
    if (!player.roomId) return;

    const room = rooms.get(player.roomId);
    if (!room) return;

    // Store game state if it's a state sync
    if (type === MessageType.GameState) {
        room.gameState = data;
    }

    // Handle game over
    if (type === MessageType.GameOver) {
        room.gameInProgress = false;
        console.log(`🏁 Game over in room: ${room.name}`);
    }

    // Relay to all players and spectators (except sender)
    room.broadcastToAll({
        Type: type,
        Data: data,
        SenderId: player.id
    }, player.id);
}

function handleVoiceData(ws, player, data) {
    if (!player.roomId) return;

    const room = rooms.get(player.roomId);
    if (!room) return;

    // Relay voice data to all other players (not spectators for now)
    room.broadcast({
        Type: MessageType.VoiceData,
        Data: data,
        SenderId: player.id
    }, player.id);
}

function handleDisconnect(ws) {
    const player = players.get(ws);
    if (!player) return;

    console.log(`❌ Disconnected: ${player.name} (${player.id})`);

    // Leave room if in one
    if (player.roomId) {
        handleLeaveRoom(ws, player);
    }

    players.delete(ws);
}

// Periodic cleanup of stale rooms
setInterval(() => {
    const now = Date.now();
    const staleTimeout = 30 * 60 * 1000; // 30 minutes

    for (const [roomId, room] of rooms) {
        if (room.players.size === 0 && (now - room.createdAt) > staleTimeout) {
            rooms.delete(roomId);
            console.log(`🧹 Cleaned up stale room: ${room.name}`);
        }
    }
}, 60000); // Check every minute

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
