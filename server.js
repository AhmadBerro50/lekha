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

// Reconnection timeout in milliseconds (60 seconds)
const RECONNECT_TIMEOUT = 60 * 1000;

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
        this.botReplacedPositions = new Set(); // positions replaced by bots after disconnect timeout
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
            timeout: null
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

        // Clear the timeout
        if (disconnectInfo.timeout) {
            clearTimeout(disconnectInfo.timeout);
        }

        // Recreate the player with their original state
        const player = new Player(ws, playerId, disconnectInfo.name, disconnectInfo.avatarData);
        player.position = disconnectInfo.position;
        player.isHost = disconnectInfo.isHost;
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
        if (this.players.size !== 4) return false;
        for (const player of this.players.values()) {
            if (!player.isReady) return false;
        }
        return true;
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
    console.log(`📋 Checking ${rooms.size} total rooms for listing...`);

    for (const room of rooms.values()) {
        const notInProgress = !room.gameInProgress;
        const hasSpace = room.players.size < 4;

        console.log(`  Room "${room.name}": notInProgress=${notInProgress}, hasSpace=${hasSpace} (${room.players.size}/4)`);

        if (notInProgress && hasSpace) {
            availableRooms.push(room.toJSON());
        }
    }

    console.log(`📤 Sending ${availableRooms.length} rooms to client`);

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

function handleSelectPosition(ws, player, data) {
    if (!player.roomId) return;

    const room = rooms.get(player.roomId);
    if (!room) return;

    // Parse the requested position (North, South, East, West)
    const requestedPosition = data;
    const validPositions = ['North', 'South', 'East', 'West'];

    if (!validPositions.includes(requestedPosition)) {
        sendError(ws, 'Invalid position');
        return;
    }

    // Check if position is already taken
    for (const p of room.players.values()) {
        if (p.position === requestedPosition && p.id !== player.id) {
            sendError(ws, 'Position already taken');
            return;
        }
    }

    // Assign the position
    const oldPosition = player.position;
    player.position = requestedPosition;
    console.log(`📍 ${player.name} selected position: ${requestedPosition}${oldPosition ? ' (was ' + oldPosition + ')' : ''}`);

    // Notify all players in the room
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

    // Store game state if it's a state sync
    if (type === MessageType.GameState) {
        room.gameState = data;
    }

    // Handle game over
    if (type === MessageType.GameOver) {
        room.gameInProgress = false;
        console.log(`🏁 Game over in room: ${room.name}`);
    }

    // Special handling for PassCards - buffer until all 4 positions submit
    if (type === MessageType.PassCards) {
        // Key by FromPosition (not player.id) so host can submit for disconnected players
        let fromPos = player.id; // fallback
        try {
            const parsed = JSON.parse(data);
            if (parsed.FromPosition) fromPos = parsed.FromPosition;
        } catch(e) { /* use fallback */ }

        room.pendingPassCards.set(fromPos, {
            Type: type,
            Data: data,
            SenderId: player.id
        });

        // Always need 4 pass submissions (active + disconnected + bot = 4 total)
        const totalExpected = room.players.size + room.disconnectedPlayers.size + room.botReplacedPositions.size;
        console.log(`📨 Pass cards buffered from ${fromPos} (${room.pendingPassCards.size}/${totalExpected})`);

        if (room.pendingPassCards.size >= totalExpected) {
            console.log(`✅ All ${totalExpected} positions passed - releasing cards`);
            // Release all buffered pass cards to all players (no exclusion - clients filter by ToPosition)
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
                // Notify other players that this player disconnected
                room.broadcast({
                    Type: MessageType.PlayerDisconnected,
                    Data: JSON.stringify({
                        PlayerId: player.id,
                        Name: player.name,
                        Position: disconnectInfo.position,
                        ReconnectTimeout: RECONNECT_TIMEOUT
                    })
                });

                // Send room update
                room.broadcast({
                    Type: MessageType.RoomUpdated,
                    Data: JSON.stringify(room.toJSON())
                });

                // Set timeout to replace with bot if they don't reconnect
                disconnectInfo.timeout = setTimeout(() => {
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

                        // Notify remaining players that this position is now a bot
                        room.broadcast({
                            Type: MessageType.BotReplaced,
                            Data: JSON.stringify({ PlayerId: player.id, Name: player.name, Position: dcInfo.position })
                        });

                        room.broadcast({
                            Type: MessageType.RoomUpdated,
                            Data: JSON.stringify(room.toJSON())
                        });

                        // Only delete room if nobody is connected at all
                        if (room.players.size === 0 && room.disconnectedPlayers.size === 0 && room.spectators.size === 0) {
                            rooms.delete(room.id);
                            console.log(`🗑️ Room deleted (all players left): ${room.name}`);
                        }
                    }
                }, RECONNECT_TIMEOUT);

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
