#!/usr/bin/env node
/**
 * Context War — Strategic Analyzer
 * Reads the current buffer state and provides strategic recommendations.
 * Identifies injection attempts, calculates position strength, suggests moves.
 */
const { ethers } = require('ethers');

const RPC = process.env.CONTEXT_WAR_RPC || process.env.BASE_RPC_URL || 'https://base-mainnet.public.blastapi.io';
const CONTRACT = process.env.CONTEXT_WAR_CONTRACT || '0x65688010c11Cbad24C83451407aFEa44eF71687e';
const PRIVATE_KEY = process.env.CONTEXT_WAR_KEY || process.env.DEPLOYER_PRIVATE_KEY;

const ABI = [
  'function getRoundInfo() view returns (uint256 id, uint256 startTime, uint256 endTime, uint256 prizePool, bool resolved, bool active)',
  'function getBufferAsText() view returns (string)',
  'function getSlot(uint256) view returns (string word, address owner, uint256 highestTotal)',
  'function getRoundPlayers(uint256) view returns (address[])',
  'function totalSpent(uint256, address) view returns (uint256)',
];

const provider = new ethers.JsonRpcProvider(RPC);
const contract = new ethers.Contract(CONTRACT, ABI, provider);
const myAddress = PRIVATE_KEY ? new ethers.Wallet(PRIVATE_KEY).address.toLowerCase() : null;

// Common injection patterns
const INJECTION_WORDS = ['ignore', 'disregard', 'forget', 'override', 'instead', 'actually', 'correction'];
const REDIRECT_WORDS = ['send', 'transfer', 'give', 'pay', 'distribute'];

(async () => {
  const info = await contract.getRoundInfo();
  const buffer = await contract.getBufferAsText();
  const now = Math.floor(Date.now() / 1000);

  console.log('═══════════════════════════════════════');
  console.log('  🧠 Context War — Strategic Analysis');
  console.log('═══════════════════════════════════════');
  console.log();

  if (!info.active && info.id === 0n) {
    console.log('No active round.');
    return;
  }

  const prizeUSDC = parseFloat(ethers.formatUnits(info.prizePool, 6));
  const remaining = info.active ? Number(info.endTime) - now : 0;

  // Gather slot data
  const slots = [];
  const playerMap = new Map(); // address → {slots, totalBid, words}
  let emptyCt = 0;

  for (let i = 0; i < 12; i++) {
    const s = await contract.getSlot(i);
    const empty = s.owner === '0x0000000000000000000000000000000000000000';
    slots.push({ idx: i, word: s.word, owner: s.owner.toLowerCase(), bid: s.highestTotal, empty });
    
    if (!empty) {
      const key = s.owner.toLowerCase();
      const prev = playerMap.get(key) || { slots: [], totalBid: 0n, words: [] };
      prev.slots.push(i);
      prev.totalBid += s.highestTotal;
      prev.words.push(s.word);
      playerMap.set(key, prev);
    } else {
      emptyCt++;
    }
  }

  // Buffer analysis
  console.log('📝 Buffer:', `"${buffer}"`);
  console.log(`💰 Prize: $${prizeUSDC.toFixed(2)} USDC`);
  if (remaining > 0) console.log(`⏱  Time: ${Math.floor(remaining / 60)}m ${remaining % 60}s`);
  console.log();

  // Detect injection attempts
  const injectionSlots = slots.filter(s => 
    INJECTION_WORDS.some(w => s.word.toLowerCase().includes(w))
  );
  const redirectSlots = slots.filter(s =>
    REDIRECT_WORDS.some(w => s.word.toLowerCase().includes(w))
  );
  const addressSlots = slots.filter(s => s.word.match(/^0x[a-fA-F0-9]{8,}/));

  if (injectionSlots.length > 0) {
    console.log('🚨 INJECTION DETECTED:');
    injectionSlots.forEach(s => {
      console.log(`   Slot ${s.idx}: "${s.word}" by ${s.owner.slice(0, 10)}...`);
    });
    console.log();
  }

  if (addressSlots.length > 0) {
    console.log('📍 ADDRESS INJECTION:');
    addressSlots.forEach(s => {
      console.log(`   Slot ${s.idx}: "${s.word}" — targeting this address for payout`);
    });
    console.log();
  }

  // Player analysis
  console.log('👥 Player Positions:');
  for (const [addr, data] of playerMap) {
    const isMe = myAddress && addr === myAddress;
    const tag = isMe ? ' ← YOU' : '';
    const bidUSD = parseFloat(ethers.formatUnits(data.totalBid, 6));
    const phrase = data.words.join(' ');
    console.log(`  ${addr.slice(0, 10)}... | ${data.slots.length} slots | $${bidUSD.toFixed(2)} bid${tag}`);
    console.log(`    Phrase: "${phrase}"`);
    console.log(`    ROI: ${((prizeUSDC / bidUSD - 1) * 100).toFixed(0)}% potential (if winner-takes-all)`);
  }
  if (emptyCt > 0) {
    console.log(`  💨 ${emptyCt} empty slots available (0.25 USDC each)`);
  }
  console.log();

  // Strategic recommendations
  console.log('🎯 Recommendations:');
  
  if (injectionSlots.length > 0 && myAddress) {
    const myData = playerMap.get(myAddress);
    if (myData) {
      // Check if injection targets me or opponents
      const injectorAddrs = new Set(injectionSlots.map(s => s.owner));
      const targeting_me = !injectorAddrs.has(myAddress);
      
      if (targeting_me) {
        console.log('  ⚠️  Opponent is running prompt injection against your instruction');
        // Find cheapest injection slot to counter
        const cheapest = injectionSlots.sort((a, b) => Number(a.bid - b.bid))[0];
        const counterCost = parseFloat(ethers.formatUnits(cheapest.bid, 6)) + 0.25;
        console.log(`  → Counter: overwrite slot ${cheapest.idx} ("${cheapest.word}") for ~$${counterCost.toFixed(2)}`);
        console.log(`  → Replace with "." to break sentence, or a word that continues YOUR instruction`);
      }
    }
  }

  if (emptyCt > 0) {
    const emptySlots = slots.filter(s => s.empty).map(s => s.idx);
    console.log(`  💡 Claim empty slots [${emptySlots.join(', ')}] for $0.25 each — extend your instruction`);
  }

  // Spending efficiency
  if (myAddress && playerMap.has(myAddress)) {
    const mySpend = parseFloat(ethers.formatUnits(playerMap.get(myAddress).totalBid, 6));
    const ratio = mySpend / prizeUSDC;
    if (ratio > 0.5) {
      console.log(`  ⚠️  You've spent ${(ratio * 100).toFixed(0)}% of the prize pool — diminishing returns`);
    }
    if (ratio < 0.1 && remaining > 300) {
      console.log(`  🔥 Low investment — good position if others escalate. Consider claiming more slots.`);
    }
  }

  // Timing
  if (remaining > 0 && remaining < 300) {
    console.log('  ⚡ FINAL 5 MINUTES — last chance for counter-bids');
  } else if (remaining > 1800) {
    console.log('  🕐 Plenty of time — no rush. Let opponents reveal their strategy first.');
  }

  console.log();
})().catch(e => {
  console.error('Error:', e.shortMessage || e.message);
  process.exit(1);
});
