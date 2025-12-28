const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

// Secret Key for Tokens (Baad mein environment variable mein dalenge)
const JWT_SECRET = process.env.JWT_SECRET || "supersecretkey123";

// 1. REGISTER (Naya User Banana)
router.post('/register', async (req, res) => {
    try {
        const { name, email, password, role } = req.body;

        // Check agar user pehle se hai
        const existingUser = await User.findOne({ email });
        if (existingUser) return res.status(400).json({ message: "User already exists" });

        // Password ko encrypt (hash) karein
        const hashedPassword = await bcrypt.hash(password, 10);

        // Naya user banayein
        const newUser = new User({
            name,
            email,
            password: hashedPassword,
            role: role || 'seller' // Agar role nahi bataya to auto 'seller' banega
        });

        await newUser.save();
        res.status(201).json({ message: "User created successfully!" });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. LOGIN (User ko andar aane dena)
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        // User dhoondhein
        const user = await User.findOne({ email });
        if (!user) return res.status(400).json({ message: "User not found" });

        // Password check karein
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ message: "Invalid credentials" });

        // Token banayein (Ye user ka 'Pass' hai)
        const token = jwt.sign({ id: user._id, role: user.role }, JWT_SECRET, { expiresIn: '1d' });

        res.json({ token, user: { id: user._id, name: user.name, role: user.role } });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;