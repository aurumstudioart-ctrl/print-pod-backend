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

// --- 1. MODELS LOADING (Top par load karna behtar hai) ---
const User = require('./models/User');
const Product = require('./models/Product');
const Chat = require('./models/Chat');
const Message = require('./models/Message');
const Order = require('./models/Order');
const Withdrawal = require('./models/Withdrawal');

// --- 2. SECURITY & LIMITS ---
const PHONE_REGEX = /(\+?\d{1,3}[-.\s]?)?(\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

// Socket.io Setup (Increased Buffer for heavy designs)
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 5e7 // 50 MB
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increased for Base64
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/uploads', express.static('/app/uploads'));

// DB Connection
const mongoURI = process.env.MONGO_URI;
mongoose.connect(mongoURI)
    .then(() => console.log("✅ MongoDB Connected Successfully"))
    .catch(err => console.error("❌ MongoDB Connection Error:", err));

// --- 3. UPLOAD SETUP ---
const uploadDir = '/app/uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const chatUploadStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir), 
  filename: (req, file, cb) => { 
    const cleanName = file.originalname.replace(/\s+/g, '-');
    cb(null, `chat-${Date.now()}-${cleanName}`); 
  }
});
const chatUpload = multer({ storage: chatUploadStorage });

// --- 4. API ROUTES ---

// Landing Route (Aapke "Cannot GET /" error ka hal)
app.get('/', (req, res) => {
    res.status(200).send('🚀 POD Marketplace API is running... Status: Healthy ✅');
});

app.use('/api/auth', require('./routes/auth'));
app.use('/api/product', require('./routes/product'));

// Chat Upload
app.post('/api/chat/upload', chatUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded");
  const fileUrl = `http://print-api.129.80.92.53.nip.io/uploads/${req.file.filename}`;
  res.json({ filePath: fileUrl });
});

// Conversations List
app.get('/api/chat/conversations/:userId', async (req, res) => {
  try {
    const chats = await Chat.find({ participants: req.params.userId })
      .populate('participants', 'name email role')
      .sort({ lastMessageTime: -1 });
    res.json(chats);
  } catch (err) { res.status(500).json({error: err.message}); }
});

// Messages in a Chat
app.get('/api/chat/messages/:chatId', async (req, res) => {
  try {
    const messages = await Message.find({ chatId: req.params.chatId }).sort({ createdAt: 1 });
    res.json(messages);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Unread Counter
app.get('/api/chat/unread/:userId', async (req, res) => {
    try {
      const chats = await Chat.find({ participants: req.params.userId });
      const chatIds = chats.map(c => c._id);
      const unreadMessages = await Message.find({ 
          chatId: { $in: chatIds }, 
          sender: { $ne: req.params.userId }, 
          status: { $ne: 'seen' } 
      });
      const unreadMap = {};
      let totalUnread = 0;
      unreadMessages.forEach(msg => {
          const cId = msg.chatId.toString();
          unreadMap[cId] = (unreadMap[cId] || 0) + 1;
          totalUnread++;
      });
      res.json({ total: totalUnread, perChat: unreadMap });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin User Search
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

// --- 5. FINANCIAL & ORDER SYSTEM ---

app.post('/api/wallet/pay', async (req, res) => {
    const { userId, amount } = req.body;
    try {
        const user = await User.findById(userId);
        if (!user || user.walletBalance < amount) return res.status(400).json({ message: "Insufficient Funds!" });
        await User.findByIdAndUpdate(userId, { $inc: { walletBalance: -amount } });
        res.json({ message: "Payment Verified" });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/orders/create', async (req, res) => {
  try {
    console.log("📦 Creating Order for Seller:", req.body.sellerId);
    const newOrder = new Order(req.body);
    await newOrder.save();
    res.json({ message: "Order Created!", orderId: newOrder._id });
  } catch (err) { 
    console.error("❌ Order Creation Failed:", err.message);
    res.status(500).json({ error: "Order failed to save in database." }); 
  }
});

// Admin/Supplier Stats (Combining for brevity)
app.get('/api/admin/stats', async (req, res) => {
    try {
        const totalSellers = await User.countDocuments({ role: 'seller' });
        const totalSuppliers = await User.countDocuments({ role: 'supplier' });
        const pendingWithdrawals = await Withdrawal.countDocuments({ status: 'pending' });
        const totalPayouts = await Withdrawal.aggregate([{ $match: { status: 'approved' } }, { $group: { _id: null, total: { $sum: "$amount" } } }]);
        res.json({ sellers: totalSellers, suppliers: totalSuppliers, pending: pendingWithdrawals, payouts: totalPayouts[0]?.total || 0 });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 6. SOCKET.IO LOGIC ---
io.on('connection', (socket) => {
  socket.on('join_room', (userId) => { 
      socket.join(userId); 
      console.log(`👤 User joined: ${userId}`);
  });

  socket.on('send_message', async (data) => {
    const { senderId, receiverId, text, attachment } = data;
    if (text && (PHONE_REGEX.test(text) || EMAIL_REGEX.test(text))) {
        return io.to(senderId).emit('error_message', "⚠️ SECURITY: Sharing contact info is prohibited.");
    }
    try {
        let chat = await Chat.findOne({ participants: { $all: [senderId, receiverId] } });
        if (!chat) {
            chat = new Chat({ participants: [senderId, receiverId] });
            await chat.save();
        }
        
        chat.lastMessage = text || (attachment?.type !== 'none' ? '📷 Sent a photo' : 'New Message');
        chat.lastMessageTime = Date.now();
        await chat.save();

        const newMessage = new Message({ chatId: chat._id, sender: senderId, text, attachment, status: 'delivered' });
        await newMessage.save();

        io.to(receiverId).emit('receive_message', newMessage);
        io.to(receiverId).emit('notification', { from: senderId, chatId: chat._id });
    } catch (err) { console.error("Socket Error:", err); }
  });

  socket.on('mark_read', async (data) => {
    try {
        const { chatId, userId } = data; 
        await Message.updateMany({ chatId: chatId, sender: { $ne: userId }, status: { $ne: 'seen' } }, { $set: { status: 'seen' } });
        const chat = await Chat.findById(chatId);
        if(chat) {
            const otherUser = chat.participants.find(p => p.toString() !== userId);
            if(otherUser) io.to(otherUser.toString()).emit('messages_seen', { chatId });
        }
    } catch (err) { console.error("Mark Read Error:", err); }
  });
});

const PORT = process.env.PORT || 80;
server.listen(PORT, () => {
  console.log(`🚀 Server fully operational on port ${PORT}`);
});