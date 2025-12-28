const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const JWT_SECRET = process.env.JWT_SECRET || "supersecretkey123";

// 1. REGISTER
router.post('/register', async (req, res) => {
    try {
        console.log("📝 Register Request Received:", req.body); // Request aayi ya nahi?

        const { name, email, password, role } = req.body;

        // Check user existence
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            console.log("⚠️ User already exists");
            return res.status(400).json({ message: "User already exists" });
        }

        // Hash Password
        console.log("🔐 Hashing password...");
        const hashedPassword = await bcrypt.hash(password, 10);

        // Create User
        console.log("👤 Creating new user...");
        const newUser = new User({
            name,
            email,
            password: hashedPassword,
            role: role || 'seller'
        });

        await newUser.save();
        console.log("✅ User Saved Successfully!");
        
        res.status(201).json({ message: "User created successfully!" });

    } catch (err) {
        console.error("❌ SERVER ERROR (Register):", err); // <--- YE WALI LINE ERROR DIKHAYEGI
        res.status(500).json({ error: err.message });
    }
});

// 2. LOGIN
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        console.log("🔑 Login Request:", email);

        const user = await User.findOne({ email });
        if (!user) return res.status(400).json({ message: "User not found" });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ message: "Invalid credentials" });

        const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '1d' });

        res.json({ token, user: { id: user._id, name: user.name, role: user.role } });

    } catch (err) {
        console.error("❌ SERVER ERROR (Login):", err);
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;