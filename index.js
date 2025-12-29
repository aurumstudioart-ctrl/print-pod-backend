const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http'); 
const { Server } = require("socket.io"); 
const path = require('path');
const multer = require('multer'); 
const fs = require('fs'); 
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// --- SECURITY ---
const PHONE_REGEX = /(\+?\d{1,3}[-.\s]?)?(\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static('/app/uploads'));

// DB Connection
const mongoURI = process.env.MONGO_URI;
if (!mongoURI) console.error("❌ MONGO_URI missing");
else mongoose.connect(mongoURI).then(() => console.log("✅ MongoDB Connected"));

// Upload Setup
const uploadDir = '/app/uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const chatUploadStorage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, uploadDir); }, 
  filename: function (req, file, cb) { 
    const cleanName = file.originalname.replace(/\s+/g, '-');
    cb(null, 'chat-' + Date.now() + '-' + cleanName); 
  }
});
const chatUpload = multer({ storage: chatUploadStorage });

// --- ROUTES ---
app.use('/api/auth', require('./routes/auth'));
app.use('/api/product', require('./routes/product'));

// 1. Chat Upload
app.post('/api/chat/upload', chatUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded");
  res.json({ filePath: req.file.filename });
});

// 2. Conversations
app.get('/api/chat/conversations/:userId', async (req, res) => {
  const Chat = require('./models/Chat'); require('./models/Message'); 
  try {
    const chats = await Chat.find({ participants: req.params.userId })
      .populate('participants', 'name email role').sort({ lastMessageTime: -1 });
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
        res.json({ balance: user ? user.walletBalance : 0 });
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
        return res.status(400).json({ message: "Insufficient Funds!" });
    }
    await User.findByIdAndUpdate(userId, { $inc: { walletBalance: -amount } });
    res.json({ message: "Payment Verified" });
});

// 6. WITHDRAWAL SYSTEM (UPDATED LOGIC) 🏦
app.post('/api/wallet/withdraw', async (req, res) => {
    const { userId, amount } = req.body;
    const User = require('./models/User');
    const Withdrawal = require('./models/Withdrawal');

    const user = await User.findById(userId);
    if (!user || user.walletBalance < amount) {
        return res.status(400).json({ message: "Insufficient Balance!" });
    }

    // --- LOGIC CHANGE: Deduct money IMMEDIATELY (Hold) ---
    await User.findByIdAndUpdate(userId, { $inc: { walletBalance: -amount } });

    const newRequest = new Withdrawal({ user: userId, amount, status: 'pending' });
    await newRequest.save();
    
    res.json({ message: "Withdrawal Request Sent! Funds placed on hold." });
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
    const { id, action } = req.body; // action = 'approved' | 'rejected'
    const Withdrawal = require('./models/Withdrawal');
    const User = require('./models/User');

    const request = await Withdrawal.findById(id);
    if (!request || request.status !== 'pending') {
        return res.status(400).json({ message: "Invalid Request" });
    }

    // --- LOGIC CHANGE: Handle Refund on Rejection ---
    if (action === 'rejected') {
        // Refund money back to user wallet
        await User.findByIdAndUpdate(request.user, { $inc: { walletBalance: request.amount } });
    }
    // If approved, do nothing (Money was already deducted in 'withdraw' step)

    request.status = action;
    await request.save();
    res.json({ message: `Request ${action.toUpperCase()} Successfully!` });
});

// 7. ADMIN STATS API (Fixed Logic) 📊
app.get('/api/admin/stats', async (req, res) => {
    const User = require('./models/User');
    const Withdrawal = require('./models/Withdrawal');
    
    try {
        // Explicitly count documents to ensure numbers are returned
        const totalSellers = await User.countDocuments({ role: 'seller' });
        const totalSuppliers = await User.countDocuments({ role: 'supplier' });
        const pendingWithdrawals = await Withdrawal.countDocuments({ status: 'pending' });
        
        const totalPayouts = await Withdrawal.aggregate([
            { $match: { status: 'approved' } },
            { $group: { _id: null, total: { $sum: "$amount" } } }
        ]);

        res.json({
            sellers: totalSellers || 0,
            suppliers: totalSuppliers || 0,
            pending: pendingWithdrawals || 0,
            payouts: totalPayouts[0]?.total || 0
        });
    } catch (err) { 
        console.error("Stats Error:", err);
        res.status(500).json({ error: err.message }); 
    }
});

// 8. Supplier Specific Stats
app.get('/api/supplier/stats/:id', async (req, res) => {
    const Product = require('./models/Product');
    const User = require('./models/User');
    const Withdrawal = require('./models/Withdrawal');
    try {
        const supplierId = req.params.id;
        const totalProducts = await Product.countDocuments({ supplier: supplierId });
        const user = await User.findById(supplierId);
        const withdrawals = await Withdrawal.aggregate([
            { $match: { user: new mongoose.Types.ObjectId(supplierId), status: 'approved' } },
            { $group: { _id: null, total: { $sum: "$amount" } } }
        ]);
        const pending = await Withdrawal.countDocuments({ user: supplierId, status: 'pending' });

        res.json({
            products: totalProducts || 0,
            balance: user ? user.walletBalance : 0,
            withdrawn: withdrawals[0]?.total || 0,
            pendingRequests: pending || 0
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

    io.to(receiverId).emit('receive_message', newMessage);
    io.to(receiverId).emit('notification', { from: senderId });
  });
});

const PORT = process.env.PORT || 80;
server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });