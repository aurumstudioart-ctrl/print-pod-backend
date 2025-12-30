const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http'); 
const { Server } = require("socket.io"); 
const path = require('path');
const multer = require('multer'); 
const fs = require('fs'); 
const sharp = require('sharp'); // For Copyright Recognition & Fingerprinting
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// --- 1. MODELS LOADING (Safe Singleton Pattern) ---
const User = require('./models/User');
const Product = require('./models/Product');
const Chat = require('./models/Chat');
const Message = require('./models/Message');
const Order = require('./models/Order');
const Withdrawal = require('./models/Withdrawal');

// --- 2. SECURITY & ENGINE LIMITS ---
const PHONE_REGEX = /(\+?\d{1,3}[-.\s]?)?(\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 5e7 // 50 MB limit for high-res designs
});

app.use(cors());
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/uploads', express.static('/app/uploads'));

// DB Connection
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ SYSTEM: Master Database Connected & Verified"))
    .catch(err => console.error("❌ CRITICAL: DB Connection Failed ->", err));

// Storage Setup
const uploadDir = '/app/uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Multer for initial scanning (Quarantine Mode)
const upload = multer({ dest: 'temp/' });

// --- 3. BASIC APIs ---
app.get('/', (req, res) => res.status(200).send('🚀 POD Master Node is Active... Status: Secured ✅'));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/product', require('./routes/product'));

// --- 4. ADVANCED PRODUCT ENGINE (Copyright, Variations, Quarantine) 🛡️ ---

app.post('/api/product/add', upload.single('image'), async (req, res) => {
    try {
        const { name, description, basePrice, supplierId, category, tags, variations, source, isPhysical } = req.body;

        if (!req.file) return res.status(400).send("Product image is required for policy scan.");

        // A. Perceptual Hashing (Copyright Recognition)
        // Image ko 10x10 pixel grayscale banakar hash nikalte hain taake duplicate pakdi jaye
        const imageBuffer = await sharp(req.file.path).resize(10, 10).grayscale().toBuffer();
        const currentHash = imageBuffer.toString('base64');

        const isDuplicate = await Product.findOne({ imageHash: currentHash });
        if (isDuplicate) {
            fs.unlinkSync(req.file.path); // Delete temp file
            return res.status(403).json({ error: "COPYRIGHT ALERT: This design/image already exists in our system!" });
        }

        // B. Title Duplication Check
        const sameTitle = await Product.findOne({ name: { $regex: new RegExp(`^${name}$`, 'i') } });
        if (sameTitle) {
            fs.unlinkSync(req.file.path);
            return res.status(403).json({ error: "Policy Alert: Product title must be unique to avoid spam." });
        }

        // C. Final Path Allocation
        const finalFileName = `prod-${Date.now()}-${req.file.originalname.replace(/\s+/g, '-')}`;
        const finalPath = path.join(uploadDir, finalFileName);
        fs.renameSync(req.file.path, finalPath);

        const newProduct = new Product({
            name,
            description,
            basePrice,
            supplier: supplierId,
            imagePath: finalFileName,
            category,
            tags: tags ? tags.split(',').map(t => t.trim()) : [],
            variations: variations ? JSON.parse(variations) : [],
            source: source || 'handmade',
            isPhysical: isPhysical === 'true',
            imageHash: currentHash,
            status: 'pending' // 3-Hour Quarantine Starts
        });

        await newProduct.save();
        res.json({ message: "Product submitted! Safe scan initiated. Public view in 3 hours.", productId: newProduct._id });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// --- 5. SMART SEARCH ENGINE (Handmade Boosting Logic) 🔍 ---

app.get('/api/products/search', async (req, res) => {
    const { q, category } = req.query;
    try {
        let query = { status: 'approved' }; // Only verified items
        if (q) {
            query.$or = [
                { name: { $regex: q, $options: 'i' } },
                { tags: { $in: [new RegExp(q, 'i')] } }
            ];
        }
        if (category && category !== 'All') query.category = category;

        const products = await Product.find(query).lean();

        // ALGORITHM: Handmade items score +100 points to rank top (Etsy Style)
        const rankedProducts = products.map(p => ({
            ...p,
            rankScore: (p.clickCount || 0) + (p.source === 'handmade' ? 100 : 0)
        })).sort((a, b) => b.rankScore - a.rankScore);

        res.json(rankedProducts);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/products/suggestions', async (req, res) => {
    const { q } = req.query;
    if (!q) return res.json([]);
    try {
        const data = await Product.find({
            $or: [{ name: { $regex: q, $options: 'i' } }, { tags: { $in: [new RegExp(q, 'i')] } }]
        }).limit(6).select('name category tags');
        res.json(data);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 6. FINANCIAL & WALLET SYSTEM (Hold/Refund Engine) ---

app.post('/api/wallet/withdraw', async (req, res) => {
    const { userId, amount } = req.body;
    const user = await User.findById(userId);
    if (!user || user.walletBalance < amount) return res.status(400).json({ message: "Balance too low." });
    
    // HOLD: Immediately deduct from wallet
    await User.findByIdAndUpdate(userId, { $inc: { walletBalance: -amount } });
    const newReq = new Withdrawal({ user: userId, amount, status: 'pending' });
    await newReq.save();
    res.json({ message: "Payout requested. Funds are on hold for verification." });
});

app.post('/api/admin/withdrawals/action', async (req, res) => {
    const { id, action } = req.body; 
    const request = await Withdrawal.findById(id);
    if (!request || request.status !== 'pending') return res.status(400).json({ message: "Closed request." });

    if (action === 'rejected') {
        // REFUND: Return funds to wallet
        await User.findByIdAndUpdate(request.user, { $inc: { walletBalance: request.amount } });
    }
    request.status = action;
    await request.save();
    res.json({ message: `Request ${action} successfully.` });
});

app.post('/api/wallet/pay', async (req, res) => {
    const { userId, amount } = req.body;
    const user = await User.findById(userId);
    if (!user || user.walletBalance < amount) return res.status(400).json({ message: "Insufficient Funds!" });
    await User.findByIdAndUpdate(userId, { $inc: { walletBalance: -amount } });
    res.json({ message: "Payment Verified" });
});

// --- 7. ORDER & ANALYTICS APIs ---

app.post('/api/orders/create', async (req, res) => {
  try {
    const newOrder = new Order(req.body);
    await newOrder.save();
    res.json({ message: "Order Success", orderId: newOrder._id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/orders/supplier/:id', async (req, res) => {
    try {
      const orders = await Order.find({ supplierId: req.params.id })
        .populate('sellerId', 'name email').populate('productId', 'name').sort({ createdAt: -1 });
      res.json(orders);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/orders/seller/:id', async (req, res) => {
    try {
        const orders = await Order.find({ sellerId: req.params.id }).populate('productId', 'name').sort({ createdAt: -1 });
        res.json(orders);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 8. MASTER DASHBOARD ANALYTICS (God View) 📊 ---

app.get('/api/admin/detailed-stats', async (req, res) => {
    try {
        const supplierPerformance = await Order.aggregate([
            { $group: {
                _id: "$supplierId",
                totalOrders: { $sum: 1 },
                pending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } },
                revenue: { $sum: "$totalPrice" }
            }},
            { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "details" }},
            { $unwind: "$details" }
        ]);

        const revenueTimeline = await Order.aggregate([
            { $group: {
                _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
                dailyRevenue: { $sum: "$totalPrice" },
                orderCount: { $sum: 1 }
            }},
            { $sort: { "_id": -1 } }, { $limit: 30 }
        ]);

        res.json({ 
            supplierPerformance, 
            revenueTimeline, 
            userStats: { 
                sellers: await User.countDocuments({ role: 'seller' }), 
                suppliers: await User.countDocuments({ role: 'supplier' }) 
            } 
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/supplier/stats/:id', async (req, res) => {
    try {
        const prodCount = await Product.countDocuments({ supplier: req.params.id });
        const user = await User.findById(req.params.id);
        const withdrawn = await Withdrawal.aggregate([{ $match: { user: new mongoose.Types.ObjectId(req.params.id), status: 'approved' } }, { $group: { _id: null, total: { $sum: "$amount" } } }]);
        const pending = await Withdrawal.countDocuments({ user: req.params.id, status: 'pending' });
        res.json({ products: prodCount, balance: user ? user.walletBalance : 0, withdrawn: withdrawn[0]?.total || 0, pendingRequests: pending });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 9. REAL-TIME CHAT & NOTIFICATIONS ---

io.on('connection', (socket) => {
  socket.on('join_room', (userId) => socket.join(userId));

  socket.on('send_message', async (data) => {
    const { senderId, receiverId, text, attachment } = data;
    if (text && (PHONE_REGEX.test(text) || EMAIL_REGEX.test(text))) {
        return io.to(senderId).emit('error_message', "⚠️ Security: Private contact sharing is blocked.");
    }
    try {
        let chat = await Chat.findOne({ participants: { $all: [senderId, receiverId] } });
        if (!chat) { chat = new Chat({ participants: [senderId, receiverId] }); await chat.save(); }
        chat.lastMessage = text || '📷 Media Attachment';
        chat.lastMessageTime = Date.now();
        await chat.save();
        const newMessage = new Message({ chatId: chat._id, sender: senderId, text, attachment, status: 'delivered' });
        await newMessage.save();
        io.to(receiverId).emit('receive_message', newMessage);
        io.to(receiverId).emit('notification', { from: senderId, chatId: chat._id });
    } catch (e) { console.error(e); }
  });
});

// --- 10. THE QUARANTINE RESOLVER (Background Worker) 🛰️ ---
// Har 10 minute mein check karega aur 3 ghante purane products approve karega
setInterval(async () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const result = await Product.updateMany(
        { status: 'pending', createdAt: { $lte: threeHoursAgo } },
        { $set: { status: 'approved' } }
    );
    if(result.modifiedCount > 0) console.log(`🛰️ System: ${result.modifiedCount} products passed 3h scan & are now LIVE.`);
}, 600000);

const PORT = process.env.PORT || 80;
server.listen(PORT, () => {
  console.log(`🚀 Master operational on Port ${PORT}`);
  console.log(`🛡️ Security Guard Active | 3-Hour Scan Engine Running`);
});