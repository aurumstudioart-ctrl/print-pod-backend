const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path'); // <--- New
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// --- STATIC IMAGES (Images dikhane ke liye) ---
// Jab koi '/uploads/abc.png' mangega, to hum '/app/uploads' folder se denge
app.use('/uploads', express.static('/app/uploads'));

// Database Connection
const mongoURI = process.env.MONGO_URI;
if (!mongoURI) {
    console.error("❌ ERROR: MONGO_URI is not defined in CapRover!");
} else {
    mongoose.connect(mongoURI)
        .then(() => console.log("✅ MongoDB Connected Successfully"))
        .catch(err => console.error("❌ MongoDB Connection Error:", err));
}

// Routes Import
const authRoutes = require('./routes/auth');
const productRoutes = require('./routes/product'); // <--- New

// Routes Use
app.use('/api/auth', authRoutes);
app.use('/api/product', productRoutes); // <--- New

// Basic Route
app.get('/', (req, res) => {
  res.send('POD Marketplace Backend is Live & Connected to DB! 🚀');
});

// Import Models
require('./models/User');
require('./models/Product');
require('./models/Design');

// Server Start
const PORT = process.env.PORT || 80;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});