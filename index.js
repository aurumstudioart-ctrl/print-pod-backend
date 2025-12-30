const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http'); 
const { Server } = require("socket.io"); 
const path = require('path');
const multer = require('multer'); 
const fs = require('fs'); 
const sharp = require('sharp'); // Copyright & Fingerprinting
require('dotenv').config();

const app = express();
const server = http.createServer(app);

// --- 1. CONFIGURATION & MIDDLEWARE ---
const PHONE_REGEX = /(\+?\d{1,3}[-.\s]?)?(\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}/;
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  maxHttpBufferSize: 5e7 // 50 MB
});

app.use(cors());
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/uploads', express.static('/app/uploads'));

// DB Connection
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ SYSTEM: Master Database Connected & Verified"))
    .catch(err => console.error("❌ DB ERROR:", err));

// --- 2. MODELS LOADING ---
// NOTE: Ensure your models/Product.js schema includes:
// { views24h: [{ type: Date }], salesCount: { type: Number, default: 0 } }

const User = require('./models/User');
const Product = require('./models/Product');
const Chat = require('./models/Chat');
const Message = require('./models/Message');
const Order = require('./models/Order');
const Withdrawal = require('./models/Withdrawal');

// NEW: Review Model (Inline Definition)
const reviewSchema = new mongoose.Schema({
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rating: { type: Number, min: 1, max: 5 },
    comment: String,
    createdAt: { type: Date, default: Date.now }
});
const Review = mongoose.models.Review || mongoose.model('Review', reviewSchema);

// --- 3. STORAGE ENGINE (Hybrid) ---
const uploadDir = '/app/uploads';
const tempDir = 'temp/';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

const upload = multer({ dest: tempDir }); // Initial upload to temp
const chatUpload = multer({ 
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadDir),
        filename: (req, file, cb) => cb(null, `chat-${Date.now()}-${file.originalname.replace(/\s+/g, '-')}`)
    }) 
});

// --- 4. CORE APIs ---
app.get('/', (req, res) => res.status(200).send('🚀 POD Master Node Active | Security: High | Algorithm: V2.0'));
app.use('/api/auth', require('./routes/auth'));

// --- 5. PRODUCT ENGINE (Security + Upload) ---

app.post('/api/product/add', upload.single('image'), async (req, res) => {
    try {
        const { name, description, basePrice, supplierId, category, tags, variations, source, isPhysical } = req.body;

        if (!req.file) return res.status(400).send("Product image is required.");

        // A. Copyright Scan (Sharp)
        const imageBuffer = await sharp(req.file.path).resize(10, 10).grayscale().toBuffer();
        const currentHash = imageBuffer.toString('base64');

        const isDuplicateImage = await Product.findOne({ imageHash: currentHash });
        if (isDuplicateImage) {
            fs.unlinkSync(req.file.path);
            return res.status(403).json({ error: "COPYRIGHT ALERT: Design already exists!" });
        }

        // B. Title Check
        const isDuplicateTitle = await Product.findOne({ name: { $regex: new RegExp(`^${name}$`, 'i') } });
        if (isDuplicateTitle) {
            fs.unlinkSync(req.file.path);
            return res.status(403).json({ error: "Policy Alert: Product title must be unique." });
        }

        // C. Final Save
        const finalFileName = `prod-${Date.now()}-${req.file.originalname.replace(/\s+/g, '-')}`;
        const finalPath = path.join(uploadDir, finalFileName);
        fs.renameSync(req.file.path, finalPath);

        const newProduct = new Product({
            name, description, basePrice, category,
            supplier: supplierId,
            imagePath: finalFileName,
            tags: tags ? tags.split(',').map(t => t.trim()) : [],
            variations: variations ? JSON.parse(variations) : [],
            source: source || 'handmade',
            isPhysical: isPhysical === 'true',
            imageHash: currentHash,
            status: 'pending', // Quarantine
            salesCount: 0,
            views24h: []
        });

        await newProduct.save();
        res.json({ message: "Product submitted! Under 3-hour safety scan.", productId: newProduct._id });

    } catch (err) {
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: err.message });
    }
});

// --- 6. SMART ALGORITHM APIs (Tracking, Ranking, Reviews) 🚀 ---

// A. Track Live Visit (Algorithm Food)
app.post('/api/products/track-visit', async (req, res) => {
    const { productId } = req.body;
    try {
        // 24h window logic: Remove old timestamps and add new one
        const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
        await Product.findByIdAndUpdate(productId, {
            $push: { views24h: new Date() },
            $pull: { views24h: { $lt: yesterday } }
        });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// B. Smart Ranking & Live Tags API (Updated)
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

        // Fetch products
        const products = await Product.find(query).populate('supplier', 'name').lean();
        const now = Date.now();

        // SCORING ENGINE
        const results = products.map(p => {
            // Calculate recent views (last 24 hours)
            const recentViews = (p.views24h || []).filter(v => new Date(v) > (now - 86400000)).length;
            const sales = p.salesCount || 0;
            
            // Formula: Views worth 2 points, Sales worth 10, Handmade boost 50
            const score = (recentViews * 2) + (sales * 10) + (p.source === 'handmade' ? 50 : 0);

            // Live Badges Decision Logic
            let badge = null;
            if (sales > 20) {
                badge = { text: "Best Seller", color: "bg-amber-500", icon: "🏆" };
            } else if (recentViews > 15) {
                badge = { text: "Hot Choice", color: "bg-orange-600", icon: "🔥" };
            } else if (p.source === 'handmade') {
                badge = { text: "Handmade", color: "bg-emerald-600", icon: "🌿" };
            }

            return { 
                ...p, 
                recentViews, 
                score, 
                liveBadge: badge 
            };
        });

        // Sort by Score (High to Low)
        results.sort((a, b) => b.score - a.score);

        // SEO: Boost search count for top result if query exists
        if (q && products.length > 0) {
            await Product.findByIdAndUpdate(products[0]._id, { $inc: { searchCount: 1 } });
        }

        res.json(results);
    } catch (err) { res.status(500).send(err.message); }
});

