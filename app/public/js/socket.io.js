import { io } from 'https://cdn.socket.io/4.7.5/socket.io.min.js';
const socket = io("https://vc-front-six.vercel.app");

socket.on("connect", () => {
  console.log("Connected to Socket.IO!");
});