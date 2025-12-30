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

// --- 1. MODELS LOADING ---
const User = require('./models/User');
const Product = require('./models/Product');
const Chat = require('./models/Chat');
const Message = require('./models/Message');
const Order = require('./models/Order');
const Withdrawal = require('./models/Withdrawal');

// --- 2. SECURITY & LIMITS ---
const PHONE_REGEX = /(\+?\d{1,3}[-.\s]?)?(\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 5e7 // 50 MB for heavy designs
});

app.use(cors());
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/uploads', express.static('/app/uploads'));

// DB Connection
const mongoURI = process.env.MONGO_URI;
mongoose.connect(mongoURI)
    .then(() => console.log("✅ MongoDB Connected Successfully"))
    .catch(err => console.error("❌ MongoDB Connection Error:", err));

// Upload Setup
const uploadDir = '/app/uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir), 
  filename: (req, file, cb) => cb(null, `file-${Date.now()}-${file.originalname.replace(/\s+/g, '-')}`)
});
const upload = multer({ storage });

// --- 3. BASIC ROUTES ---
app.get('/', (req, res) => {
    res.status(200).send('🚀 POD Marketplace API is Healthy and Running...');
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/product', require('./routes/product'));

// --- 4. CHAT SYSTEM APIs ---

app.post('/api/chat/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded");
  res.json({ filePath: `http://print-api.129.80.92.53.nip.io/uploads/${req.file.filename}` });
});

app.get('/api/chat/conversations/:userId', async (req, res) => {
  try {
    const chats = await Chat.find({ participants: req.params.userId })
      .populate('participants', 'name email role').sort({ lastMessageTime: -1 });
    res.json(chats);
  } catch (err) { res.status(500).json({error: err.message}); }
});

app.get('/api/chat/messages/:chatId', async (req, res) => {
  try {
    const messages = await Message.find({ chatId: req.params.chatId }).sort({ createdAt: 1 });
    res.json(messages);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/chat/unread/:userId', async (req, res) => {
    try {
      const chats = await Chat.find({ participants: req.params.userId });
      const unreadMessages = await Message.find({ 
          chatId: { $in: chats.map(c => c._id) }, 
          sender: { $ne: req.params.userId }, 
          status: { $ne: 'seen' } 
      });
      const unreadMap = {};
      unreadMessages.forEach(msg => { unreadMap[msg.chatId] = (unreadMap[msg.chatId] || 0) + 1; });
      res.json({ total: unreadMessages.length, perChat: unreadMap });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/user/search', async (req, res) => {
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

// --- 5. WALLET & WITHDRAWAL SYSTEM (With Hold Logic) ---

app.get('/api/wallet/:userId', async (req, res) => {
    try {
        const user = await User.findById(req.params.userId);
        res.json({ balance: user ? user.walletBalance : 0 });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/wallet/topup', async (req, res) => {
    const { userId, amount } = req.body;
    await User.findByIdAndUpdate(userId, { $inc: { walletBalance: amount } });
    res.json({ message: "Top-up Successful" });
});

app.post('/api/wallet/pay', async (req, res) => {
    const { userId, amount } = req.body;
    const user = await User.findById(userId);
    if (!user || user.walletBalance < amount) return res.status(400).json({ message: "Insufficient Funds!" });
    await User.findByIdAndUpdate(userId, { $inc: { walletBalance: -amount } });
    res.json({ message: "Payment Verified" });
});

app.post('/api/wallet/withdraw', async (req, res) => {
    const { userId, amount } = req.body;
    const user = await User.findById(userId);
    if (!user || user.walletBalance < amount) return res.status(400).json({ message: "Insufficient Balance!" });
    
    // Hold Money Immediately
    await User.findByIdAndUpdate(userId, { $inc: { walletBalance: -amount } });
    const newRequest = new Withdrawal({ user: userId, amount, status: 'pending' });
    await newRequest.save();
    res.json({ message: "Withdrawal request sent! Funds are on hold." });
});

app.get('/api/admin/withdrawals', async (req, res) => {
    try {
        const requests = await Withdrawal.find().populate('user', 'name email role walletBalance').sort({ createdAt: -1 });
        res.json(requests);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/withdrawals/action', async (req, res) => {
    const { id, action } = req.body; 
    const request = await Withdrawal.findById(id);
    if (!request || request.status !== 'pending') return res.status(400).json({ message: "Invalid Request" });

    if (action === 'rejected') {
        // Refund on Rejection
        await User.findByIdAndUpdate(request.user, { $inc: { walletBalance: request.amount } });
    }
    request.status = action;
    await request.save();
    res.json({ message: `Request ${action} updated!` });
});

// --- 6. ORDER MANAGEMENT SYSTEM ---

app.post('/api/orders/create', async (req, res) => {
  try {
    const newOrder = new Order(req.body);
    await newOrder.save();
    res.json({ message: "Order Created!", orderId: newOrder._id });
  } catch (err) { 
    console.error("❌ Order Error:", err.message);
    res.status(500).json({ error: err.message }); 
  }
});

app.get('/api/orders/supplier/:id', async (req, res) => {
    try {
      const orders = await Order.find({ supplierId: req.params.id })
        .populate('sellerId', 'name email').populate('productId', 'name').sort({ createdAt: -1 });
      res.json(orders);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Ek aur route variant for safety (jo aapka frontend use kar raha hai)
app.get('/api/order/supplier/:id', async (req, res) => {
    try {
      const orders = await Order.find({ supplierId: req.params.id })
        .populate('sellerId', 'name email').populate('productId', 'name').sort({ createdAt: -1 });
      res.json(orders);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/orders/status', async (req, res) => {
    try {
      await Order.findByIdAndUpdate(req.body.orderId, { status: req.body.status });
      res.json({ message: "Status Updated!" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 7. DASHBOARD STATS ---

app.get('/api/admin/stats', async (req, res) => {
    try {
        const sellers = await User.countDocuments({ role: 'seller' });
        const suppliers = await User.countDocuments({ role: 'supplier' });
        const pending = await Withdrawal.countDocuments({ status: 'pending' });
        const totalPayouts = await Withdrawal.aggregate([{ $match: { status: 'approved' } }, { $group: { _id: null, total: { $sum: "$amount" } } }]);
        res.json({ sellers, suppliers, pending, payouts: totalPayouts[0]?.total || 0 });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/supplier/stats/:id', async (req, res) => {
    try {
        const products = await Product.countDocuments({ supplier: req.params.id });
        const user = await User.findById(req.params.id);
        const withdrawn = await Withdrawal.aggregate([
            { $match: { user: new mongoose.Types.ObjectId(req.params.id), status: 'approved' } },
            { $group: { _id: null, total: { $sum: "$amount" } } }
        ]);
        const pendingRequests = await Withdrawal.countDocuments({ user: req.params.id, status: 'pending' });
        res.json({ products, balance: user ? user.walletBalance : 0, withdrawn: withdrawn[0]?.total || 0, pendingRequests });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 8. SOCKET.IO LOGIC ---
io.on('connection', (socket) => {
  socket.on('join_room', (userId) => socket.join(userId));

  socket.on('send_message', async (data) => {
    const { senderId, receiverId, text, attachment } = data;
    if (text && (PHONE_REGEX.test(text) || EMAIL_REGEX.test(text))) {
        return io.to(senderId).emit('error_message', "⚠️ Security: Contact info sharing is blocked.");
    }
    try {
        let chat = await Chat.findOne({ participants: { $all: [senderId, receiverId] } });
        if (!chat) { chat = new Chat({ participants: [senderId, receiverId] }); await chat.save(); }
        chat.lastMessage = text || '📷 Photo Attachment';
        chat.lastMessageTime = Date.now();
        await chat.save();
        const newMessage = new Message({ chatId: chat._id, sender: senderId, text, attachment, status: 'delivered' });
        await newMessage.save();
        io.to(receiverId).emit('receive_message', newMessage);
        io.to(receiverId).emit('notification', { from: senderId, chatId: chat._id });
    } catch (e) { console.error(e); }
  });

  socket.on('mark_read', async (data) => {
    try {
        const { chatId, userId } = data; 
        await Message.updateMany({ chatId, sender: { $ne: userId }, status: { $ne: 'seen' } }, { $set: { status: 'seen' } });
        const chat = await Chat.findById(chatId);
        if(chat) {
            const otherUser = chat.participants.find(p => p.toString() !== userId);
            if(otherUser) io.to(otherUser.toString()).emit('messages_seen', { chatId });
        }
    } catch (e) { console.error(e); }
  });
});

const PORT = process.env.PORT || 80;
server.listen(PORT, () => console.log(`🚀 Operational on Port ${PORT}`));