// C. Reviews API
app.post('/api/products/review', async (req, res) => {
    try {
        const { productId, userId, rating, comment } = req.body;
        const newReview = new Review({ productId, userId, rating, comment });
        await newReview.save();
        res.json({ message: "Review posted", review: newReview });
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/api/products/reviews/:id', async (req, res) => {
    try {
        const reviews = await Review.find({ productId: req.params.id }).populate('userId', 'name').sort({ createdAt: -1 });
        res.json(reviews);
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/api/products/suggestions', async (req, res) => {
    const { q } = req.query;
    if (!q) return res.json([]);
    try {
        const suggestions = await Product.find({
            $or: [{ name: { $regex: q, $options: 'i' } }, { tags: { $in: [new RegExp(q, 'i')] } }]
        }).limit(6).select('name category tags');
        res.json(suggestions);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 7. CHAT & FINANCIAL SYSTEMS ---

app.post('/api/chat/upload', chatUpload.single('file'), (req, res) => {
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

app.post('/api/wallet/withdraw', async (req, res) => {
    const { userId, amount } = req.body;
    const user = await User.findById(userId);
    if (!user || user.walletBalance < amount) return res.status(400).json({ message: "Insufficient Funds" });
    
    // Hold Funds
    await User.findByIdAndUpdate(userId, { $inc: { walletBalance: -amount } });
    const newReq = new Withdrawal({ user: userId, amount, status: 'pending' });
    await newReq.save();
    res.json({ message: "Withdrawal placed. Funds locked for processing." });
});

app.post('/api/admin/withdrawals/action', async (req, res) => {
    const { id, action } = req.body; 
    const request = await Withdrawal.findById(id);
    if (!request || request.status !== 'pending') return res.status(400).json({ message: "Invalid Request" });

    if (action === 'rejected') {
        // Refund User
        await User.findByIdAndUpdate(request.user, { $inc: { walletBalance: request.amount } });
    }
    request.status = action;
    await request.save();
    res.json({ message: `Status updated to ${action}` });
});

// --- 8. ORDER SYSTEM (With Sales Counter Update) ---

app.post('/api/orders/create', async (req, res) => {
  try {
    const { productId } = req.body;
    const newOrder = new Order(req.body);
    await newOrder.save();

    // UPDATE: Increment Sales Count for Algorithm
    if(productId) {
        await Product.findByIdAndUpdate(productId, { $inc: { salesCount: 1 } });
    }

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

// --- 9. ANALYTICS ---

app.get('/api/admin/detailed-stats', async (req, res) => {
    try {
        const stats = {
            sellers: await User.countDocuments({ role: 'seller' }),
            suppliers: await User.countDocuments({ role: 'supplier' }),
            pendingPayouts: await Withdrawal.countDocuments({ status: 'pending' }),
            totalRevenue: await Order.aggregate([{ $group: { _id: null, total: { $sum: "$totalPrice" } } }])
        };
        res.json({ stats });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- 10. SOCKET.IO (Secure) ---

io.on('connection', (socket) => {
  socket.on('join_room', (userId) => socket.join(userId));

  socket.on('send_message', async (data) => {
    const { senderId, receiverId, text, attachment } = data;
    
    // Safety Filter
    if (text && (PHONE_REGEX.test(text) || EMAIL_REGEX.test(text))) {
        return io.to(senderId).emit('error_message', "⚠️ Blocked: Contact sharing is not allowed.");
    }

    try {
        let chat = await Chat.findOne({ participants: { $all: [senderId, receiverId] } });
        if (!chat) { chat = new Chat({ participants: [senderId, receiverId] }); await chat.save(); }
        
        chat.lastMessage = text || '📷 Media';
        chat.lastMessageTime = Date.now();
        await chat.save();

        const newMessage = new Message({ chatId: chat._id, sender: senderId, text, attachment, status: 'delivered' });
        await newMessage.save();

        io.to(receiverId).emit('receive_message', newMessage);
        io.to(receiverId).emit('notification', { from: senderId, chatId: chat._id });
    } catch (e) { console.error(e); }
  });
});

// --- 11. WORKER (Quarantine & Cleanups) ---
setInterval(async () => {
    // Approve products older than 3 hours
    const cutoff = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await Product.updateMany(
        { status: 'pending', createdAt: { $lte: cutoff } },
        { $set: { status: 'approved' } }
    );
}, 600000);

const PORT = process.env.PORT || 80;
server.listen(PORT, () => {
  console.log(`\n🚀 Master Node V2 Operational on Port ${PORT}`);
  console.log(`✅ Algorithm: Smart Ranking Active (Views+Sales)`);
  console.log(`✅ Modules: Reviews, Badges, Chat, Wallet`);
});