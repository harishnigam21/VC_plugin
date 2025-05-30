import { io } from 'socket.io-client';
const socket = io("https://vc-front-six.vercel.app");

socket.on("connect", () => {
  console.log("Connected to Socket.IO!");
});
