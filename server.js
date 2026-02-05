/**
 * Context War — Express server
 * Serves frontend + REST API for agents + proxies contract reads
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const path = require('path');
const { ethers } = require('ethers');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'frontend')));

// ─── Contract Setup ────────────────────────────────────
const CONTRACT = '0xB6d292664d3073dca1475d2dd2679eD839C288c0';
const USDC_ADDR = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_RPC = process.env.BASE_RPC_URL || 'https://mainnet.base.org';

const ABI = [
  'function getRoundInfo() view returns (uint256 id, uint256 createdAt, uint256 startedAt, uint256 endTime, uint256 prizePool, uint256 ethPrizePool, bool resolved, bool pending, bool active)',
  'function getBufferAsText() view returns (string)',
  'function getBuffer() view returns (string[12])',
  'function getSlot(uint256) view returns (string word, address owner, uint256 highestTotal)',
  'function getSlotOwners() view returns (address[12])',
  'function getRoundPlayers(uint256) view returns (address[])',
  'function totalSpent(uint256, address) view returns (uint256)',
  'function cumulativeBids(uint256, uint256, address) view returns (uint256)',
  'function playerSlotCount(uint256, address) view returns (uint256)',
  'function nextPrizePool() view returns (uint256)',
  'function minBid() view returns (uint256)',
  'function splitBps() view returns (uint256)',
  'function maxSlotsPerPlayer() view returns (uint256)',
  'function pendingEth() view returns (uint256)',
  'function bid(uint256, string, uint256)',
  'function startRound(uint256)',
  'function fund(uint256)',
];

const USDC_ABI = [
  'function approve(address, uint256) returns (bool)',
  'function allowance(address, address) view returns (uint256)',
];

const provider = new ethers.JsonRpcProvider(BASE_RPC);
const contract = new ethers.Contract(CONTRACT, ABI, provider);

// Wallet for server-side bids (agent API)
const wallet = process.env.DEPLOYER_PRIVATE_KEY 
  ? new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider)
  : null;
const walletContract = wallet ? new ethers.Contract(CONTRACT, ABI, wallet) : null;

function fmt(val) {
  return (Number(val) / 1e6).toFixed(2);
}

function serializeBigInts(obj) {
  if (typeof obj === 'bigint') return obj.toString();
  if (Array.isArray(obj)) return obj.map(serializeBigInts);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = serializeBigInts(v);
    return out;
  }
  return obj;
}

// ─── API Routes ────────────────────────────────────────

// GET /api/status — round info + buffer (agent-friendly)
app.get('/api/status', async (req, res) => {
  try {
    const info = await contract.getRoundInfo();
    const bufferText = await contract.getBufferAsText();
    const buffer = await contract.getBuffer();
    const nextPool = await contract.nextPrizePool();
    const minBidVal = await contract.minBid();
    const splitVal = await contract.splitBps();
    const slotCap = await contract.maxSlotsPerPlayer();
    const pendEth = await contract.pendingEth();
    
    // Slot data
    const slots = [];
    for (let i = 0; i < 12; i++) {
      const s = await contract.getSlot(i);
      slots.push({
        word: s.word,
        owner: s.owner,
        highestTotal: s.highestTotal.toString(),
      });
    }

    let players = [];
    let playerDetails = [];
    if (info.id > 0n) {
      players = await contract.getRoundPlayers(info.id);
      for (const p of players) {
        const spent = await contract.totalSpent(info.id, p);
        const slotCount = await contract.playerSlotCount(info.id, p);
        playerDetails.push({
          address: p,
          totalSpent: spent.toString(),
          totalSpentFormatted: fmt(spent),
          slotsOwned: slotCount.toString(),
        });
      }
    }

    const now = Math.floor(Date.now() / 1000);
    let remainingSeconds = 0;
    if (info.active && info.endTime > 0n) {
      remainingSeconds = Math.max(0, Number(info.endTime) - now);
    }

    res.json({
      contract: CONTRACT,
      chain: 'base',
      version: 'v4',
      slots,
      round: {
        id: info.id.toString(),
        createdAt: info.createdAt.toString(),
        startedAt: info.startedAt.toString(),
        endTime: info.endTime.toString(),
        prizePool: info.prizePool.toString(),
        prizeFormatted: fmt(info.prizePool),
        ethPrizePool: info.ethPrizePool.toString(),
        ethPrizeFormatted: ethers.formatEther(info.ethPrizePool),
        resolved: info.resolved,
        pending: info.pending,
        active: info.active,
        remainingSeconds,
      },
      bufferText,
      buffer: buffer.map(String),
      players: playerDetails,
      nextPrizePool: nextPool.toString(),
      nextPrizeFormatted: fmt(nextPool),
      pendingEth: pendEth.toString(),
      minBid: minBidVal.toString(),
      minBidFormatted: fmt(minBidVal),
      splitBps: splitVal.toString(),
      maxSlotsPerPlayer: slotCap.toString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/slots — all 12 slots with details
app.get('/api/slots', async (req, res) => {
  try {
    const info = await contract.getRoundInfo();
    const slots = [];
    for (let i = 0; i < 12; i++) {
      const s = await contract.getSlot(i);
      slots.push({
        index: i,
        word: s.word,
        owner: s.owner,
        highestTotal: s.highestTotal.toString(),
        highestFormatted: fmt(s.highestTotal),
      });
    }
    res.json({ roundId: info.id.toString(), slots });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/slot/:index — single slot detail
app.get('/api/slot/:index', async (req, res) => {
  try {
    const i = parseInt(req.params.index);
    if (i < 0 || i >= 12) return res.status(400).json({ error: 'Invalid slot index (0-11)' });
    const s = await contract.getSlot(i);
    const info = await contract.getRoundInfo();
    
    // Get all bidders for this slot (from player list)
    let bidders = [];
    if (info.id > 0n) {
      const players = await contract.getRoundPlayers(info.id);
      for (const p of players) {
        const bid = await contract.cumulativeBids(info.id, i, p);
        if (bid > 0n) {
          bidders.push({ address: p, cumulative: bid.toString(), formatted: fmt(bid) });
        }
      }
      bidders.sort((a, b) => BigInt(b.cumulative) > BigInt(a.cumulative) ? 1 : -1);
    }
    
    res.json({
      index: i,
      word: s.word,
      owner: s.owner,
      highestTotal: s.highestTotal.toString(),
      highestFormatted: fmt(s.highestTotal),
      bidders,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/bid — place a bid (requires server wallet or signed tx)
// For agent use: server-side bid using the oracle wallet
// Body: { slot: 0, word: "send", amount: "0.25", wallet_key?: "0x..." }
app.post('/api/bid', async (req, res) => {
  try {
    const { slot, word, amount, wallet_key } = req.body;
    
    if (slot === undefined || !word || !amount) {
      return res.status(400).json({ error: 'Required: slot (0-11), word (string), amount (USDC string)' });
    }
    
    const slotIndex = parseInt(slot);
    if (slotIndex < 0 || slotIndex >= 12) return res.status(400).json({ error: 'Invalid slot (0-11)' });
    if (word.includes(' ')) return res.status(400).json({ error: 'No spaces allowed' });
    if (word.length > 22) return res.status(400).json({ error: 'Word too long (max 22 chars)' });
    if (word.length === 0) return res.status(400).json({ error: 'Word cannot be empty' });
    
    const amountParsed = ethers.parseUnits(String(amount), 6);
    
    // Use provided wallet key or fall back to server wallet
    let bidWallet, bidContract;
    if (wallet_key) {
      bidWallet = new ethers.Wallet(wallet_key, provider);
      bidContract = new ethers.Contract(CONTRACT, ABI, bidWallet);
    } else if (walletContract) {
      bidWallet = wallet;
      bidContract = walletContract;
    } else {
      return res.status(400).json({ error: 'No wallet available. Provide wallet_key or configure server wallet.' });
    }
    
    // Check USDC allowance
    const usdc = new ethers.Contract(USDC_ADDR, USDC_ABI, bidWallet);
    const allowance = await usdc.allowance(bidWallet.address, CONTRACT);
    if (allowance < amountParsed) {
      const appTx = await usdc.approve(CONTRACT, ethers.MaxUint256);
      await appTx.wait();
    }
    
    const tx = await bidContract.bid(slotIndex, word, amountParsed);
    const receipt = await tx.wait();
    
    res.json({
      success: true,
      tx: tx.hash,
      block: receipt.blockNumber,
      slot: slotIndex,
      word,
      amount: amount,
      bidder: bidWallet.address,
    });
  } catch (e) {
    res.status(500).json({ error: e.reason || e.message });
  }
});

// POST /api/start-round — start a new round
// Body: { duration: 3600, topUp: "0" }
app.post('/api/start-round', async (req, res) => {
  try {
    const { topUp, wallet_key } = req.body;
    const topUpAmount = ethers.parseUnits(String(topUp || '0'), 6);
    
    let startWallet, startContract;
    if (wallet_key) {
      startWallet = new ethers.Wallet(wallet_key, provider);
      startContract = new ethers.Contract(CONTRACT, ABI, startWallet);
    } else if (walletContract) {
      startWallet = wallet;
      startContract = walletContract;
    } else {
      return res.status(400).json({ error: 'No wallet available.' });
    }
    
    if (topUpAmount > 0n) {
      const usdc = new ethers.Contract(USDC_ADDR, USDC_ABI, startWallet);
      const allowance = await usdc.allowance(startWallet.address, CONTRACT);
      if (allowance < topUpAmount) {
        const appTx = await usdc.approve(CONTRACT, ethers.MaxUint256);
        await appTx.wait();
      }
    }
    
    const tx = await startContract.startRound(topUpAmount);
    const receipt = await tx.wait();
    
    res.json({
      success: true,
      tx: tx.hash,
      block: receipt.blockNumber,
      topUp: topUp || '0',
    });
  } catch (e) {
    res.status(500).json({ error: e.reason || e.message });
  }
});

// POST /api/fund — add USDC to current round's prize pool
app.post('/api/fund', async (req, res) => {
  try {
    const { amount, wallet_key } = req.body;
    if (!amount) return res.status(400).json({ error: 'Required: amount (USDC string)' });

    const amountParsed = ethers.parseUnits(String(amount), 6);

    let fundWallet, fundContract;
    if (wallet_key) {
      fundWallet = new ethers.Wallet(wallet_key, provider);
      fundContract = new ethers.Contract(CONTRACT, ABI, fundWallet);
    } else if (walletContract) {
      fundWallet = wallet;
      fundContract = walletContract;
    } else {
      return res.status(400).json({ error: 'No wallet available.' });
    }

    const usdc = new ethers.Contract(USDC_ADDR, USDC_ABI, fundWallet);
    const allowance = await usdc.allowance(fundWallet.address, CONTRACT);
    if (allowance < amountParsed) {
      const appTx = await usdc.approve(CONTRACT, ethers.MaxUint256);
      await appTx.wait();
    }

    const tx = await fundContract.fund(amountParsed);
    const receipt = await tx.wait();

    res.json({
      success: true,
      tx: tx.hash,
      block: receipt.blockNumber,
      amount,
      funder: fundWallet.address,
    });
  } catch (e) {
    res.status(500).json({ error: e.reason || e.message });
  }
});

// GET /api/oracle-prompt — get the current oracle prompt (for transparency)
app.get('/api/oracle-prompt', async (req, res) => {
  try {
    const info = await contract.getRoundInfo();
    if (info.id === 0n) return res.json({ prompt: null, message: 'No rounds yet' });
    
    const bufferText = await contract.getBufferAsText();
    const players = await contract.getRoundPlayers(info.id);
    
    const slotDetails = [];
    for (let i = 0; i < 12; i++) {
      const s = await contract.getSlot(i);
      slotDetails.push({
        slot: i,
        word: s.word || '[empty]',
        owner: s.owner,
        bid: fmt(s.highestTotal),
      });
    }
    
    const playerDetails = [];
    for (const p of players) {
      const spent = await contract.totalSpent(info.id, p);
      playerDetails.push({ address: p, spent: fmt(spent) });
    }
    
    res.json({
      roundId: info.id.toString(),
      active: info.active,
      resolved: info.resolved,
      bufferText,
      prizePool: fmt(info.prizePool),
      slots: slotDetails,
      players: playerDetails,
      preamble: `You are the Context War Oracle. Your one job: distribute a ${fmt(info.prizePool)} USDC prize pool based on this 12-word instruction written by competing AI agents: "${bufferText}"`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Catch-all: serve frontend
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend', 'index.html'));
});

// ─── Start ─────────────────────────────────────────────
const PORT = process.env.PORT || 3008;
app.listen(PORT, () => {
  console.log(`⚔️  Context War server running on port ${PORT}`);
  console.log(`   Contract: ${CONTRACT}`);
  console.log(`   API: http://localhost:${PORT}/api/status`);
  console.log(`   Frontend: http://localhost:${PORT}`);
  if (wallet) console.log(`   Server wallet: ${wallet.address}`);
});
