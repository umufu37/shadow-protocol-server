const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const rooms = {};

// Game Rules Constants
const SPY_COUNTS = { 1: 0, 2: 1, 3: 1, 4: 1, 5: 2, 6: 2, 7: 3, 8: 3, 9: 3, 10: 4 };
const MISSION_SIZES = {
  1: [1, 1, 1, 1, 1],
  2: [1, 2, 1, 2, 2],
  3: [2, 2, 2, 2, 2],
  4: [2, 2, 3, 2, 3],
  5: [2, 3, 2, 3, 3],
  6: [2, 3, 4, 3, 4],
  7: [2, 3, 3, 4, 4],
  8: [3, 4, 4, 5, 5],
  9: [3, 4, 4, 5, 5],
  10: [3, 4, 4, 5, 5]
};

function shuffle(array) {
  let currentIndex = array.length, randomIndex;
  while (currentIndex !== 0) {
    randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex--;
    [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
  }
  return array;
}

const broadcastGameState = (room) => {
  const { teamVoteTimer, ...cleanRoom } = room;
  room.players.forEach(p => {
    if (p.isBot) return; // Bots don't have sockets
    const playerGameState = {
      ...cleanRoom,
      me: p,
      spies: p.role === 'spy' ? room.players.filter(x => x.role === 'spy').map(x => x.name) : []
    };
    io.to(p.id).emit('game_update', playerGameState);
  });
};

const evaluateTeamVotes = (room) => {
  const yesVotes = Object.values(room.votes).filter(v => v).length;
  const noVotes = Object.values(room.votes).filter(v => !v).length;
  
  room.lastTeamVoteResult = {
    votes: { ...room.votes },
    approved: yesVotes > noVotes
  };

  if (yesVotes > noVotes) {
    room.phase = 'mission_voting';
    room.missionVotes = {};
    room.voteTrack = 0;
  } else {
    room.voteTrack++;
    if (room.voteTrack >= 5) {
       room.status = 'finished';
       room.winner = 'spy';
       room.winReason = '5 kez üst üste takım reddedildiği için Casuslar kazandı!';
    } else {
       room.phase = 'team_selection';
       room.currentLeaderIndex = (room.currentLeaderIndex + 1) % room.players.length;
       room.proposedTeam = [];
    }
  }
};

const evaluateMissionVotes = (room) => {
  const currentMission = room.missions[room.currentMissionIndex];
  const failVotes = Object.values(room.missionVotes).filter(v => !v).length;
  
  const isFail = failVotes >= currentMission.failsRequired;
  currentMission.status = isFail ? 'fail' : 'success';
  currentMission.failVotesCast = failVotes;

  room.lastMissionResult = {
    success: !isFail,
    failVotes: failVotes
  };

  const successMissions = room.missions.filter(m => m.status === 'success').length;
  const failMissions = room.missions.filter(m => m.status === 'fail').length;

  if (successMissions >= 3) {
    room.status = 'finished';
    room.winner = 'resistance';
    room.winReason = 'Direniş 3 görevi başarıyla tamamladı!';
  } else if (failMissions >= 3) {
    room.status = 'finished';
    room.winner = 'spy';
    room.winReason = 'Casuslar 3 görevi sabote etti!';
  } else {
    room.currentMissionIndex++;
    room.currentLeaderIndex = (room.currentLeaderIndex + 1) % room.players.length;
    room.proposedTeam = [];
    room.phase = 'team_selection';
  }
};

const processBotVotes = (room) => {
  if (room.status !== 'playing') return;

  let madeAction = false;

  if (room.phase === 'team_selection') {
    const leader = room.players[room.currentLeaderIndex];
    if (leader.isBot && (!room.proposedTeam || room.proposedTeam.length === 0)) {
      const currentMission = room.missions[room.currentMissionIndex];
      const team = [];
      const playersCopy = [...room.players];
      shuffle(playersCopy);
      for(let i=0; i<currentMission.size; i++) {
        team.push(playersCopy[i].id);
      }
      room.proposedTeam = team;
      room.phase = 'team_voting';
      room.votes = {};
      room.lastTeamVoteResult = null;
      room.lastMissionResult = null;
      madeAction = true;
    }
  } else if (room.phase === 'team_voting') {
    let newlyVoted = false;
    room.players.forEach(p => {
      if (p.isBot && room.votes[p.id] === undefined) {
        room.votes[p.id] = true; // Bots always approve team
        newlyVoted = true;
      }
    });
    
    if (newlyVoted) {
       if (Object.keys(room.votes).length === room.players.length) {
          evaluateTeamVotes(room);
       }
       madeAction = true;
    }
  } else if (room.phase === 'mission_voting') {
    let newlyVoted = false;
    room.proposedTeam.forEach(pid => {
      const p = room.players.find(x => x.id === pid);
      if (p && p.isBot && room.missionVotes[p.id] === undefined) {
        room.missionVotes[p.id] = (p.role !== 'spy'); // resistance=success, spy=sabotage
        newlyVoted = true;
      }
    });

    if (newlyVoted) {
       if (Object.keys(room.missionVotes).length === room.proposedTeam.length) {
          evaluateMissionVotes(room);
       }
       madeAction = true;
    }
  }

  if (madeAction) {
     broadcastGameState(room);
     // Call recursively with delay if phase advanced and bots still need to act
     setTimeout(() => {
        processBotVotes(room);
     }, 1500);
  }
};


io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('create_room', (data, callback) => {
    const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
    rooms[roomCode] = {
      code: roomCode,
      players: [{ id: socket.id, name: data.name, isHost: true, isBot: false }],
      status: 'lobby',
    };
    socket.join(roomCode);
    callback({ success: true, roomCode });
    io.to(roomCode).emit('room_update', rooms[roomCode]);
  });

  socket.on('join_room', ({ roomCode, name }, callback) => {
    const room = rooms[roomCode];
    if (room && room.status === 'lobby') {
      if (room.players.length >= 10) return callback({ success: false, message: 'Oda dolu.' });
      room.players.push({ id: socket.id, name, isHost: false, isBot: false });
      socket.join(roomCode);
      callback({ success: true });
      io.to(roomCode).emit('room_update', room);
    } else {
      callback({ success: false, message: 'Oda bulunamadı veya başladı.' });
    }
  });

  socket.on('add_bots', (roomCode, callback) => {
    const room = rooms[roomCode];
    if (!room || room.status !== 'lobby') return callback({ success: false });
    
    const botCount = 4;
    for(let i=0; i<botCount; i++) {
       room.players.push({ 
           id: `bot_${Math.random().toString(36).substring(2,8)}`, 
           name: `Bot ${Math.floor(Math.random() * 1000)}`, 
           isHost: false, 
           isBot: true 
       });
    }
    io.to(roomCode).emit('room_update', room);
    callback({ success: true });
  });

  socket.on('start_game', (roomCode, callback) => {
    const room = rooms[roomCode];
    if (!room || room.status !== 'lobby') return callback({ success: false, message: 'Geçersiz oda.' });
    
    const numPlayers = room.players.length;
    if (numPlayers < 1) return callback({ success: false, message: 'En az 1 kişi gerekiyor.' });

    const numSpies = SPY_COUNTS[numPlayers] || 0;
    let roles = Array(numSpies).fill('spy').concat(Array(Math.max(0, numPlayers - numSpies)).fill('resistance'));
    roles = shuffle(roles);

    room.players = shuffle(room.players);
    room.players.forEach((p, idx) => { p.role = roles[idx]; });

    room.status = 'playing';
    room.missions = MISSION_SIZES[numPlayers] ? MISSION_SIZES[numPlayers].map((size, index) => ({
      id: index,
      size: size,
      failsRequired: (numPlayers >= 7 && index === 3) ? 2 : 1,
      status: 'pending',
    })) : MISSION_SIZES[1].map((size, index) => ({ id: index, size, failsRequired: 1, status: 'pending' }));
    
    room.currentLeaderIndex = 0;
    room.currentMissionIndex = 0;
    room.voteTrack = 0;
    room.phase = 'team_selection';

    room.players.forEach(p => {
      if (p.isBot) return;
      const playerGameState = {
        ...room,
        me: p,
        spies: p.role === 'spy' ? room.players.filter(x => x.role === 'spy').map(x => x.name) : []
      };
      io.to(p.id).emit('game_started', playerGameState);
    });

    // Start bot logic if bot is first leader
    setTimeout(() => processBotVotes(room), 1000);
  });

  socket.on('propose_team', ({ roomCode, team }, callback) => {
    const room = rooms[roomCode];
    if (!room || room.status !== 'playing') return callback({ success: false });
    
    room.proposedTeam = team;
    room.phase = 'team_voting';
    room.votes = {};
    room.lastTeamVoteResult = null;
    room.lastMissionResult = null;
    
    // 3 minute timer
    room.voteDeadline = Date.now() + 180000;
    if (room.teamVoteTimer) clearTimeout(room.teamVoteTimer);
    room.teamVoteTimer = setTimeout(() => {
      if (room.phase === 'team_voting') {
        evaluateTeamVotes(room);
        setTimeout(() => processBotVotes(room), 1000);
        broadcastGameState(room);
      }
    }, 180000);

    broadcastGameState(room);
    setTimeout(() => processBotVotes(room), 1000); // bots will vote
    callback({ success: true });
  });

  socket.on('vote_team', ({ roomCode, vote }, callback) => {
    const room = rooms[roomCode];
    if (!room || room.status !== 'playing' || room.phase !== 'team_voting') return callback({ success: false });

    room.votes[socket.id] = vote;

    if (Object.keys(room.votes).length === room.players.length) {
      if (room.teamVoteTimer) clearTimeout(room.teamVoteTimer);
      evaluateTeamVotes(room);
      setTimeout(() => processBotVotes(room), 1000); // bots might need to act in next phase
    }
    
    broadcastGameState(room);
    callback({ success: true });
  });

  socket.on('vote_mission', ({ roomCode, vote }, callback) => {
    const room = rooms[roomCode];
    if (!room || room.status !== 'playing' || room.phase !== 'mission_voting') return callback({ success: false });

    room.missionVotes[socket.id] = vote;

    if (Object.keys(room.missionVotes).length === room.proposedTeam.length) {
      evaluateMissionVotes(room);
      setTimeout(() => processBotVotes(room), 1000);
    }

    broadcastGameState(room);
    callback({ success: true });
  });

  socket.on('play_again', (roomCode, callback) => {
    const room = rooms[roomCode];
    if (!room || room.status !== 'finished') return callback({ success: false });

    // Sadece host başlatabilsin diye kontrol edebiliriz
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.isHost) return callback({ success: false, message: 'Sadece kurucu yeniden başlatabilir.' });

    // Odayı lobi ayarlarına döndür
    room.status = 'lobby';
    room.winner = null;
    room.winReason = null;
    room.missions = [];
    room.proposedTeam = [];
    room.votes = {};
    room.missionVotes = {};
    room.lastTeamVoteResult = null;
    room.lastMissionResult = null;
    
    // Rolleri temizle
    room.players.forEach(p => {
       p.role = null;
    });

    // Tüm oyuncuları lobiye at
    io.to(roomCode).emit('back_to_lobby', room);
    callback({ success: true });
  });

  socket.on('disconnect', () => {
    for (const [roomCode, room] of Object.entries(rooms)) {
      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      if (playerIndex !== -1) {
        if (room.status === 'playing') {
           // Turn player into a bot so the game can continue
           const p = room.players[playerIndex];
           p.isBot = true;
           p.name = p.name + " (Bot)";
           broadcastGameState(room);
           setTimeout(() => processBotVotes(room), 1000);
        } else {
           // In lobby, just remove them
           room.players.splice(playerIndex, 1);
           io.to(roomCode).emit('room_update', room);
           if (room.players.length === 0) delete rooms[roomCode];
        }
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
