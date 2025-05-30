const express = require("express");
const app = express();
const http = require("http");
const server = new http.Server(app); // Keep this line as is
const helmet = require("helmet");
const cors = require("cors"); // Keep cors for Express routes if needed

const {
  rooms,
  addSocketToRoom,
  removeSocketFromRoom,
  allSocketsForRoom,
} = require("./rooms");
const config = require("./config"); // Assuming config.js exists and exports an object

const CONFIG = {
  title: config.title,
  // host: "localhost", // <--- REMOVE OR COMMENT OUT THIS LINE FOR VERCEL
  port: process.env.PORT || 4444, // This is good, Vercel will set process.env.PORT
  timeout: config.timeout || 30000,
  max: config.max || 50,
  debug: config.debug || false,
};

process.title = CONFIG.title;

const log = require("debug")("signal:server");

// Use helmet for Express routes
app.use(helmet());

// Configure CORS for Express routes if your Express routes are consumed by a different origin
// If this server only serves WebSockets, you might not strictly need this for Express.
app.use(cors());

// --- Socket.IO CORS Configuration ---
// This is the MOST IMPORTANT change for Vercel deployments with Socket.IO
const { Server } = require("socket.io");
const io = new Server(server, {
  cors: {
    // Replace with the ACTUAL URL of your frontend application when deployed on Vercel.
    // For local development, you might add 'http://localhost:3000' or whatever your frontend runs on.
    // You can also use an array for multiple origins.
    origin: "https://vc-front-six.vercel.app", // Example: "https://your-frontend-app.vercel.app"
    methods: ["GET", "POST"], // Allow these HTTP methods for the CORS preflight request
    credentials: true, // If you're sending cookies/auth headers with your WebSocket connection
  },
  transports: ["websocket", "polling"],
});
// --- End Socket.IO CORS Configuration ---

let brokenSockets = {};

function activeSockets(id = null) {
  // io.sockets.connected is deprecated in Socket.IO v3+.
  // For Socket.IO v3/v4, you should use io.of("/").sockets for the default namespace.
  // Assuming you are using Socket.IO v2, this might still work.
  // If you upgrade Socket.IO, this function needs to be updated.
  return Object.keys(io.sockets.connected).filter(
    (sid) => sid !== id && !brokenSockets[sid]
  );
}

function brokenSocket(socket) {
  brokenSockets[socket.id] = true;
  io.emit("remove", { id: socket.id });
}

function socketByID(id) {
  // Same as activeSockets, depends on Socket.IO version.
  return io.sockets.connected[id];
}

function emitByID(id, name, msg) {
  let socket = socketByID(id);
  if (socket) {
    log("emit", id, name, msg);
    socket.emit(name, msg);
  }
}

function broadcastByID(ids, name, msg) {
  for (let id of ids) {
    emitByID(id, name, msg);
  }
}

io.on("connection", function (socket) {
  const sid = socket.id;
  let currentRoom; // This variable will store the room the socket is currently in

  log("connection socket id:", sid);

  for (const msg of ["disconnect", "disconnecting", "error"]) {
    socket.on(msg, (data) => {
      log(`* ${msg}:`, data);
      // brokenSocket(socket); // You can keep this if you want a global "broken" list

      // --- IMPORTANT CHANGE FOR DISCONNECTS ---
      if (currentRoom) {
        // Only if the socket was in a room
        // Get all peers in the room *before* removing the disconnecting socket
        const peersInRoom = allSocketsForRoom(currentRoom).filter(
          (peerId) => peerId !== sid
        );

        // Notify all *remaining* peers in the room that this socket disconnected
        peersInRoom.forEach((peerId) => {
          // Use emitByID to send to specific socket, or io.to(room).emit for everyone in room
          emitByID(peerId, "peer-left", { id: sid }); // Custom event for leaving
        });

        // Now remove the socket from the room management
        removeSocketFromRoom(sid, currentRoom);
      }
      // --- END IMPORTANT CHANGE ---
    });
  }

  socket.on("status", (info, cb) => {
    log("status", info, cb);
    if (cb)
      cb({
        api: 1,
        pong: info?.ping || "pong",
        config: CONFIG,
      });
  });

  socket.on("join", ({ room }) => {
    let peersInRoomBeforeJoin = allSocketsForRoom(room); // Get peers *before* this socket joins
    const full = peersInRoomBeforeJoin.length >= config.max;

    if (full) {
      socket.emit("error", {
        error: `Room ${room} is full`,
        code: 1,
        full,
      });
    } else {
      // First, remove from any previous room if the socket is re-joining
      if (currentRoom && currentRoom !== room) {
        removeSocketFromRoom(sid, currentRoom);
        // Optionally, notify old room that this socket left
        const oldRoomPeers = allSocketsForRoom(currentRoom);
        oldRoomPeers.forEach((peerId) => {
          emitByID(peerId, "peer-left", { id: sid });
        });
      }

      addSocketToRoom(sid, room); // Add the new socket to the room
      currentRoom = room; // Update currentRoom for this socket

      // 1. Tell the NEWLY JOINED socket about existing peers
      socket.emit("joined", {
        room,
        peers: peersInRoomBeforeJoin, // These are the Socket IDs of the peers already in the room
      });

      // 2. Tell the EXISTING peers in the room about the NEWLY JOINED socket
      peersInRoomBeforeJoin.forEach((existingPeerId) => {
        emitByID(existingPeerId, "peer-joined", { id: sid }); // Custom event for joining
      });

      log(
        `Socket ${sid} joined room ${room}. Existing peers:`,
        peersInRoomBeforeJoin.length
      );
    }
  });

  socket.on("signal", (data) => {
    log("signal", data.from, data.to);
    if (data.from !== sid) {
      log("*** error, wrong from", data.from);
    }
    if (data.to) {
      const toSocket = socketByID(data.to);
      if (toSocket) {
        toSocket.emit("signal", {
          ...data,
        });
      } else {
        log("Cannot find socket for %s", data.to);
      }
    }
  });
});

// EXPRESS.IO

const startDate = new Date();

if (CONFIG.debug) {
  app.use("/status", (req, res) => {
    let status = {
      api: 1,
      success: true,
      info: {
        timeStarted: Math.round(startDate.getTime()),
        activeConnections: activeSockets().length,
        rooms,
      },
    };
    res.json(status);
  });
}

app.use("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, user-scalable=no, minimal-ui, viewport-fit=cover">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black">
  <meta name="format-detection" content="telephone=no">
  <meta name="msapplication-tap-highlight" content="no">
  <title>Signal Server</title>
</head>
<body>
  <p><b>Signal Server</b></p>
  <p>Running since ${startDate.toISOString()}</p>
</body>
</html>`);
});

// For Vercel, just listen on the port, no need to specify host.
// It will default to 0.0.0.0 which is correct for cloud deployments.
server.listen(
  CONFIG.port, // Pass only the port
  () => {
    console.info(`Running on`, server.address());
  }
);
