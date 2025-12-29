const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http'); 
const { Server } = require("socket.io"); 
const path = require('path');
const multer = require('multer'); 
const fs = require('fs'); // <--- ZAROORI ADDITION
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// --- SECURITY CONSTANTS ---
const PHONE_REGEX = /(\+?\d{1,3}[-.\s]?)?(\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

// Socket.io Setup
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('/app/uploads'));

// DB Connection
const mongoURI = process.env.MONGO_URI;
if (!mongoURI) console.error("❌ MONGO_URI missing");
else mongoose.connect(mongoURI).then(() => console.log("✅ MongoDB Connected"));

// --- ROBUST UPLOAD SETUP ---
const uploadDir = '/app/uploads';
// Agar folder nahi hai to banao (Fix for upload crash)
if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir, { recursive: true });
}

const chatUploadStorage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, uploadDir); }, 
  filename: function (req, file, cb) { 
    // Spaces hatakar clean naam rakho
    const cleanName = file.originalname.replace(/\s+/g, '-');
    cb(null, 'chat-' + Date.now() + '-' + cleanName); 
  }
});
const chatUpload = multer({ storage: chatUploadStorage });

// --- ROUTES ---
app.use('/api/auth', require('./routes/auth'));
app.use('/api/product', require('./routes/product'));

// 1. Chat Upload Route (Fix)
app.post('/api/chat/upload', chatUpload.single('file'), (req, res) => {
  if (!req.file) {
      console.error("Upload Attempt Failed: No file received");
      return res.status(400).send("No file uploaded");
  }
  console.log("File Uploaded:", req.file.filename); // Debug log
  res.json({ filePath: req.file.filename });
});

// 2. Conversations
app.get('/api/chat/conversations/:userId', async (req, res) => {
  const Chat = require('./models/Chat');
  require('./models/Message'); 
  try {
    const chats = await Chat.find({ participants: req.params.userId })
      .populate('participants', 'name email role')
      .sort({ lastMessageTime: -1 });
    res.json(chats);
  } catch (err) { res.status(500).json({error: err.message}); }
});

// 3. Messages
app.get('/api/chat/messages/:chatId', async (req, res) => {
  const Message = require('./models/Message');
  try {
    const messages = await Message.find({ chatId: req.params.chatId }).sort({ createdAt: 1 });
    res.json(messages);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. User Search
app.get('/api/user/search', async (req, res) => {
  const User = require('./models/User');
  const { query } = req.query;
  if (!query) return res.json([]);
  try {
    const users = await User.find({
      $or: [{ name: { $regex: query, $options: 'i' } }, { email: { $regex: query, $options: 'i' } }],
      role: { $ne: 'admin' }
    }).select('name email role _id'); 
    res.json(users);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 5. Wallet APIs
app.get('/api/wallet/:userId', async (req, res) => {
    const User = require('./models/User');
    try {
        const user = await User.findById(req.params.userId);
        res.json({ balance: user.walletBalance || 0 });
    } catch (err) { res.status(500).json({ error: "User not found" }); }
});

app.post('/api/wallet/topup', async (req, res) => {
    const { userId, amount } = req.body;
    const User = require('./models/User');
    await User.findByIdAndUpdate(userId, { $inc: { walletBalance: amount } });
    res.json({ message: "Top-up Successful" });
});

app.post('/api/wallet/pay', async (req, res) => {
    const { userId, amount } = req.body;
    const User = require('./models/User');
    const user = await User.findById(userId);
    
    if (!user || user.walletBalance < amount) {
        return res.status(400).json({ message: "Insufficient Funds! Please Top-up Wallet." });
    }
    await User.findByIdAndUpdate(userId, { $inc: { walletBalance: -amount } });
    res.json({ message: "Payment Verified" });
});

// 6. Withdrawal APIs
app.post('/api/wallet/withdraw', async (req, res) => {
    const { userId, amount } = req.body;
    const User = require('./models/User');
    const Withdrawal = require('./models/Withdrawal');

    const user = await User.findById(userId);
    if (user.walletBalance < amount) {
        return res.status(400).json({ message: "Insufficient Balance!" });
    }

    const newRequest = new Withdrawal({ user: userId, amount, status: 'pending' });
    await newRequest.save();
    res.json({ message: "Withdrawal Request Sent to Admin!" });
});

app.get('/api/admin/withdrawals', async (req, res) => {
    const Withdrawal = require('./models/Withdrawal');
    try {
        const requests = await Withdrawal.find()
            .populate('user', 'name email role walletBalance')
            .sort({ createdAt: -1 });
        res.json(requests);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/withdrawals/action', async (req, res) => {
    const { id, action } = req.body; 
    const Withdrawal = require('./models/Withdrawal');
    const User = require('./models/User');

    const request = await Withdrawal.findById(id);
    if (!request || request.status !== 'pending') {
        return res.status(400).json({ message: "Invalid Request" });
    }

    if (action === 'approved') {
        await User.findByIdAndUpdate(request.user, { $inc: { walletBalance: -request.amount } });
    }

    request.status = action;
    await request.save();
    res.json({ message: `Request ${action.toUpperCase()} Successfully!` });
});

// 7. Admin Stats
app.get('/api/admin/stats', async (req, res) => {
    const User = require('./models/User');
    const Withdrawal = require('./models/Withdrawal');
    
    try {
        const totalSellers = await User.countDocuments({ role: 'seller' });
        const totalSuppliers = await User.countDocuments({ role: 'supplier' });
        const pendingWithdrawals = await Withdrawal.countDocuments({ status: 'pending' });
        const totalPayouts = await Withdrawal.aggregate([
            { $match: { status: 'approved' } },
            { $group: { _id: null, total: { $sum: "$amount" } } }
        ]);

        res.json({
            sellers: totalSellers,
            suppliers: totalSuppliers,
            pending: pendingWithdrawals,
            payouts: totalPayouts[0]?.total || 0
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {
  socket.on('join_room', (userId) => { socket.join(userId); });

  socket.on('send_message', async (data) => {
    const { senderId, receiverId, text, attachment } = data;

    if (text && (PHONE_REGEX.test(text) || EMAIL_REGEX.test(text))) {
        io.to(senderId).emit('error_message', "⚠️ SECURITY: Sharing contact info is prohibited.");
        return; 
    }

    const Message = require('./models/Message');
    const Chat = require('./models/Chat');

    let chat = await Chat.findOne({ participants: { $all: [senderId, receiverId] } });
    if (!chat) chat = new Chat({ participants: [senderId, receiverId] });
    
    chat.lastMessage = text || (attachment?.type !== 'none' ? 'Sent an attachment' : 'New Message');
    chat.lastMessageTime = Date.now();
    await chat.save();

    const newMessage = new Message({ chatId: chat._id, sender: senderId, text, attachment });
    await newMessage.save();

    // Emit to Receiver
    io.to(receiverId).emit('receive_message', newMessage);
    
    // Notification Trigger
    io.to(receiverId).emit('notification', { from: senderId });
  });
});

const PORT = process.env.PORT || 80;
server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });