#!/usr/bin/env node
/**
 * Context War notification script
 * Called by server webhook to inject events into Nox's session
 * Usage: node notify.js "event message"
 */

const fs = require('fs');
const path = require('path');

const message = process.argv[2];
if (!message) {
  console.error('Usage: node notify.js "message"');
  process.exit(1);
}

// Write to a notification file that can be picked up by heartbeat
const notifyFile = path.join(__dirname, 'notifications.jsonl');
const notification = {
  timestamp: Date.now(),
  message: message,
  read: false
};

fs.appendFileSync(notifyFile, JSON.stringify(notification) + '\n');
console.log('Notification queued:', message);
