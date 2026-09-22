const mongoose = require('mongoose');

const SessionSchema = new mongoose.Schema({
  sessionId: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  expiresAt: { type: Number, required: true, index: true },
}, {
  timestamps: true,
  versionKey: false,
});

module.exports = mongoose.models.Session || mongoose.model('Session', SessionSchema);
