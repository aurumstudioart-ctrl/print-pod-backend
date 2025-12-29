const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http'); 
const { Server } = require("socket.io"); 
const path = require('path');
const multer = require('multer'); // Files ke liye
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// --- SECURITY CONSTANTS (The Guard 🛡️) ---
// Ye regex phone numbers aur emails ko detect karega
const PHONE_REGEX = /(\+?\d{1,3}[-.\s]?)?(\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

// Socket.io Setup
const io = new Server(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
// Uploads folder ko public karein
app.use('/uploads', express.static('/app/uploads'));

// DB Connection
const mongoURI = process.env.MONGO_URI;
if (!mongoURI) console.error("❌ MONGO_URI missing");
else mongoose.connect(mongoURI).then(() => console.log("✅ MongoDB Connected"));

// --- CHAT FILE UPLOAD SETUP ---
const chatUploadStorage = multer.diskStorage({
  // Seedha 30TB disk folder (/app/uploads) mein save karega
  destination: function (req, file, cb) { cb(null, '/app/uploads'); }, 
  filename: function (req, file, cb) { 
    cb(null, 'chat-' + Date.now() + path.extname(file.originalname)); 
  }
});
const chatUpload = multer({ storage: chatUploadStorage });

// --- ROUTES ---
app.use('/api/auth', require('./routes/auth'));
app.use('/api/product', require('./routes/product'));

// 1. Chat File Upload Route
app.post('/api/chat/upload', chatUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded");
  res.json({ filePath: req.file.filename });
});

// 2. Get All Conversations (Sidebar ke liye)
app.get('/api/chat/conversations/:userId', async (req, res) => {
  const Chat = require('./models/Chat');
  // Message model ko bhi load karna zaroori hai agar populate karna ho
  require('./models/Message'); 
  
  try {
    const chats = await Chat.find({ participants: req.params.userId })
      .populate('participants', 'name email role')
      .sort({ lastMessageTime: -1 });
    res.json(chats);
  } catch (err) { res.status(500).json({error: err.message}); }
});

// 3. GET MESSAGES FOR A SPECIFIC CHAT (New Route Added Here)
app.get('/api/chat/messages/:chatId', async (req, res) => {
  const Message = require('./models/Message');
  try {
    const messages = await Message.find({ chatId: req.params.chatId }).sort({ createdAt: 1 });
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- REAL-TIME CHAT LOGIC (STRICT MODE) ---
io.on('connection', (socket) => {
  console.log('User Connected:', socket.id);

  socket.on('join_room', (userId) => {
    socket.join(userId);
    console.log(`User ${userId} joined room`);
  });

  socket.on('send_message', async (data) => {
    const { senderId, receiverId, text, attachment } = data;

    // --- SECURITY CHECK 🛡️ ---
    // Agar message mein text hai, to check karo ke number/email to nahi?
    if (text && (PHONE_REGEX.test(text) || EMAIL_REGEX.test(text))) {
        // Warning bhejo aur message save mat karo
        io.to(senderId).emit('error_message', "⚠️ SECURITY ALERT: Sharing Phone Numbers or Emails is strictly prohibited. Use platform chat only.");
        return; 
    }

    // Database mein save karein
    const Message = require('./models/Message');
    const Chat = require('./models/Chat');

    let chat = await Chat.findOne({ participants: { $all: [senderId, receiverId] } });
    if (!chat) {
        chat = new Chat({ participants: [senderId, receiverId] });
    }
    
    chat.lastMessage = text || (attachment?.type !== 'none' ? 'Sent an attachment' : 'New Message');
    chat.lastMessageTime = Date.now();
    await chat.save();

    const newMessage = new Message({
        chatId: chat._id,
        sender: senderId,
        text,
        attachment
    });
    await newMessage.save();

    // Live Message Receiver ko bhejein
    io.to(receiverId).emit('receive_message', newMessage);
    
    // **NOTIFICATION ALERT** 🔔
    // Receiver ko batao ke "New Message" aaya hai (Red dot ke liye)
    io.to(receiverId).emit('notification', { from: senderId });
  });

  socket.on('disconnect', () => {
    console.log('User Disconnected');
  });
});

const PORT = process.env.PORT || 80;
server.listen(PORT, () => {
  console.log(`Socket & API Server running on port ${PORT}`);
});